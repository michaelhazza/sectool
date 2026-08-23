/**
 * build-harness-manifest.test.mjs — the harness-identity completeness boundary.
 * Run: npx vitest run scripts/uat/__tests__/build-harness-manifest.test.mjs
 */

import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHarnessManifest } from '../build-harness-manifest.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uat-harness-'));
  mkdirSync(path.join(root, 'scripts', 'uat', '__tests__'), { recursive: true });
  mkdirSync(path.join(root, 'schemas'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'uat', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'scripts', 'uat', 'policy.json'), '{"x":1}\n');
  writeFileSync(path.join(root, 'scripts', 'uat', '__tests__', 'a.test.mjs'), 'test skip\n');
  writeFileSync(path.join(root, 'schemas', 'uat-evidence.schema.json'), '{}\n');
  return root;
}

const ROOTS = ['scripts/uat', 'schemas/uat-evidence.schema.json'];

test('manifest lists every semantic file and is deterministic', () => {
  const root = fixture();
  const m1 = buildHarnessManifest(root, ROOTS);
  const m2 = buildHarnessManifest(root, ROOTS);
  expect(m1.harness_manifest_sha256).toBe(m2.harness_manifest_sha256);
  const paths = m1.files.map((f) => f.path);
  expect(paths).toContain('scripts/uat/a.mjs');
  expect(paths).toContain('scripts/uat/policy.json');
  expect(paths).toContain('schemas/uat-evidence.schema.json');
});

test('test files are excluded from the harness manifest', () => {
  const root = fixture();
  const m = buildHarnessManifest(root, ROOTS);
  expect(m.files.some((f) => f.path.includes('__tests__'))).toBe(false);
});

test('adding a new harness-semantic file under a root changes the manifest hash', () => {
  const root = fixture();
  const before = buildHarnessManifest(root, ROOTS).harness_manifest_sha256;
  writeFileSync(path.join(root, 'scripts', 'uat', 'new-builder.mjs'), 'export const b = 2;\n');
  const after = buildHarnessManifest(root, ROOTS).harness_manifest_sha256;
  expect(after).not.toBe(before);
});

test('editing a covered file changes the manifest hash', () => {
  const root = fixture();
  const before = buildHarnessManifest(root, ROOTS).harness_manifest_sha256;
  writeFileSync(path.join(root, 'scripts', 'uat', 'a.mjs'), 'export const a = 999;\n');
  const after = buildHarnessManifest(root, ROOTS).harness_manifest_sha256;
  expect(after).not.toBe(before);
});
