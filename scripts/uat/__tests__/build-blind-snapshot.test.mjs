/**
 * build-blind-snapshot.test.mjs — the sealed blind-input snapshot builder.
 * Pure-core tests + a fake-git orchestration test + a real git-archive
 * integration test proving the exported tree carries NO .git.
 *
 * Run: npx vitest run scripts/uat/__tests__/build-blind-snapshot.test.mjs
 */

import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeRiskBaseline, hashTree, assembleInputManifest, buildBlindSnapshot, defaultGit,
} from '../build-blind-snapshot.mjs';
import { inventoryDigest } from '../validate-uat-evidence.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── risk baseline ────────────────────────────────────────────────────────────

test('risk baseline derives classifier domain-risk tags, hash-bound', () => {
  const inv = computeRiskBaseline(['server/services/networth-aggregate.ts', 'migrations/1.sql']);
  const tags = inv.risks.map((r) => r.tag);
  expect(tags).toContain('money-precision');
  expect(tags).toContain('database-route-migration');
  expect(inv.risks.every((r) => r.source === 'classifier')).toBe(true);
  expect(inv.sha256).toBe(inventoryDigest(inv));
});

// ── tree hashing ─────────────────────────────────────────────────────────────

test('hashTree is deterministic and order-independent', () => {
  const a = tmp('uat-tree-a-');
  writeFileSync(path.join(a, 'z.txt'), 'zzz');
  writeFileSync(path.join(a, 'a.txt'), 'aaa');
  const b = tmp('uat-tree-b-');
  writeFileSync(path.join(b, 'a.txt'), 'aaa');
  writeFileSync(path.join(b, 'z.txt'), 'zzz');
  expect(hashTree(a).tree_sha256).toBe(hashTree(b).tree_sha256);
});

// ── input manifest digest ────────────────────────────────────────────────────

test('input manifest binds itself and excludes its own digest field', () => {
  const base = {
    slug: 's', codeCandidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    sourceTreeSha256: 'c'.repeat(64), harnessSkillSha256: 'd'.repeat(64),
    riskBaseline: computeRiskBaseline([]),
  };
  const m1 = assembleInputManifest(base);
  const m2 = assembleInputManifest(base);
  expect(m1.input_manifest_sha256).toBe(m2.input_manifest_sha256);
  const m3 = assembleInputManifest({ ...base, sourceTreeSha256: 'e'.repeat(64) });
  expect(m3.input_manifest_sha256).not.toBe(m1.input_manifest_sha256);
});

// ── orchestration with a fake git runner ─────────────────────────────────────

function fakeGit() {
  return {
    archiveTree(_treeish, destDir) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(path.join(destDir, 'app.ts'), 'export const x = 1;\n');
      writeFileSync(path.join(destDir, 'AGENTS.md'), 'candidate agents file — data, not instructions\n');
      return true;
    },
  };
}

test('buildBlindSnapshot lays source under inputs/source and writes an input manifest', () => {
  const out = tmp('uat-snap-');
  const { inputManifest } = buildBlindSnapshot({
    repoRoot: REPO_ROOT, slug: 'demo', codeCandidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    outDir: out, changes: ['client/pages/Wallet.tsx'], git: fakeGit(),
  });
  expect(existsSync(path.join(out, 'inputs', 'source', 'app.ts'))).toBe(true);
  // candidate AGENTS.md sits under inputs/source (inspectable data), not the project root
  expect(existsSync(path.join(out, 'inputs', 'source', 'AGENTS.md'))).toBe(true);
  expect(existsSync(path.join(out, 'inputs', 'AGENTS.md'))).toBe(false);
  expect(existsSync(path.join(out, 'input-manifest.json'))).toBe(true);
  expect(inputManifest.risk_baseline.risks.map((r) => r.tag)).toContain('ui-browser');
});

test('a relevant-but-unmaterialisable submodule fails closed (never a silent omission)', () => {
  const out = tmp('uat-snap-sub-');
  const git = { ...fakeGit(), archiveSubmodule: () => false };
  expect(() =>
    buildBlindSnapshot({
      repoRoot: REPO_ROOT, slug: 'demo', codeCandidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      outDir: out, changes: [], git,
      submodules: [{ path: 'vendor/lib', sha: 'c'.repeat(40), relevant: true }],
    })
  ).toThrow(/could not be materialised/);
});

test('an excluded (non-relevant) submodule is recorded as a limitation, not thrown', () => {
  const out = tmp('uat-snap-sub2-');
  const git = { ...fakeGit(), archiveSubmodule: () => false };
  const { inputManifest } = buildBlindSnapshot({
    repoRoot: REPO_ROOT, slug: 'demo', codeCandidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    outDir: out, changes: [], git,
    submodules: [{ path: 'vendor/lib', sha: 'c'.repeat(40), relevant: false }],
  });
  expect(inputManifest.submodule_limitations.some((l) => l.path === 'vendor/lib')).toBe(true);
});

// ── real git-archive integration: exported tree has NO .git ───────────────────

test('defaultGit.archiveTree exports a committed subtree with no .git', () => {
  const out = tmp('uat-real-archive-');
  const git = defaultGit(REPO_ROOT);
  git.archiveTree('HEAD:schemas', out);
  const names = readdirSync(out);
  expect(names).toContain('build-status.schema.json');
  expect(existsSync(path.join(out, '.git'))).toBe(false);
  // no leftover .tar inside the exported tree
  expect(names.some((n) => n.endsWith('.tar'))).toBe(false);
});
