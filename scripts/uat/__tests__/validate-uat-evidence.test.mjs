/**
 * validate-uat-evidence.test.mjs
 *
 * Vitest suite for the deterministic UAT evidence validator. Covers every
 * codex-brief §8.6 rejection plus the plan A6/A7/A8 rejections, the
 * uat_enforcement_override rejection, artifact integrity + secret scanning +
 * realpath containment, and RFC 8785 canonicalisation golden vectors.
 *
 * Each rejection test mutates a coherent valid baseline in exactly one way and
 * asserts the specific error CODE appears — so a code can never silently stop
 * firing. A positive test proves the baseline validates clean.
 *
 * Run: npx vitest run scripts/uat/__tests__/validate-uat-evidence.test.mjs
 */

import { describe, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { validateEvidence, inventoryDigest } from '../validate-uat-evidence.mjs';
import { canonicalize, canonicalSha256, digestOf } from '../canonicalize.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

function seal(s) {
  const c = { ...s };
  delete c.digest;
  s.digest = digestOf(c);
  return s;
}
function sealInv(inv) {
  inv.sha256 = inventoryDigest(inv);
  return inv;
}
const H64 = 'a'.repeat(64);
const codes = (r) => r.errors.map((e) => e.code);

function makeValidEvidence() {
  const frozen = '2026-08-01T00:00:00.000Z';
  const aug = '2026-08-01T01:00:00.000Z';
  const scenario = seal({
    id: 'S1',
    origin: 'blind',
    required: true,
    risk_tags: ['refactor-internal'],
    families: ['navigation'],
    status: 'pass',
    fixture_ids: [],
    oracle: 'the changed surface renders',
    anti_vacuity: { branch_marker: 'rendered-v2' },
    evidence: [],
    cleanup: { status: 'not-required' },
  });
  const inv = () => sealInv({ risks: [{ tag: 'refactor-internal', source: 'classifier' }] });
  return {
    schema_version: 'uat-evidence.v1',
    slug: 'demo-build',
    run_id: 'run-1',
    verdict: 'pass',
    applicability: 'applicable',
    enforcement: 'advisory',
    candidate: { head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), runtime_tree_clean: true, submodule_shas: {}, allowed_dirty_paths: [] },
    harness: {
      framework_sha: 'abcdef1',
      codex_skill_sha256: H64,
      validator_sha256: H64,
      classifier_sha256: H64,
      evidence_schema_version: 'uat-evidence.v1',
      harness_manifest_sha256: H64,
      executor_class: 'codex-cli',
      executor_version: '0.144.3',
    },
    planner: { context_id: 'ctx-p', executor_class: 'codex-cli', version: '0.144.3', model: 'gpt-x', fresh_thread: true, blind_runtime_config_sha256: H64 },
    execution: { context_id: 'ctx-e', executor_class: 'codex-cli', version: '0.144.3', model: 'gpt-x' },
    plan_digests: { blind_plan_sha256: H64, input_manifest_sha256: H64, expected_plan_sha256: H64, executed_plan_sha256: H64 },
    blind_scenario_ids: ['S1'],
    risk_baseline: inv(),
    risk_inventory_at_execution_start: inv(),
    risk_inventory_final: inv(),
    environment: { kind: 'local-disposable', database: 'pg', migration_head: '0001', browser: 'chromium', timezone: 'UTC' },
    capabilities: [],
    scenarios: [scenario],
    timestamps: { blind_plan_frozen_at: frozen, augmentation_started_at: aug, execution_started_at: aug, completed_at: aug },
    secrets_redacted: true,
  };
}

// money-precision fixture with all 9 (or 8) required families covered.
function makeMoneyEvidence({ omitIdentity = false } = {}) {
  const families = [
    'exact-zero', 'dust', 'exponent-forms', 'negative-values', 'above-2-53',
    'zero-decimal-currencies', 'fx-fallback', 'display-execution-separation',
    'aggregate-to-route-to-screen-identity',
  ];
  const used = omitIdentity ? families.filter((f) => f !== 'aggregate-to-route-to-screen-identity') : families;
  const scenarios = used.map((f, i) =>
    seal({
      id: `M${i}`,
      origin: i === 0 ? 'blind' : 'augmentation',
      required: true,
      risk_tags: ['money-precision'],
      families: [f],
      status: 'pass',
      fixture_ids: [],
      oracle: 'exact identity',
      anti_vacuity: { observed_record_count: 3, seeded_value: '9007199254820993' },
      evidence: [],
      cleanup: { status: 'not-required' },
    })
  );
  const inv = () => sealInv({ risks: [{ tag: 'money-precision', source: 'classifier' }] });
  const base = makeValidEvidence();
  return {
    ...base,
    scenarios,
    blind_scenario_ids: ['M0'],
    risk_baseline: inv(),
    risk_inventory_at_execution_start: inv(),
    risk_inventory_final: inv(),
  };
}

