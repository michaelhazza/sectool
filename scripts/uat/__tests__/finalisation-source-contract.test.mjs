/**
 * finalisation-source-contract.test.mjs — R2.4 source-contract assertions.
 *
 * The finalisation coordinator is a prose playbook, so its ordering/enforcement
 * invariants are verified against the SOURCE text plus the manifest and schema:
 * acceptance runs after G5 and before Step 9; no ready-to-merge before a valid
 * UAT gate; the enforcement-conditional transitions; shadow writes advisories,
 * never the blocker field; refusal rows 9-10 with grep-able literals; the
 * certification tail + expected-remote-head precondition; the disabled default;
 * the gate_evidence schema delta; and manifest coverage of every UAT file (so a
 * consumer sync WOULD deliver the machinery). The full temp-consumer sync e2e
 * is plan §9 forward validation (out of scope this session); manifest coverage
 * is its mechanical proxy here.
 *
 * Run: npx vitest run scripts/uat/__tests__/finalisation-source-contract.test.mjs
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const coord = read('.claude/agents/finalisation-coordinator.md');

describe('finalisation ordering', () => {
  test('Step 8c.5 exists and sits AFTER Step 8c and BEFORE Step 9', () => {
    const i8c = coord.indexOf('## Step 8c —');
    const i8c5 = coord.indexOf('## Step 8c.5 —');
    const i9 = coord.indexOf('## Step 9 —');
    expect(i8c).toBeGreaterThan(-1);
    expect(i8c5).toBeGreaterThan(i8c);
    expect(i9).toBeGreaterThan(i8c5);
  });
  test('no ready-to-merge label before G5 green AND acceptance valid', () => {
    expect(coord).toMatch(/\(label apply\) is unreachable until G5 reports green AND Step 8c\.5/);
    expect(coord).toContain('no runtime edit is permitted before the label');
  });
});

describe('enforcement-conditional transitions + shadow surfacing', () => {
  test('enforcement is the single downstream control, not rollout mode', () => {
    expect(coord).toMatch(/enforcement.*is the single downstream control/i);
    expect(coord).toContain('never read `uat_rollout_mode` here directly');
  });
  test('shadow fail/incomplete writes uat_advisories, NEVER the blocker field', () => {
    expect(coord).toContain('uat_advisories');
    expect(coord).toMatch(/NEVER a `status\.json\.blockers\[\]` entry/);
  });
  test('blocking fail back-edges FINALISING -> TESTING; incomplete halts without label', () => {
    expect(coord).toContain('FINALISING → TESTING');
    expect(coord).toMatch(/halt without applying the merge-ready label/);
  });
});

describe('refusal rows 9-10 with grep-able literals', () => {
  test('row 9 literal + override rejection', () => {
    expect(coord).toContain('MERGE-REFUSAL-ROW-9');
    expect(coord).toContain('uat_enforcement_override');
    expect(coord).toMatch(/field anywhere in the evidence is a hard refusal/);
  });
  test('row 10 literal + certification tail + base-freshness iff blocking', () => {
    expect(coord).toContain('MERGE-REFUSAL-ROW-10');
    expect(coord).toContain('certification-commit-manifest.json');
    expect(coord).toMatch(/only when `enforcement: blocking`/);
    expect(coord).toMatch(/telemetry only and NEVER refuses/);
  });
  test('the table is described as 10 rows / rows 1-10', () => {
    expect(coord).toContain('On ANY refusal (rows 1-10)');
    expect(coord).toContain('rows 9-10');
  });
});

describe('candidate/certification identity + expected-remote-head precondition', () => {
  test('code_candidate_sha vs certification_head_sha, derived not self-referenced', () => {
    expect(coord).toContain('code_candidate_sha = X');
    expect(coord).toContain('certification_head_sha = Y');
    expect(coord).toMatch(/no committed file contains its own commit SHA/);
  });
  test('merge carries the --match-head-commit expected-remote-head precondition (always)', () => {
    expect(coord).toContain('--match-head-commit');
    expect(coord).toMatch(/Expected-remote-head precondition \(always/);
  });
});

describe('disabled default + cleanup', () => {
  test('Step 8c.5 skips on uat_rollout_mode disabled/absent', () => {
    expect(coord).toMatch(/absent key = `disabled`/);
    expect(coord).toContain('Step 8c.5 skipped — uat_rollout_mode: disabled.');
  });
  test('Step 12.6 post-merge/post-abort scratch cleanup keeps binding evidence', () => {
    expect(coord).toContain('## Step 12.6');
    expect(coord).toContain('.test-runs/<slug>-uat/<run_id>/');
    expect(coord).toContain('Binding evidence');
    expect(coord).toContain('DURABLE');
  });
});

describe('gate_evidence schema delta', () => {
  test('build-status.schema.json carries the UAT merge-control projection', () => {
    const schema = JSON.parse(read('schemas/build-status.schema.json'));
    const props = schema.properties.gate_evidence.additionalProperties.properties;
    expect(props).toHaveProperty('evidence_sha256');
    expect(props).toHaveProperty('code_candidate_sha');
    expect(props).toHaveProperty('enforcement');
    expect(props.enforcement.enum).toEqual(['advisory', 'blocking']);
    // required set is UNCHANGED (additive, backward-compatible)
    expect(schema.properties.gate_evidence.additionalProperties.required).toEqual(['sha', 'run_ids', 'url', 'completed_at']);
  });
  test('project-registries template ships uat_rollout_mode = disabled', () => {
    const tpl = JSON.parse(read('.claude/project-registries.json.template'));
    expect(tpl.uat_rollout_mode).toBe('disabled');
  });
});

describe('manifest coverage (a consumer sync WOULD deliver the machinery)', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const paths = new Set(manifest.managedFiles.map((e) => e.path));
  const required = [
    'scripts/uat/canonicalize.mjs',
    'scripts/uat/validate-uat-evidence.mjs',
    'scripts/uat/classify-change.mjs',
    'scripts/uat/enforcement.mjs',
    'scripts/uat/build-blind-snapshot.mjs',
    'scripts/uat/build-harness-manifest.mjs',
    'scripts/uat/build-certification-manifest.mjs',
    'scripts/uat/install-codex-skill.mjs',
    'scripts/uat/risk-to-scenario-policy.json',
    'references/blind-planner-runtime.md',
    'templates/codex-skills/run-final-uat/SKILL.md',
    '.claude/skills/acceptance-testing/SKILL.md',
  ];
  test.each(required)('manifest manages %s', (p) => {
    expect(paths.has(p)).toBe(true);
  });
  test('schemas ship via the schemas/*.json glob', () => {
    expect(paths.has('schemas/*.json')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// framework-status-sync-hardening — W6 handover contract + D2 quoted-run-id.
//
// These are TELL-side assertions: they prove the playbook INSTRUCTS the agent
// to write a complete handover and to quote run ids. The PROVE side (a merged
// build actually HAS a handover, a written record is actually valid) is the
// build-instance layer — sync-status --require-handover and its own tests.
// Both layers exist because instruction-level alone repeats the exact
// tell-vs-prove gap this build closed.
// ---------------------------------------------------------------------------

describe('W6 post-merge handover contract (finalisation playbook)', () => {
  test('the fixed heading and all three subheads are present', () => {
    expect(coord).toContain('## Post-merge handover');
    expect(coord).toContain('**What was built**');
    expect(coord).toContain('**To enable / configure**');
    expect(coord).toContain('**Urgent follow-on engineering**');
  });

  test('all three mandated empty-state literals are present verbatim (no em-dashes)', () => {
    expect(coord).toContain('None: live on deploy.');
    expect(coord).toContain('None urgent: {N} routine item(s) in the backlog.');
    expect(coord).toContain('None: no follow-on items.');
    // The empty-state literals are operator-facing text, so they must not use
    // em-dashes (the standing copy rule). Guard against a regression.
    expect(coord).not.toContain('None — live on deploy.');
  });

  test('the machine-auditable triage ledger subsection is defined with per-item verdicts', () => {
    expect(coord).toContain('### Follow-on triage');
    expect(coord).toContain('urgent-now');
    expect(coord).toContain('routine');
  });

  test('the handover is enforced at write time by --require-handover', () => {
    expect(coord).toContain('--require-handover');
  });
});

describe('W4 — resolver invocations never reconstruct event identity', () => {
  // Rounds 3-5 all produced the same defect: a caller re-deriving which event
  // counts. A recovery command hardcoding `--trigger-class push` ignores a
  // pull_request-triggered repo's real CI and reports NO_RUN instead of the
  // true verdict. Every playbook invocation must use --configured, so the
  // resolver reads the declared workflow + trigger itself.
  const invocations = coord.match(/node scripts\/ci\/resolve-authoritative-checks\.mjs[^\n`]*/g) ?? [];

  test('the playbook actually invokes the resolver', () => {
    expect(invocations.length).toBeGreaterThan(0);
  });

  test('no invocation hardcodes a trigger class or workflow', () => {
    for (const inv of invocations) {
      expect(inv, `hardcoded trigger in: ${inv}`).not.toContain('--trigger-class');
      expect(inv, `hardcoded workflow in: ${inv}`).not.toContain('--workflow');
    }
  });

  test('every invocation uses --configured', () => {
    for (const inv of invocations) {
      expect(inv, `missing --configured in: ${inv}`).toContain('--configured');
    }
  });
});

describe('D2 — no producer example shows an unquoted run id', () => {
  const files = [
    '.claude/agents/finalisation-coordinator.md',
    '.claude/agents/feature-coordinator.md',
    '.claude/agents/spec-coordinator.md',
  ];
  // A run_ids literal whose FIRST array element is a bare number, e.g.
  // `"run_ids": [32310798762]` or `"run_ids": [ 12345, ...]`. The quoted form
  // `"run_ids": ["32310798762"]` must NOT match. This is the exact D2 shape.
  const UNQUOTED_RUN_ID = /"run_ids"\s*:\s*\[\s*\d/;
  test.each(files)('%s has no unquoted run_ids example', (f) => {
    expect(UNQUOTED_RUN_ID.test(read(f))).toBe(false);
  });
  test('the finalisation playbook states run_ids items are strings', () => {
    expect(coord).toMatch(/run_ids.{0,40}STRING/i);
  });
});
