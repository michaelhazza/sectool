/**
 * BS-AUTH-001 — Express route registered without auth/permission middleware
 *
 * Flags `router.<method>(path, handler)` and `app.<method>(path, handler)` calls
 * where the route is NOT in the per-repo `publicRoutes` allowlist AND no
 * auth/permission middleware appears before the handler in the argument list.
 *
 * Also sets the §8.1 reachability operand:
 *   - Route in `publicRoutes`  → `unauthenticated` (does NOT fire)
 *   - Behind auth middleware   → `authenticated` (does NOT fire)
 *   - Behind admin/perm guard  → `admin` (does NOT fire)
 *   - No middleware found      → `unknown` (fires)
 *
 * Engine: ts-morph (middleware-chain walk).
 * Base severity: high (§7.1).
 */

import { SyntaxKind, type Project } from 'ts-morph';
import { join } from 'node:path';
import { createProject, addSourceFiles } from './harness.js';
import { fingerprint, displayId, normalizePath, normalizeSymbol, normalizeSnippet } from '../../correlate/fingerprint.js';
import type { Finding, Reachability } from '../../schemas/finding.js';

const RULE_ID = 'BS-AUTH-001';

/** HTTP method names that indicate a route definition. */
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'use']);

/** Identifier names that indicate auth/permission middleware. */
const AUTH_MIDDLEWARE_NAMES = new Set([
  // generic auth guards
  'authenticate', 'requireAuth', 'isAuthenticated', 'verifyAuth',
  'authMiddleware', 'jwtMiddleware', 'verifyToken', 'requireJwt',
  'requireLogin', 'ensureAuthenticated', 'ensureLoggedIn',
  'checkAuth', 'withAuth', 'protect', 'isLoggedIn',
  // permission/role guards
  'authorize', 'requireRole', 'requirePermission', 'checkPermission',
  'hasPermission', 'hasRole', 'isAdmin', 'requireAdmin', 'adminOnly',
  'isStaff', 'requireStaff', 'checkRole', 'guardRoute', 'withPermission',
  // common library exports
  'passport', 'session', 'cookieSession',
]);

/** Identifier name patterns for admin/permission guards. */
const ADMIN_MIDDLEWARE_PATTERN = /admin|role|permission|authorize|require.*admin/i;

/**
 * Normalize a route path to a stable method+path string, e.g. "GET /api/users/:id".
 */
function normalizeRoutePath(method: string, routeArg: string): string {
  return `${method.toUpperCase()} ${routeArg}`;
}

/**
 * Determine if a middleware argument identifier name indicates auth/permission.
 * Returns the reachability category: 'authenticated', 'admin', or null (not auth).
 */
function classifyMiddleware(name: string): 'authenticated' | 'admin' | null {
  const lower = name.toLowerCase();
  if (ADMIN_MIDDLEWARE_PATTERN.test(lower)) return 'admin';
  if (AUTH_MIDDLEWARE_NAMES.has(name) || AUTH_MIDDLEWARE_NAMES.has(lower)) return 'authenticated';
  return null;
}

/**
 * Inspect the middleware arguments (all args between the path and the final handler)
 * and return the reachability they imply.
 * Returns null if no auth middleware is detected (route fires).
 */
function detectMiddlewareReachability(
  args: Array<import('ts-morph').Node>,
): Reachability | null {
  // args[0] is the path; args[last] is the handler; everything in between is middleware
  // For single-handler calls (app.get(path, handler)) there are no middleware args
  if (args.length <= 2) return null;

  let bestReachability: 'authenticated' | 'admin' | null = null;

  for (let i = 1; i < args.length - 1; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    // Identifier reference: app.get('/route', requireAuth, handler)
    if (arg.getKind() === SyntaxKind.Identifier) {
      const name = arg.asKindOrThrow(SyntaxKind.Identifier).getText();
      const r = classifyMiddleware(name);
      if (r === 'admin') return 'admin';
      if (r === 'authenticated') bestReachability = 'authenticated';
    }

    // Array spread: app.get('/route', [requireAuth], handler)
    if (arg.getKind() === SyntaxKind.ArrayLiteralExpression) {
      const arr = arg.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
      for (const elem of arr.getElements()) {
        if (elem.getKind() === SyntaxKind.Identifier) {
          const name = elem.asKindOrThrow(SyntaxKind.Identifier).getText();
          const r = classifyMiddleware(name);
          if (r === 'admin') return 'admin';
          if (r === 'authenticated') bestReachability = 'authenticated';
        }
      }
    }
  }

  return bestReachability;
}

export interface RepoConfig {
  /** Routes that are intentionally public (do NOT fire). Format: "METHOD /path" e.g. "POST /api/auth/login". */
  publicRoutes?: string[];
}

export function run(
  repoDir: string,
  targetName: string,
  repoConfig?: RepoConfig,
  project?: Project,
): Finding[] {
  const proj = project ?? (() => {
    const p = createProject(repoDir);
    addSourceFiles(p, repoDir);
    return p;
  })();

  const publicRouteSet = new Set(repoConfig?.publicRoutes ?? []);
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

      // router/app.use() without a path as first arg is middleware, not a route — skip
      const args = call.getArguments();
      if (args.length === 0) return;

      const firstArg = args[0];
      if (firstArg === undefined) return;
      // First argument should be a string literal (the route path)
      if (firstArg.getKind() !== SyntaxKind.StringLiteral) return;

      const routePathArg = firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      const routeKey = normalizeRoutePath(methodName, routePathArg);

      // If route is in the publicRoutes allowlist — reachability = unauthenticated, do NOT fire
      if (publicRouteSet.has(routeKey)) return;

      const reachability = detectMiddlewareReachability(args);
      // If auth middleware was found — reachability is authenticated/admin, do NOT fire
      if (reachability !== null) return;

      // Route is unprotected — emit finding
      const relPath = normalizePath(filePath.replace(repoDir, ''));
      const startLine = sf.getLineAndColumnAtPos(n.getPos()).line + 1;
      const snippet = n.getText().slice(0, 200);
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
