/**
 * BS-RLS-001 — Drizzle tenant table with no RLS policy in migrations
 *
 * Flags Drizzle `pgTable(...)` calls that define a table with a tenant column
 * (organisationId / subaccountId et al.) when NO corresponding RLS policy
 * (`CREATE POLICY ... ON <tableName>` or `ALTER TABLE <tableName> ENABLE ROW LEVEL SECURITY`)
 * appears in any migration file under `migrations/`, `drizzle/`, or `db/migrations/`.
 *
 * Symbol (§6.6): the normalized pgTable name literal (e.g. `subscriptions`).
 * This is the canonical `symbol` for fingerprinting and baseline scoping.
 *
 * Engine: ts-morph + migration file scan.
 * Base severity: critical (§7.1).
 */

import { SyntaxKind, type Project } from 'ts-morph';
import { join } from 'node:path';
import { createProject, addSourceFiles, readMigrationFiles } from './harness.js';
import { fingerprint, displayId, normalizePath, normalizeSymbol } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

const RULE_ID = 'BS-RLS-001';

const TENANT_COLUMN_NAMES = new Set([
  'organisationId', 'organisation_id',
  'subaccountId', 'subaccount_id',
  'tenantId', 'tenant_id',
  'orgId', 'org_id',
]);

interface TenantTable {
  /** The pgTable name literal (e.g. 'subscriptions'). */
  tableName: string;
  /** The variable name the pgTable result is assigned to. */
  varName: string;
  /** Source file path. */
  filePath: string;
  /** Start line (1-indexed, display only). */
  startLine: number;
  /** Raw snippet for evidence. */
  snippet: string;
}

/**
 * Discover all pgTable definitions that include at least one tenant column.
 */
function collectTenantTables(repoDir: string, project: Project): TenantTable[] {
  const tables: TenantTable[] = [];

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (filePath.includes('node_modules') || filePath.includes('/dist/')) continue;

    sf.forEachDescendant((n) => {
      if (n.getKind() !== SyntaxKind.CallExpression) return;
      const call = n.asKindOrThrow(SyntaxKind.CallExpression);
      const exprText = call.getExpression().getText().trim();
      if (exprText !== 'pgTable') return;

      const args = call.getArguments();
      if (args.length < 2) return;

      // First arg: table name string literal
      const nameArg = args[0];
      if (nameArg === undefined) return;
      if (nameArg.getKind() !== SyntaxKind.StringLiteral) return;
      const tableName = nameArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

      // Second arg: column definitions object
      const colsArg = args[1];
      if (colsArg === undefined) return;
      if (colsArg.getKind() !== SyntaxKind.ObjectLiteralExpression) return;

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

      // Get variable name the table is assigned to
      const parent = call.getParent();
      const varName =
        parent?.getKind() === SyntaxKind.VariableDeclaration
          ? parent.asKindOrThrow(SyntaxKind.VariableDeclaration).getName()
          : tableName;

      const startLine = sf.getLineAndColumnAtPos(n.getPos()).line + 1;
      const snippet = n.getText().slice(0, 300);

      tables.push({ tableName, varName, filePath, startLine, snippet });
    });
  }

  return tables;
}

/**
 * Build the set of table names that have at least one RLS policy in migrations.
 * Looks for:
 *   - `CREATE POLICY ... ON <tableName>`
 *   - `ALTER TABLE <tableName> ENABLE ROW LEVEL SECURITY`
 */
function collectTablesWithRls(repoDir: string): Set<string> {
  const rlsTables = new Set<string>();
  const migrations = readMigrationFiles(repoDir);

  for (const { content } of migrations) {
    const contentLower = content.toLowerCase();

    // CREATE POLICY policyname ON tablename ...
    for (const match of content.matchAll(/CREATE\s+POLICY\s+\S+\s+ON\s+(\w+)/gi)) {
      const tableName = match[1];
      if (tableName !== undefined) rlsTables.add(tableName.toLowerCase());
    }

    // ALTER TABLE tablename ENABLE ROW LEVEL SECURITY
    for (const match of contentLower.matchAll(/alter\s+table\s+(\w+)\s+enable\s+row\s+level\s+security/gi)) {
      const tableName = match[1];
      if (tableName !== undefined) rlsTables.add(tableName.toLowerCase());
    }
  }

  return rlsTables;
}

export function run(repoDir: string, targetName: string, project?: Project): Finding[] {
  const proj = project ?? (() => {
    const p = createProject(repoDir);
    addSourceFiles(p, repoDir);
    return p;
  })();

  const tenantTables = collectTenantTables(repoDir, proj);
  if (tenantTables.length === 0) return [];

  const rlsTables = collectTablesWithRls(repoDir);

  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const table of tenantTables) {
    // Check if any RLS policy covers this table name
    if (rlsTables.has(table.tableName.toLowerCase())) continue;

    const relPath = normalizePath(table.filePath.replace(repoDir, ''));
    // §6.6: symbol for schema-level rules = normalized pgTable name
    const symbol = normalizeSymbol(table.tableName);

    const fp = fingerprint({
      kind: 'static',
      ruleId: RULE_ID,
      targetName,
      path: relPath,
      symbol,
      snippet: table.tableName, // stable: just the table name as snippet
    });

    if (seen.has(fp)) continue;
    seen.add(fp);

    findings.push({
      id: displayId(fp),
      fingerprint: fp,
      ruleId: RULE_ID,
      source: 'ast',
      surface: 'static',
      vulnClass: 'tenant-isolation',
      severity: 'critical',
      baseSeverity: 'critical',
      confidence: 'probable',
      target: { kind: 'repo', name: targetName },
      location: {
        path: relPath,
        symbol,
        startLine: table.startLine,
      },
      evidence: {
        snippet: table.snippet,
        cvss: null,
        raw: { tableName: table.tableName },
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

  return findings;
}
