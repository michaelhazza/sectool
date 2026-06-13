/**
 * BS-VAL-001 — Route handler reading body/query/params with no Zod parse at boundary
 *
 * Flags Express route handlers that access `req.body`, `req.query`, or `req.params`
 * without a corresponding Zod schema `.parse()` or `.safeParse()` call on that
 * property within the same function body.
 *
 * Engine: ts-morph.
 * Base severity: medium (§7.1).
 */

import { SyntaxKind, type Project, type Node } from 'ts-morph';
import { join } from 'node:path';
import { createProject, addSourceFiles } from './harness.js';
import { fingerprint, displayId, normalizePath, normalizeSymbol, normalizeSnippet } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

const RULE_ID = 'BS-VAL-001';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'use']);

/** Request properties that should be Zod-validated at the boundary. */
const REQUEST_INPUT_PROPS = new Set(['body', 'query', 'params']);

/** Names that indicate a Zod schema variable (commonly used). */
const ZOD_PARSE_METHODS = new Set(['parse', 'safeParse']);

/**
 * Return true if the function body contains a `.parse()` or `.safeParse()` call,
 * suggesting that at least one schema parse is present.
 */
function hasSchemaParse(fnBody: Node): boolean {
  let found = false;
  fnBody.forEachDescendant((n) => {
    if (found) return;
    if (n.getKind() !== SyntaxKind.CallExpression) return;
    const call = n.asKindOrThrow(SyntaxKind.CallExpression);
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (ZOD_PARSE_METHODS.has(pae.getName())) {
      found = true;
    }
  });
  return found;
}

/**
 * Return true if the node accesses req.body, req.query, or req.params
 * (direct access or destructuring).
 */
function readsRequestInput(fnBody: Node): boolean {
  let found = false;
  fnBody.forEachDescendant((n) => {
    if (found) return;
    if (n.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const pae = n.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const propName = pae.getName();
    if (!REQUEST_INPUT_PROPS.has(propName)) return;
    const obj = pae.getExpression();
    if (obj.getKind() !== SyntaxKind.Identifier) return;
    const name = obj.asKindOrThrow(SyntaxKind.Identifier).getText();
    if (name === 'req' || name === 'request') {
      found = true;
    }
  });
  return found;
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

    sf.forEachDescendant((n) => {
      if (n.getKind() !== SyntaxKind.CallExpression) return;
      const call = n.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;

      const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const methodName = pae.getName().toLowerCase();
      if (!HTTP_METHODS.has(methodName)) return;

      const args = call.getArguments();
      if (args.length < 2) return;

      // First arg should be a string path
      const firstArg = args[0];
      if (firstArg === undefined) return;
      if (firstArg.getKind() !== SyntaxKind.StringLiteral) return;
      const routePath = firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

      // The last argument is the handler function
      const lastArg = args[args.length - 1];
      if (lastArg === undefined) return;

      const handlerKind = lastArg.getKind();
      if (
        handlerKind !== SyntaxKind.ArrowFunction &&
        handlerKind !== SyntaxKind.FunctionExpression
      ) return;

      const handlerBody = (lastArg as { getBody?: () => Node | undefined }).getBody?.();
      if (!handlerBody) return;

      // Check if handler reads req.body/query/params AND lacks schema parse
      if (!readsRequestInput(handlerBody)) return;
      if (hasSchemaParse(handlerBody)) return;

      // Handler reads request input without Zod validation — emit finding
      const relPath = normalizePath(filePath.replace(repoDir, ''));
      const startLine = sf.getLineAndColumnAtPos(n.getPos()).line + 1;
      const snippet = n.getText().slice(0, 200);
      const routeKey = `${methodName.toUpperCase()} ${routePath}`;
      const normalizedSym = normalizeSymbol(routeKey);

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
        vulnClass: 'misconfiguration',
        severity: 'medium',
        baseSeverity: 'medium',
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
          raw: { route: routeKey },
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
    });
  }

  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.fingerprint)) return false;
    seen.add(f.fingerprint);
    return true;
  });
}
