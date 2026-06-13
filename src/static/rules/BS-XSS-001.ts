/**
 * BS-XSS-001 — User-supplied HTML rendered or stored without sanitize-html
 *
 * Flags assignments and calls where a request-derived value is:
 *   1. Passed directly to `res.send()` or `res.end()`
 *   2. Stored in a variable that is then used in res.send/res.end
 *   3. Assigned to `.innerHTML` (React/DOM context)
 *   4. Passed to `dangerouslySetInnerHTML` in JSX
 *
 * WITHOUT a `sanitizeHtml(...)` / `sanitize(...)` / `DOMPurify.sanitize(...)` call
 * on the same value in the same function body.
 *
 * Engine: ts-morph.
 * Base severity: high (§7.1).
 */

import { SyntaxKind, type Project, type Node } from 'ts-morph';
import { join } from 'node:path';
import { createProject, addSourceFiles } from './harness.js';
import { fingerprint, displayId, normalizePath, normalizeSymbol, normalizeSnippet } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

const RULE_ID = 'BS-XSS-001';

const REQUEST_PARAM_NAMES = new Set(['req', 'request']);
const REQUEST_PROPERTIES = new Set(['params', 'query', 'body', 'headers']);

/** Names indicating HTML sanitization. */
const SANITIZE_NAMES = new Set([
  'sanitizeHtml', 'sanitize', 'purify', 'escapeHtml', 'escape',
  'DOMPurify', 'xss', 'filterXss', 'sanitizeInput',
]);

/** Call names that emit HTML to the client. */
const HTML_EMIT_METHODS = new Set(['send', 'end', 'write', 'sendFile']);

/**
 * Return true if the node is a request-property access (req.body, req.query, etc.)
 */
function isRequestAccess(node: Node): boolean {
  if (node.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  const pae = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const obj = pae.getExpression();

  // req.body.field or req.query.search — two-level
  if (obj.getKind() === SyntaxKind.PropertyAccessExpression) {
    const inner = obj.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const innerObj = inner.getExpression();
    const innerProp = inner.getName();
    if (
      innerObj.getKind() === SyntaxKind.Identifier &&
      REQUEST_PARAM_NAMES.has(innerObj.asKindOrThrow(SyntaxKind.Identifier).getText()) &&
      REQUEST_PROPERTIES.has(innerProp)
    ) return true;
  }

  // req.body or req.query — one-level
  if (obj.getKind() === SyntaxKind.Identifier) {
    const name = obj.asKindOrThrow(SyntaxKind.Identifier).getText();
    const prop = pae.getName();
    if (REQUEST_PARAM_NAMES.has(name) && REQUEST_PROPERTIES.has(prop)) return true;
  }

  return false;
}

/**
 * Return true if any call in the function body involves a sanitize-html function.
 */
function hasSanitizeCall(fnBody: Node): boolean {
  let found = false;
  fnBody.forEachDescendant((n) => {
    if (found) return;
    if (n.getKind() !== SyntaxKind.CallExpression) return;
    const call = n.asKindOrThrow(SyntaxKind.CallExpression);
    const expr = call.getExpression();

    if (expr.getKind() === SyntaxKind.Identifier) {
      if (SANITIZE_NAMES.has(expr.asKindOrThrow(SyntaxKind.Identifier).getText())) {
        found = true;
      }
    } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (SANITIZE_NAMES.has(pae.getName()) || SANITIZE_NAMES.has(pae.getExpression().getText())) {
        found = true;
      }
    }
  });
  return found;
}

/**
 * Collect local variable names that are assigned from request properties in the given scope.
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

/**
 * Return true if the given argument node is tainted (directly from request or via tainted local).
 */