function clone(o) { return structuredClone(o); }

// ── positive baseline ────────────────────────────────────────────────────────

test('valid evidence passes clean', () => {
  const r = validateEvidence(makeValidEvidence());
  expect(r.ok, JSON.stringify(r.errors)).toBe(true);
});

test('valid money-precision evidence with full family coverage passes', () => {
  const r = validateEvidence(makeMoneyEvidence());
  expect(r.ok, JSON.stringify(r.errors)).toBe(true);
});

// ── override rejection (plan A2/A3) ──────────────────────────────────────────

describe('uat_enforcement_override is always rejected', () => {
  test('top-level override field', () => {
    const e = clone(makeValidEvidence());
    e.uat_enforcement_override = { operator: 'x', reason: 'y' };
    expect(codes(validateEvidence(e))).toContain('OVERRIDE_FIELD_PRESENT');
  });
  test('nested override field', () => {
    const e = clone(makeValidEvidence());
    e.execution.uat_enforcement_override = true;
    expect(codes(validateEvidence(e))).toContain('OVERRIDE_FIELD_PRESENT');
  });
});

// ── verdict / applicability (brief §8.6) ─────────────────────────────────────

test('non-applicable with non-proceed verdict is rejected', () => {
  const e = clone(makeValidEvidence());
  e.applicability = 'non-applicable';
  e.applicability_reason = 'docs only';
  e.verdict = 'pass';
  expect(codes(validateEvidence(e))).toContain('APPLICABILITY_VERDICT_MISMATCH');
});

test('proceed without a reason is rejected', () => {
  const e = clone(makeValidEvidence());
  e.verdict = 'proceed';
  e.applicability = 'non-applicable';
  delete e.applicability_reason;
  expect(codes(validateEvidence(e))).toContain('PROCEED_WITHOUT_REASON');
});

test('proceed while applicable is rejected', () => {
  const e = clone(makeValidEvidence());
  e.verdict = 'proceed';
  e.applicability = 'applicable';
  e.applicability_reason = 'na';
  expect(codes(validateEvidence(e))).toContain('PROCEED_WHEN_APPLICABLE');
});

// ── pass preconditions (brief §8.6) ──────────────────────────────────────────

test('pass with a failed required scenario is rejected', () => {
  const e = clone(makeValidEvidence());
  e.scenarios[0].status = 'fail';
  seal(e.scenarios[0]);
  expect(codes(validateEvidence(e))).toContain('PASS_WITH_FAILED_SCENARIO');
});

test('pass with a skipped required scenario is rejected', () => {
  const e = clone(makeValidEvidence());
  e.scenarios[0].status = 'skipped';
  seal(e.scenarios[0]);
  expect(codes(validateEvidence(e))).toContain('PASS_WITH_SKIPPED_REQUIRED');
});

test('pass with an incomplete required scenario is rejected', () => {
  const e = clone(makeValidEvidence());
  e.scenarios[0].status = 'incomplete';
  seal(e.scenarios[0]);
  expect(codes(validateEvidence(e))).toContain('PASS_WITH_INCOMPLETE_SCENARIO');
});

test('pass with a missing required capability is rejected', () => {
  const e = clone(makeValidEvidence());
  e.capabilities = [{ name: 'disposable-db', required: true, available: false }];
  expect(codes(validateEvidence(e))).toContain('PASS_MISSING_CAPABILITY');
});

test('pass with an abbreviated head SHA is rejected', () => {
  const e = clone(makeValidEvidence());
  e.candidate.head_sha = 'abc1234';
  expect(codes(validateEvidence(e))).toContain('PASS_ABBREVIATED_SHA');
});

test('pass with an unclean runtime tree is rejected', () => {
  const e = clone(makeValidEvidence());
  e.candidate.runtime_tree_clean = false;
  expect(codes(validateEvidence(e))).toContain('PASS_UNCLEAN_TREE');
});

test('pass claiming a browser lane while browser capability is absent is rejected', () => {
  const e = clone(makeValidEvidence());
  e.capabilities = [{ name: 'browser', required: false, available: false }];
  e.scenarios[0].risk_tags = ['ui-browser'];
  seal(e.scenarios[0]);
  expect(codes(validateEvidence(e))).toContain('PASS_BROWSER_CLAIM_WITHOUT_CAPABILITY');
});

// ── anti-vacuity (plan A8 / invariant 6) ─────────────────────────────────────

