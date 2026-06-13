/**
 * BS-SQL-002 — Queries on tenant tables bypassing scoped query helpers
 *
 * Flags `.from(tenantTable)` / `.update(tenantTable)` / `.delete(tenantTable)` /
 * `.insert().into(tenantTable)` call chains where the root of the chain is NOT
 * a scoped helper (`scopedQuery(...)`, `withTenant(...)`, `forOrg(...)`).
 *
 * Engine: ts-morph (cross-file — table definitions may live in schema.ts).
 * Base severity: high (§7.1).
 */

import { SyntaxKind, type Project, type Node, type SourceFile } from 'ts-morph';
import { join } from 'node:path';
import { createProject, addSourceFiles } from './harness.js';
import { fingerprint, displayId, normalizePath, normalizeSymbol, normalizeSnippet } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

const RULE_ID = 'BS-SQL-002';

const TENANT_COLUMN_NAMES = new Set([
  'organisationId', 'organisation_id',
  'subaccountId', 'subaccount_id',
  'tenantId', 'tenant_id',
  'orgId', 'org_id',
]);

const SCOPED_HELPER_NAMES = new Set([
  'scopedQuery', 'withTenant', 'forOrg', 'tenantQuery', 'scopedDb',
]);

/**
 * Scan schema source files and return the set of table variable names that
 * have at least one tenant column.
 */
function collectTenantTableNames(sourceFiles: SourceFile[]): Set<string> {
  const tenantTables = new Set<string>();

  for (const sf of sourceFiles) {
    sf.forEachDescendant((n) => {
      if (n.getKind() !== SyntaxKind.CallExpression) return;
      const call = n.asKindOrThrow(SyntaxKind.CallExpression);
      const exprText = call.getExpression().getText().trim();
      if (exprText !== 'pgTable' && exprText !== 'mysqlTable' && exprText !== 'sqliteTable') return;

      const args = call.getArguments();
      if (args.length < 2) return;
      const colsArg = args[1];
      if (colsArg === undefined || colsArg.getKind() !== SyntaxKind.ObjectLiteralExpression) return;

      const colsObj = colsArg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      let hasTenantCol = false;
      for (const prop of colsObj.getProperties()) {
        let propName: string | undefined;
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          propName = prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName();
        } else if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
          propName = prop.asKindOrThrow(SyntaxKind.ShorthandPropertyAssignment).getName();
        }
        if (propName !== undefined && TENANT_COLUMN_NAMES.has(propName)) {
          hasTenantCol = true;
          break;
        }
      }

      if (!hasTenantCol) return;

      const parent = call.getParent();
      if (parent?.getKind() === SyntaxKind.VariableDeclaration) {
        tenantTables.add(parent.asKindOrThrow(SyntaxKind.VariableDeclaration).getName());
      }
    });
  }

  return tenantTables;
}

/**
 * Walk up a call chain expression (a.b().c().d()) and return the identifier
 * at the root, if any. Used to check if the chain starts with a scoped helper.
 */
function getRootIdentifierText(node: Node): string | undefined {
  let current: Node = node;
  while (true) {
    if (current.getKind() === SyntaxKind.CallExpression) {
      const ce = current.asKindOrThrow(SyntaxKind.CallExpression);
      current = ce.getExpression();
    } else if (current.getKind() === SyntaxKind.PropertyAccessExpression) {
      const pae = current.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      current = pae.getExpression();
    } else if (current.getKind() === SyntaxKind.Identifier) {
      return current.asKindOrThrow(SyntaxKind.Identifier).getText();
    } else {
      return undefined;
    }
  }
}

/**
 * Return true if the call chain rooted at `callNode` is preceded by a
 * scoped helper call (e.g., `scopedQuery(db, orgId).select().from(table)`).
 */
function isChainedFromScopedHelper(callNode: Node): boolean {
  // Walk the entire expression tree upward to find a call to a scoped helper
  let current: Node = callNode;
  while (true) {
    if (current.getKind() === SyntaxKind.CallExpression) {
      const ce = current.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = ce.getExpression();

      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        // e.g. scopedQuery(db, orgId).select() → expr is PropertyAccessExpression
        // Walk into the object part
        current = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();
      } else if (expr.getKind() === SyntaxKind.Identifier) {
        const name = expr.asKindOrThrow(SyntaxKind.Identifier).getText();
        return SCOPED_HELPER_NAMES.has(name);
      } else {
        break;
      }
    } else if (current.getKind() === SyntaxKind.PropertyAccessExpression) {
      current = current.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();
    } else {
      break;
    }
  }

  // Also check by looking at the root identifier of the original callNode
  const rootId = getRootIdentifierText(callNode);
  if (rootId !== undefined && SCOPED_HELPER_NAMES.has(rootId)) return true;

  return false;
}

export function run(repoDir: string, targetName: string, project?: Project): Finding[] {
  const proj = project ?? (() => {
    const p = createProject(repoDir);
    addSourceFiles(p, repoDir);
    return p;
  })();

  const sourceFiles = proj.getSourceFiles().filter(
    (sf) => !sf.getFilePath().includes('node_modules') && !sf.getFilePath().includes('/dist/'),
  );

  const tenantTableNames = collectTenantTableNames(sourceFiles);
  if (tenantTableNames.size === 0) return [];

  const findings: Finding[] = [];

  for (const sf of sourceFiles) {
    sf.forEachDescendant((n) => {
      if (n.getKind() !== SyntaxKind.CallExpression) return;
      const call = n.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;

      const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const methodName = pae.getName();

      // We care about .from(tenantTable) — the primary way Drizzle queries tables
      if (methodName !== 'from') return;

      // Check if any argument to .from() is a tenant table
      let usesTenantTable = false;
      for (const arg of call.getArguments()) {
        const argText = arg.getText().trim();
        if (tenantTableNames.has(argText)) {
          usesTenantTable = true;
          break;
        }
        // Also handle dotted access like schema.invoices
        if (arg.getKind() === SyntaxKind.PropertyAccessExpression) {
          const name = arg.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName();
          if (tenantTableNames.has(name)) {
            usesTenantTable = true;
            break;
          }
        }
      }

      if (!usesTenantTable) return;
      if (isChainedFromScopedHelper(call)) return;

      const filePath = sf.getFilePath();
      const relPath = normalizePath(filePath.replace(repoDir, ''));
      const startLine = sf.getLineAndColumnAtPos(n.getPos()).line + 1;
      const snippet = n.getText().slice(0, 200);

      let symbol = 'unknown';
      let parent: Node | undefined = n.getParent();
      while (parent !== undefined) {
        const kind = parent.getKind();
        if (kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.MethodDeclaration) {
          const named = parent as { getName?: () => string | undefined };
          const fnName = named.getName?.();
          if (fnName) { symbol = fnName; break; }
        }
        if (kind === SyntaxKind.VariableDeclaration) {
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
        vulnClass: 'tenant-isolation',
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
    });
  }

  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.fingerprint)) return false;
    seen.add(f.fingerprint);
    return true;
  });
}