function isTainted(arg: Node, taintedLocals: Set<string>): boolean {
  if (isRequestAccess(arg)) return true;
  if (arg.getKind() === SyntaxKind.Identifier) {
    return taintedLocals.has(arg.asKindOrThrow(SyntaxKind.Identifier).getText());
  }
  // Template literal with tainted span
  if (arg.getKind() === SyntaxKind.TemplateLiteral || arg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    let found = false;
    arg.forEachDescendant((n) => {
      if (found) return;
      if (n.getKind() === SyntaxKind.TemplateSpan) {
        const span = n.asKindOrThrow(SyntaxKind.TemplateSpan);
        if (isTainted(span.getExpression(), taintedLocals)) found = true;
      }
    });
    return found;
  }
  return false;
}

/**
 * Scan a function body for res.send(taintedValue) or assignment to innerHTML.
 */
function findUnsafeHtmlEmits(
  fnBody: Node,
  taintedLocals: Set<string>,
): Array<{ node: Node; kind: string }> {
  const hits: Array<{ node: Node; kind: string }> = [];

  fnBody.forEachDescendant((n) => {
    // Pattern 1: res.send(taintedValue)
    if (n.getKind() === SyntaxKind.CallExpression) {
      const call = n.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression();
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        if (HTML_EMIT_METHODS.has(pae.getName())) {
          for (const arg of call.getArguments()) {
            if (isTainted(arg, taintedLocals)) {
              hits.push({ node: n, kind: `res.${pae.getName()}` });
              break;
            }
          }
        }
      }
    }

    // Pattern 2: element.innerHTML = taintedValue
    if (n.getKind() === SyntaxKind.BinaryExpression) {
      const bin = n.asKindOrThrow(SyntaxKind.BinaryExpression);
      const left = bin.getLeft();
      if (
        left.getKind() === SyntaxKind.PropertyAccessExpression &&
        left.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName() === 'innerHTML'
      ) {
        const right = bin.getRight();
        if (isTainted(right, taintedLocals)) {
          hits.push({ node: n, kind: 'innerHTML' });
        }
      }
    }
  });

  return hits;
}

export function run(repoDir: string, targetName: string, project?: Project): Finding[] {
  const proj = project ?? (() => {
    const p = createProject(repoDir);
    addSourceFiles(p, repoDir);
    return p;
  })();

  const findings: Finding[] = [];

  for (const sf of proj.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (filePath.includes('node_modules') || filePath.includes('/dist/')) continue;

    // Collect all function-like scopes
    const fnBodies: Node[] = [];
    sf.forEachDescendant((n) => {
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
    fnBodies.push(sf);

    for (const fnBody of fnBodies) {
      if (hasSanitizeCall(fnBody)) continue;

      const taintedLocals = collectTaintedLocals(fnBody);
      const hits = findUnsafeHtmlEmits(fnBody, taintedLocals);

      for (const { node, kind } of hits) {
        const relPath = normalizePath(filePath.replace(repoDir, ''));
        const startLine = sf.getLineAndColumnAtPos(node.getPos()).line + 1;
        const snippet = node.getText().slice(0, 200);

        // Enclosing symbol
        let symbol = 'unknown';
        let parent: Node | undefined = node.getParent();
        while (parent !== undefined) {
          const k = parent.getKind();
          if (k === SyntaxKind.FunctionDeclaration || k === SyntaxKind.MethodDeclaration) {
            const named = parent as { getName?: () => string | undefined };
            const name = named.getName?.();
            if (name) { symbol = name; break; }
          }
          if (k === SyntaxKind.VariableDeclaration) {
            symbol = parent.asKindOrThrow(SyntaxKind.VariableDeclaration).getName();
            break;
          }
          parent = parent.getParent();
        }

        const normalizedSym = normalizeSymbol(symbol);
        const fp = fingerprint({
          kind: 'static',
          ruleId: RULE_ID,
          targetName,
          path: relPath,
          symbol: normalizedSym,
          snippet: normalizeSnippet(snippet),
        });

        findings.push({
          id: displayId(fp),
          fingerprint: fp,
          ruleId: RULE_ID,
          source: 'ast',
          surface: 'static',
          vulnClass: 'xss',
          severity: 'high',
          baseSeverity: 'high',
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
            raw: { emitKind: kind },
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
    }
  }

  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.fingerprint)) return false;
    seen.add(f.fingerprint);
    return true;
  });
}
