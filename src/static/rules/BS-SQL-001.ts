/**
 * BS-SQL-001 — SQL injection via request-derived interpolation
 *
 * Flags `sql\`…\`` / `db.execute(sql\`…\`)` calls where at least one template
 * expression traces directly to a request-derived value (req.params.*, req.query.*,
 * req.body.*, route parameter identifiers, or local variables assigned from them).
 *
 * Engine: ts-morph (cross-file taint walk).
 * Base severity: critical (§7.1).
 */

import { SyntaxKind, type Project, type Node } from 'ts-morph';
import { join } from 'node:path';
import { createProject, addSourceFiles } from './harness.js';
import { fingerprint, displayId, normalizePath, normalizeSymbol, normalizeSnippet } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

const RULE_ID = 'BS-SQL-001';

/** Names that indicate a request-derived value at any access level. */
const REQUEST_PARAM_NAMES = new Set(['req', 'request', 'ctx', 'context']);
const REQUEST_PROPERTIES = new Set(['params', 'query', 'body', 'headers']);

/**
 * Return true if `node` is a property access expression rooted at a request
 * object (e.g. `req.params.id`, `req.query.name`, `req.body.email`).
 */
function isRequestAccess(node: Node): boolean {
  if (node.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  const expr = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const obj = expr.getExpression();

  // req.params.id — two-level access
  if (obj.getKind() === SyntaxKind.PropertyAccessExpression) {
    const inner = obj.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const innerObj = inner.getExpression();
    const innerProp = inner.getName();
    if (
      innerObj.getKind() === SyntaxKind.Identifier &&
      REQUEST_PARAM_NAMES.has(innerObj.asKindOrThrow(SyntaxKind.Identifier).getText()) &&
      REQUEST_PROPERTIES.has(innerProp)
    ) {
      return true;
    }
  }

  // req.params or req.query (one-level: entire sub-object passed)
  if (obj.getKind() === SyntaxKind.Identifier) {
    const name = obj.asKindOrThrow(SyntaxKind.Identifier).getText();
    const prop = expr.getName();
    if (REQUEST_PARAM_NAMES.has(name) && REQUEST_PROPERTIES.has(prop)) return true;
  }

  return false;
}

/**
 * Walk a template expression node to determine if any interpolated expression
 * is tainted by a request-derived value.
 *
 * Handles direct access (`${req.params.id}`) and single-step variable
 * dereferences (`const id = req.params.id; sql\`...${id}...\``).
 */
function templateHasTaint(templateNode: Node, taintedLocalNames: Set<string>): boolean {
  let found = false;

  templateNode.forEachDescendant((n) => {
    if (found) return;

    // Template span expression
    if (n.getKind() === SyntaxKind.TemplateSpan) {
      const span = n.asKindOrThrow(SyntaxKind.TemplateSpan);
      const expr = span.getExpression();

      // Direct: ${req.params.id}
      if (isRequestAccess(expr)) {
        found = true;
        return;
      }

      // Variable reference that was tainted
      if (
        expr.getKind() === SyntaxKind.Identifier &&
        taintedLocalNames.has(expr.asKindOrThrow(SyntaxKind.Identifier).getText())
      ) {
        found = true;
        return;
      }
    }
  });

  return found;
}

/**
 * Collect variable names tainted by request access within a function body node.
 * e.g. `const userId = req.params.id;` → "userId" is tainted.
 */
function collectTaintedLocals(fnBody: Node): Set<string> {
  const tainted = new Set<string>();

  fnBody.forEachDescendant((n) => {
    if (n.getKind() !== SyntaxKind.VariableDeclaration) return;
    const decl = n.asKindOrThrow(SyntaxKind.VariableDeclaration);
    const init = decl.getInitializer();
    if (!init) return;
    if (isRequestAccess(init)) {
      tainted.add(decl.getName());
    }
  });

  return tainted;
}

export function run(repoDir: string, targetName: string, project?: Project): Finding[] {
  const proj = project ?? (() => {
    const p = createProject(repoDir);
    addSourceFiles(p, repoDir);
    return p;
  })();

  const findings: Finding[] = [];

  for (const sourceFile of proj.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();

    // Skip node_modules / dist
    if (filePath.includes('node_modules') || filePath.includes('/dist/')) continue;

    // Collect all function-like declarations so we can scope tainted locals
    const fnBodies: Node[] = [];
    sourceFile.forEachDescendant((n) => {
      if (
        n.getKind() === SyntaxKind.FunctionDeclaration ||
        n.getKind() === SyntaxKind.FunctionExpression ||
        n.getKind() === SyntaxKind.ArrowFunction ||
        n.getKind() === SyntaxKind.MethodDeclaration
      ) {
        const body = (n as { getBody?: () => Node | undefined }).getBody?.();
        if (body) fnBodies.push(body);
      }
    });

    // Also consider the whole file as a scope (module-level code)
    fnBodies.push(sourceFile);

    for (const scope of fnBodies) {
      const taintedLocals = collectTaintedLocals(scope);

      scope.forEachDescendant((n) => {
        // Pattern 1: sql`...${tainted}...` tagged template
        if (n.getKind() === SyntaxKind.TaggedTemplateExpression) {
          const tagged = n.asKindOrThrow(SyntaxKind.TaggedTemplateExpression);
          const tag = tagged.getTag();
          const tagText = tag.getText().trim();

          // sql`...` or db.sql`...`
          if (tagText === 'sql' || tagText.endsWith('.sql')) {
            const template = tagged.getTemplate();
            if (templateHasTaint(template, taintedLocals)) {
              emitFinding(tagged, filePath, repoDir, targetName, findings);
            }
          }
        }

        // Pattern 2: db.execute(sql`...${tainted}...`)
        if (n.getKind() === SyntaxKind.CallExpression) {
          const call = n.asKindOrThrow(SyntaxKind.CallExpression);
          const expr = call.getExpression();
          const exprText = expr.getText().trim();

          if (exprText === 'db.execute' || exprText.endsWith('.execute')) {
            for (const arg of call.getArguments()) {
              if (arg.getKind() === SyntaxKind.TaggedTemplateExpression) {
                const tagged = arg.asKindOrThrow(SyntaxKind.TaggedTemplateExpression);
                const tag = tagged.getTag();
                if (tag.getText().trim() === 'sql' || tag.getText().trim().endsWith('.sql')) {
                  if (templateHasTaint(tagged.getTemplate(), taintedLocals)) {
                    emitFinding(call, filePath, repoDir, targetName, findings);
                  }
                }
              }
            }
          }
        }
      });
    }
  }

  // Deduplicate by fingerprint (fingerprint collision merge is handled by report builder)
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = f.fingerprint;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emitFinding(
  node: Node,
  filePath: string,
  repoDir: string,
  targetName: string,
  out: Finding[],
): void {
  const sf = node.getSourceFile();
  const startLine = sf.getLineAndColumnAtPos(node.getPos()).line + 1;
  const snippet = node.getText().slice(0, 200);

  // Determine enclosing symbol (function/method name or route)
  let symbol = 'unknown';
  let parent: Node | undefined = node.getParent();
  while (parent !== undefined) {
    const kind = parent.getKind();
    if (kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.MethodDeclaration) {
      const named = parent as { getName?: () => string | undefined };
      const name = named.getName?.();
      if (name) { symbol = name; break; }
    }
    if (kind === SyntaxKind.VariableDeclaration) {
      const vd = parent.asKindOrThrow(SyntaxKind.VariableDeclaration);
      symbol = vd.getName();
      break;
    }
    if (kind === SyntaxKind.PropertyAssignment) {
      const pa = parent.asKindOrThrow(SyntaxKind.PropertyAssignment);
      symbol = pa.getName();
      break;
    }
    parent = parent.getParent();
  }

  const relPath = normalizePath(filePath.replace(repoDir, ''));
  const normalizedSym = normalizeSymbol(symbol);
  const fp = fingerprint({
    kind: 'static',
    ruleId: RULE_ID,
    targetName,
    path: relPath,
    symbol: normalizedSym,
    snippet: normalizeSnippet(snippet),
  });

  out.push({
    id: displayId(fp),
    fingerprint: fp,
    ruleId: RULE_ID,
    source: 'ast',
    surface: 'static',
    vulnClass: 'injection',
    severity: 'critical',
    baseSeverity: 'critical',
    confidence: 'probable',
    target: { kind: 'repo', name: targetName },
    location: {
      path: relPath,
      symbol: normalizedSym,
      startLine,
    },
    evidence: {
      snippet,
      cvss: null,
      raw: {},
    },
    reachability: 'unknown',
    correlatedWith: [],
    docs: join('docs', 'rules', `${RULE_ID}.md`),
    externalRefs: [],
    firstSeen: new Date().toISOString(),
    suppressed: false,
    suppression: null,
    note: null,
  });
}
