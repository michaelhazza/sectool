/**
 * BS-WS-001 — socket.io handler registered without auth handshake middleware
 *
 * Flags `io.on('connection', handler)` and `io.of(namespace).on('connection', handler)`
 * calls where no auth/JWT middleware appears in `io.use(...)` or
 * `io.of(namespace).use(...)` calls within the same source file.
 *
 * Engine: ts-morph.
 * Base severity: high (§7.1).
 */

import { SyntaxKind, type Project } from 'ts-morph';
import { join } from 'node:path';
import { createProject, addSourceFiles } from './harness.js';
import { fingerprint, displayId, normalizePath, normalizeSymbol, normalizeSnippet } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

const RULE_ID = 'BS-WS-001';

/** Identifier names that indicate socket.io auth middleware. */
const WS_AUTH_MIDDLEWARE_NAMES = new Set([
  'authenticate', 'requireAuth', 'isAuthenticated', 'verifyAuth',
  'authMiddleware', 'jwtMiddleware', 'verifyToken', 'requireJwt',
  'socketAuth', 'wsAuth', 'checkAuth', 'withAuth',
  'socketJwt', 'verifySocketToken', 'socketAuthenticate',
]);

/**
 * Return true if an identifier name suggests socket.io auth middleware.
 */
function isAuthMiddlewareName(name: string): boolean {
  if (WS_AUTH_MIDDLEWARE_NAMES.has(name)) return true;
  const lower = name.toLowerCase();
  return (
    lower.includes('auth') ||
    lower.includes('jwt') ||
    lower.includes('verify') ||
    lower.includes('token')
  );
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

    // Collect all io.use(...) / io.of(ns).use(...) middleware registrations in this file
    const middlewareRootObjects = new Set<string>();

    sf.forEachDescendant((n) => {
      if (n.getKind() !== SyntaxKind.CallExpression) return;
      const call = n.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;

      const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (pae.getName() !== 'use') return;

      // Check if any argument is an auth middleware
      for (const arg of call.getArguments()) {
        let middlewareName: string | undefined;

        if (arg.getKind() === SyntaxKind.Identifier) {
          middlewareName = arg.asKindOrThrow(SyntaxKind.Identifier).getText();
        } else if (arg.getKind() === SyntaxKind.CallExpression) {
          // e.g. io.use(jwtMiddleware({ secret: process.env.JWT_SECRET }))
          const innerCall = arg.asKindOrThrow(SyntaxKind.CallExpression);
          const innerExpr = innerCall.getExpression();
          if (innerExpr.getKind() === SyntaxKind.Identifier) {
            middlewareName = innerExpr.asKindOrThrow(SyntaxKind.Identifier).getText();
          }
        }

        if (middlewareName !== undefined && isAuthMiddlewareName(middlewareName)) {
          // Record the root object (io or io.of(...)) this middleware is attached to
          const rootObj = pae.getExpression();
          middlewareRootObjects.add(rootObj.getText().trim());
        }
      }
    });

    // Now look for io.on('connection', ...) registrations
    sf.forEachDescendant((n) => {
      if (n.getKind() !== SyntaxKind.CallExpression) return;
      const call = n.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;

      const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (pae.getName() !== 'on') return;

      const args = call.getArguments();
      if (args.length < 2) return;

      const firstArg = args[0];
      if (firstArg === undefined) return;
      if (firstArg.getKind() !== SyntaxKind.StringLiteral) return;

      const eventName = firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      if (eventName !== 'connection') return;

      // Get the root object (io or io.of(namespace))
      const rootObj = pae.getExpression();
      const rootObjText = rootObj.getText().trim();

      // Check if this socket.io instance has auth middleware registered
      if (middlewareRootObjects.has(rootObjText)) return;

      // Unprotected connection handler — emit finding
      const relPath = normalizePath(filePath.replace(repoDir, ''));
      const startLine = sf.getLineAndColumnAtPos(n.getPos()).line + 1;
      const snippet = n.getText().slice(0, 200);
      const normalizedSym = normalizeSymbol(`socket.io connection ${rootObjText}`);

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
        vulnClass: 'auth-access-control',
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
          raw: { socketRoot: rootObjText },
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
