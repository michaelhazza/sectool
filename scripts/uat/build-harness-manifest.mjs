/**
 * build-harness-manifest.mjs — deterministic harness-identity builder (plan A7,
 * round-3 finding 7 + round-4 finding 5). NEVER an agent.
 *
 * Enumerating harness fields one by one never converges — the snapshot builder,
 * risk policy, classification registry, sandbox profile, and secret rules all
 * change verdicts too. So the harness manifest lists EVERY semantic UAT input
 * under a declared set of roots with its SHA-256, and evidence records
 * `harness_manifest_sha256` as the completeness boundary. A shipped-source-style
 * gate (buildAndCheck) fails when a newly introduced harness-semantic file sits
 * under a declared root but the manifest was built from a stale snapshot — i.e.
 * the manifest is only complete-by-construction if it is rebuilt, so the
 * boundary is mechanical, not by convention.
 *
 * Test files are excluded: they verify the harness, they do not change a verdict.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, canonicalSha256 } from './canonicalize.mjs';

// Declared semantic roots (framework side). A consumer adds its own UAT
// configuration roots (classification registry, project-registries UAT keys)
// via the same builder with an extended roots list.
export const HARNESS_ROOTS = [
  'scripts/uat',
  'schemas/uat-evidence.schema.json',
  'schemas/uat-plan.schema.json',
  'schemas/uat-plan-blind.schema.json',
  '.claude/skills/acceptance-testing',
  '.claude/agents/acceptance-phase.md',
  'templates/codex-skills/run-final-uat',
  'references/blind-planner-runtime.md',
  'references/codex-invocation-contract.md',
];

function isExcluded(rel) {
  return (
    rel.includes('/__tests__/') ||
    /\.test\.[cm]?[jt]s$/.test(rel) ||
    rel.includes('/node_modules/')
  );
}

function walk(absRoot, repoRoot, acc) {
  if (!existsSync(absRoot)) return;
  const st = statSync(absRoot);
  if (st.isFile()) {
    const rel = path.relative(repoRoot, absRoot).replace(/\\/g, '/');
    if (!isExcluded(rel)) acc.push(rel);
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(absRoot).sort()) {
      walk(path.join(absRoot, name), repoRoot, acc);
    }
  }
}

/**
 * @param {string} repoRoot
 * @param {string[]} [roots] — override the declared roots (tests / consumers)
 * @returns {{schema_version:string, files:{path:string,sha256:string}[], harness_manifest_sha256:string}}
 */
export function buildHarnessManifest(repoRoot, roots = HARNESS_ROOTS) {
  const rels = [];
  for (const r of roots) walk(path.resolve(repoRoot, r), path.resolve(repoRoot), rels);
  const uniq = [...new Set(rels)].sort();
  const files = uniq.map((rel) => ({
    path: rel,
    sha256: sha256Hex(readFileSync(path.join(repoRoot, rel))),
  }));
  return {
    schema_version: 'uat-harness-manifest.v1',
    files,
    // Digest over the sorted files array only — the completeness boundary.
    harness_manifest_sha256: canonicalSha256(files),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--repo-root');
  const repoRoot = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
  const manifest = buildHarnessManifest(repoRoot);
  console.log(JSON.stringify(manifest, null, 2));
}
