/**
 * build-certification-manifest.test.mjs — the out-of-band certification tail.
 * Run: npx vitest run scripts/uat/__tests__/build-certification-manifest.test.mjs
 */

import { test, expect } from 'vitest';
import { buildCertificationManifest, validateCertificationDiff, certificationAllowedPaths } from '../build-certification-manifest.mjs';

const SLUG = 'demo-build';
const SHA = 'a'.repeat(40);

function artifacts() {
  return [
    { path: `tasks/builds/${SLUG}/uat-evidence.json`, sha256: 'b'.repeat(64), bytes: 100 },
    { path: `tasks/builds/${SLUG}/uat-report.md`, sha256: 'c'.repeat(64), bytes: 50 },
    { path: `tasks/builds/${SLUG}/status.json`, sha256: 'd'.repeat(64), bytes: 30 },
  ];
}

test('builds a deterministic, hash-bound manifest for permitted artifacts', () => {
  const m1 = buildCertificationManifest({ slug: SLUG, codeCandidateSha: SHA, artifacts: artifacts() });
  const m2 = buildCertificationManifest({ slug: SLUG, codeCandidateSha: SHA, artifacts: artifacts() });
  expect(m1.document_sha256).toBe(m2.document_sha256);
  expect(m1.code_candidate_sha).toBe(SHA);
});

test('the manifest never contains its own commit SHA (records code_candidate_sha only)', () => {
  const m = buildCertificationManifest({ slug: SLUG, codeCandidateSha: SHA, artifacts: artifacts() });
  // Only the tested SHA is recorded; there is no certification_head_sha field.
  expect(m).not.toHaveProperty('certification_head_sha');
  expect(m.code_candidate_sha).toBe(SHA);
});

test('rejects an artifact outside the permitted certification paths', () => {
  const bad = [{ path: 'src/app.ts', sha256: 'e'.repeat(64), bytes: 10 }];
  expect(() => buildCertificationManifest({ slug: SLUG, codeCandidateSha: SHA, artifacts: bad })).toThrow(/not a permitted certification path/);
});

test('rejects an already-dirty tree carrying unexpected paths', () => {
  expect(() =>
    buildCertificationManifest({ slug: SLUG, codeCandidateSha: SHA, artifacts: artifacts(), currentlyDirtyPaths: ['src/money.ts'] })
  ).toThrow(/already dirty/);
});

test('a code_candidate_sha that is not a full 40-hex SHA is rejected', () => {
  expect(() => buildCertificationManifest({ slug: SLUG, codeCandidateSha: 'abc', artifacts: artifacts() })).toThrow(/40-hex/);
});

test('validateCertificationDiff accepts an allowed tail and rejects an extra path', () => {
  const m = buildCertificationManifest({ slug: SLUG, codeCandidateSha: SHA, artifacts: artifacts() });
  const okDiff = validateCertificationDiff(m, [`tasks/builds/${SLUG}/uat-evidence.json`, `tasks/builds/${SLUG}/status.json`]);
  expect(okDiff.ok).toBe(true);
  const badDiff = validateCertificationDiff(m, [`tasks/builds/${SLUG}/uat-evidence.json`, 'src/sneaky.ts']);
  expect(badDiff.ok).toBe(false);
  expect(badDiff.unexpected).toContain('src/sneaky.ts');
});

test('allowed paths cover the durable UAT artifacts', () => {
  const allowed = certificationAllowedPaths(SLUG);
  expect(allowed).toContain(`tasks/builds/${SLUG}/uat-evidence.json`);
  expect(allowed).toContain(`tasks/builds/${SLUG}/uat-report.md`);
});