test('applicable passing scenario with no anti-vacuity proof is rejected', () => {
  const e = clone(makeValidEvidence());
  e.scenarios[0].anti_vacuity = {};
  seal(e.scenarios[0]);
  expect(codes(validateEvidence(e))).toContain('MISSING_ANTI_VACUITY');
});

test('data-requiring family with zero records and no seed is rejected as vacuous', () => {
  const e = clone(makeValidEvidence());
  e.scenarios[0].families = ['success'];
  e.scenarios[0].anti_vacuity = { branch_marker: 'x' };
  seal(e.scenarios[0]);
  expect(codes(validateEvidence(e))).toContain('VACUOUS_DATA_SCENARIO');
});

// ── scenario digest + set invariant (plan A6) ────────────────────────────────

test('a tampered scenario (digest not recomputed) is rejected', () => {
  const e = clone(makeValidEvidence());
  e.scenarios[0].oracle = 'silently changed after sealing';
  expect(codes(validateEvidence(e))).toContain('SCENARIO_DIGEST_MISMATCH');
});

test('a deleted blind scenario is rejected', () => {
  const e = clone(makeValidEvidence());
  e.blind_scenario_ids = ['S1', 'S-DELETED'];
  expect(codes(validateEvidence(e))).toContain('BLIND_SCENARIO_DELETED');
});

test('a downgraded blind scenario (required->optional) is rejected', () => {
  const e = clone(makeValidEvidence());
  e.scenarios[0].required = false;
  seal(e.scenarios[0]);
  expect(codes(validateEvidence(e))).toContain('BLIND_SCENARIO_DOWNGRADED');
});

test('a non-executed blind scenario is rejected', () => {
  const e = clone(makeValidEvidence());
  e.verdict = 'fail'; // isolate from pass-precondition checks
  e.scenarios[0].status = 'skipped';
  seal(e.scenarios[0]);
  expect(codes(validateEvidence(e))).toContain('BLIND_SCENARIO_NOT_EXECUTED');
});

// ── risk inventories (plan A8) ───────────────────────────────────────────────

test('a corrupted risk-inventory hash is rejected', () => {
  const e = clone(makeValidEvidence());
  e.risk_inventory_at_execution_start.sha256 = 'f'.repeat(64);
  expect(codes(validateEvidence(e))).toContain('RISK_INVENTORY_HASH_MISMATCH');
});

test('dropping a baseline risk from the start inventory is rejected', () => {
  const e = clone(makeValidEvidence());
  e.risk_baseline = sealInv({ risks: [{ tag: 'refactor-internal', source: 'classifier' }, { tag: 'money-precision', source: 'classifier' }] });
  // start/final keep only refactor-internal -> not a superset of baseline
  expect(codes(validateEvidence(e))).toContain('RISK_START_NOT_SUPERSET_OF_BASELINE');
});

test('a final inventory that is not a superset of start is rejected', () => {
  const e = clone(makeValidEvidence());
  e.risk_inventory_at_execution_start = sealInv({ risks: [{ tag: 'refactor-internal', source: 'classifier' }, { tag: 'auth-tenant', source: 'tester' }] });
  // final keeps only refactor-internal -> not a superset of start
  expect(codes(validateEvidence(e))).toContain('RISK_FINAL_NOT_SUPERSET_OF_START');
});

// ── coverage cross-check (plan A8 — the omitted-mandatory-family kill) ────────

test('money-precision omitting the aggregate-to-route identity family is rejected', () => {
  const r = validateEvidence(makeMoneyEvidence({ omitIdentity: true }));
  expect(r.ok).toBe(false);
  const missing = r.errors.filter((e) => e.code === 'COVERAGE_MISSING_FAMILY');
  expect(missing.some((e) => e.message.includes('aggregate-to-route-to-screen-identity'))).toBe(true);
});

// ── timestamps (plan A6) ─────────────────────────────────────────────────────

test('augmentation starting before the blind freeze is rejected', () => {
  const e = clone(makeValidEvidence());
  e.timestamps.augmentation_started_at = e.timestamps.blind_plan_frozen_at;
  expect(codes(validateEvidence(e))).toContain('AUGMENTATION_BEFORE_FREEZE');
});

// ── plan-digest identity (plan A6, round-4 finding 6) ─────────────────────────

test('expected != executed plan digest is rejected', () => {
  const e = clone(makeValidEvidence());
  e.plan_digests.executed_plan_sha256 = 'c'.repeat(64);
  expect(codes(validateEvidence(e))).toContain('PLAN_DIGEST_HANDOFF_MISMATCH');
});

test('blind-plan digest mismatch against the supplied blind plan is rejected', () => {
  const e = clone(makeValidEvidence());
  const blindPlan = { scenarios: [{ id: 'S1' }] };
  // digest of blindPlan won't equal the H64 placeholder in e.plan_digests
  expect(codes(validateEvidence(e, { blindPlan }))).toContain('BLIND_PLAN_DIGEST_MISMATCH');
});

// ── artifact integrity + containment + secret scan (plan A8) ─────────────────

function tmpRepo() {
  return mkdtempSync(path.join(os.tmpdir(), 'uat-ev-'));
}
function evidenceWithArtifact(artifact) {
  const e = clone(makeValidEvidence());
  e.scenarios[0].evidence = [artifact];
  seal(e.scenarios[0]);
  return e;
}

test('artifact hash mismatch is rejected', () => {
  const root = tmpRepo();
  writeFileSync(path.join(root, 'shot.txt'), 'real content');
  const bytes = Buffer.byteLength('real content');
  const e = evidenceWithArtifact({ path: 'shot.txt', sha256: 'd'.repeat(64), bytes, media_type: 'text/plain', redaction_status: 'not-required' });
  const r = validateEvidence(e, { repoRoot: root, allowedRoots: [root] });
  expect(codes(r)).toContain('ARTIFACT_HASH_MISMATCH');
});

test('artifact byte-length mismatch is rejected', () => {
  const root = tmpRepo();
  const content = 'real content';
  writeFileSync(path.join(root, 'shot.txt'), content);
  const sha = createHash('sha256').update(content).digest('hex');
  const e = evidenceWithArtifact({ path: 'shot.txt', sha256: sha, bytes: 999, media_type: 'text/plain', redaction_status: 'not-required' });
  const r = validateEvidence(e, { repoRoot: root, allowedRoots: [root] });
  expect(codes(r)).toContain('ARTIFACT_BYTES_MISMATCH');
});

test('a missing cited artifact fails a pass', () => {
  const root = tmpRepo();
  const e = evidenceWithArtifact({ path: 'nope.txt', sha256: H64, bytes: 1, media_type: 'text/plain', redaction_status: 'not-required' });
  const r = validateEvidence(e, { repoRoot: root, allowedRoots: [root] });
  expect(codes(r)).toContain('ARTIFACT_MISSING');
});

test('an artifact path escaping the allowed roots is rejected', () => {
  const root = tmpRepo();
  const e = evidenceWithArtifact({ path: '../escape.txt', sha256: H64, bytes: 1, media_type: 'text/plain', redaction_status: 'not-required' });
  const r = validateEvidence(e, { repoRoot: root, allowedRoots: [root] });
  expect(codes(r)).toContain('ARTIFACT_PATH_ESCAPE');
});

test('a seeded secret in a textual artifact is detected', () => {
  const root = tmpRepo();
  const content = 'log line\nAKIAIOSFODNN7EXAMPLE was used\n';
  writeFileSync(path.join(root, 'trace.log'), content);
  const sha = createHash('sha256').update(content).digest('hex');
  const e = evidenceWithArtifact({ path: 'trace.log', sha256: sha, bytes: Buffer.byteLength(content), media_type: 'text/plain', redaction_status: 'redacted' });
  const r = validateEvidence(e, { repoRoot: root, allowedRoots: [root] });
  expect(codes(r)).toContain('SECRET_DETECTED');
});

test('a secret embedded in the evidence document is detected', () => {
  const e = clone(makeValidEvidence());
  e.notes = ['db is postgres://user:hunter2@db.internal:5432/app'];
  expect(codes(validateEvidence(e))).toContain('SECRET_DETECTED');
});

// ── RFC 8785 (JCS) golden vectors ────────────────────────────────────────────

describe('RFC 8785 canonicalisation golden vectors', () => {
  test('object keys sort by UTF-16 code units', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // "A"(0x41) < "a"(0x61) < "ü"(0xFC); ü stays literal (UTF-8, not escaped)
    expect(canonicalize({ 'ü': 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"ü":1}');
  });
  test('numbers use the ECMAScript Number-to-String form', () => {
    expect(canonicalize(1.0)).toBe('1');
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(1e21)).toBe('1e+21');
    expect(canonicalize({ n: 100 })).toBe('{"n":100}');
  });
  test('arrays preserve order; nested objects recurse and sort', () => {
    expect(canonicalize({ z: [3, 1, 2], a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"z":[3,1,2]}');
  });
  test('non-finite numbers are rejected', () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
  });
  test('digest excludes the named self field and is stable', () => {
    const obj = { id: 'x', v: 1 };
    const d = canonicalSha256(obj);
    expect(digestOf({ ...obj, digest: 'PLACEHOLDER' }, ['digest'])).toBe(d);
    // key order does not change the digest
    expect(canonicalSha256({ v: 1, id: 'x' })).toBe(d);
  });
});
