/**
 * validate-packet.test.mjs
 *
 * Proves acceptance §13.1: work-packet.example.json and the two
 * completion-packet fixtures (claude, openclaw) are schema-valid, and the
 * two completion fixtures are structurally comparable — same required keys,
 * same packet_id — differing only in runtime/commit_sha/changed_files
 * values.
 *
 * The Ajv-available path is exercised by the default `loadWithAjv` describe
 * block (Ajv is installed in this repo); `loadWithoutAjv` forces the
 * structural-floor path with vi.doMock + resetModules, matching the pattern
 * in scripts/status/status-contract.test.mjs.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  FLOOR_UNCOVERED_LEGACY_PATHS,
  POLICY_ENUMS,
  POLICY_KEYS,
  POLICY_PATH_KEYS,
  RELEASE_EVIDENCE_KEYS,
  SEMANTICALLY_COVERED_PATHS,
  isRfc3339DateTime,
} from './packet-semanticsPure.mjs';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, name), 'utf8'));
}

/** A fresh copy of the module with `import('ajv')` forced to fail. */
async function loadWithoutAjv() {
  vi.resetModules();
  vi.doMock('ajv', () => {
    throw new Error('Cannot find module ajv');
  });
  return import('./validate-packet.mjs');
}

/** A fresh copy with Ajv left alone. */
async function loadWithAjv() {
  vi.resetModules();
  vi.doUnmock('ajv');
  return import('./validate-packet.mjs');
}

describe.each([
  ['Ajv available', loadWithAjv],
  ['Ajv unavailable (structural floor)', loadWithoutAjv],
])('validatePacket — %s', (_label, load) => {
  it('accepts the work-packet fixture', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('work-packet.example.json');
    const result = await validatePacket('work', packet);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts both completion-packet fixtures', async () => {
    const { validatePacket } = await load();
    const claude = await loadFixture('completion-packet.claude.json');
    const openclaw = await loadFixture('completion-packet.openclaw.json');
    expect((await validatePacket('completion', claude)).ok).toBe(true);
    expect((await validatePacket('completion', openclaw)).ok).toBe(true);
  });

  it('rejects a work packet missing a required key', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('work-packet.example.json');
    delete packet.objective;
    const result = await validatePacket('work', packet);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a completion packet with a bad status enum', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.status = 'DONE'; // not in the SUCCESS|PLAN_GAP|G1_FAILED enum
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('rejects a completion packet missing a required key', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    delete packet.summary;
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object packet instead of throwing', async () => {
    const { validatePacket } = await load();
    for (const value of [null, 'a string', 42, []]) {
      const result = await validatePacket('work', value);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects an unknown packet kind instead of throwing', async () => {
    const { validatePacket } = await load();
    const result = await validatePacket('bogus', {});
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------
  // execution_policy — every case below must produce the SAME verdict with
  // and without Ajv. The structural floor reads only top-level
  // required/enum/const, so these all rely on the shared semantic layer;
  // running them inside describe.each is what proves fallback mode is not a
  // hole in a security-shaped contract.
  // ---------------------------------------------------------------------

  it('accepts a work packet carrying a well-formed execution_policy', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('work-packet.example.json');
    packet.execution_policy = {
      write_scope: ['scripts/**'],
      protected_paths: ['schemas/**'],
      destructive_actions: 'forbidden',
      credential_access: 'none',
      network_egress: 'none',
      deploy_authority: false,
    };
    const result = await validatePacket('work', packet);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['deploy_authority: true', { deploy_authority: true }],
    ['a bare {} policy', {}],
    ['allowlist mode with no allowlist', { network_egress: 'allowlist' }],
    ['allowlist mode with an empty allowlist', { network_egress: 'allowlist', egress_allowlist: [] }],
    ['an allowlist without allowlist mode', { network_egress: 'none', egress_allowlist: ['api.github.com'] }],
    ['allowed_files inside the policy', { allowed_files: ['server/**'] }],
    ['an absolute write_scope pattern', { write_scope: ['/etc/passwd'] }],
    ['an upward-traversing write_scope pattern', { write_scope: ['../outside/**'] }],
    ['a duplicated write_scope entry', { write_scope: ['server/**', 'server/**'] }],
    ['an out-of-enum credential_access', { credential_access: 'write' }],
    ['a non-date expires_at', { expires_at: 'whenever' }],
    ['a date-only expires_at', { expires_at: '2026-01-01' }],
    ['an expires_at with no timezone', { expires_at: '2026-08-03T12:00:00' }],
    ['an impossible calendar day in expires_at', { expires_at: '2026-02-31T00:00:00Z' }],
    // Undeclared keys are the fallback-mode hole: the schema closes them with
    // additionalProperties: false, which the structural floor never reads.
    ['an undeclared policy field', { deploy_authority: false, shell_access: 'unrestricted' }],
    ['an undeclared field aliasing deploy authority', { may_deploy: true }],
  ])('rejects a work packet with %s', async (_label, execution_policy) => {
    const { validatePacket } = await load();
    const packet = await loadFixture('work-packet.example.json');
    packet.execution_policy = execution_policy;
    const result = await validatePacket('work', packet);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts a completion packet echoing a policy with its hash', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.effective_policy = { allowed_files: ['scripts/**'], write_scope: ['scripts/**'] };
    packet.effective_policy_hash = 'a'.repeat(64);
    packet.policy_evaluation = 'passed';
    packet.policy_violations = [];
    const result = await validatePacket('completion', packet);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a non-hex policy hash', { effective_policy_hash: 'not-a-digest' }],
    ['an uppercase policy hash', { effective_policy_hash: 'A'.repeat(64) }],
    ['violated with no violations listed', { policy_evaluation: 'violated', policy_violations: [] }],
    [
      'violations listed but evaluation passed',
      { policy_evaluation: 'passed', policy_violations: ['wrote outside write_scope'] },
    ],
    [
      'violations listed but evaluation not_evaluated',
      { policy_evaluation: 'not_evaluated', policy_violations: ['wrote outside write_scope'] },
    ],
    ['a contradictory echoed policy', { effective_policy: { network_egress: 'none', egress_allowlist: ['x'] } }],
    ['a bare {} echoed policy', { effective_policy: {} }],
    ['an undeclared field in the echoed policy', { effective_policy: { write_scope: ['a/**'], shell_access: 'all' } }],
    ['violated with policy_violations omitted entirely', { policy_evaluation: 'violated' }],
    // Array CONTENTS are invisible to the structural floor.
    [
      'a non-string policy violation',
      { policy_evaluation: 'violated', policy_violations: [42] },
    ],
    [
      'an empty-string policy violation',
      { policy_evaluation: 'violated', policy_violations: [''] },
    ],
    [
      'duplicate policy violations',
      { policy_evaluation: 'violated', policy_violations: ['wrote outside scope', 'wrote outside scope'] },
    ],
    ['an empty doc_exemption_reason', { doc_exemption_reason: '' }],
    ['duplicate egress hosts', { effective_policy: { network_egress: 'allowlist', egress_allowlist: ['a.example', 'a.example'] } }],
  ])('rejects a completion packet with %s', async (_label, patch) => {
    const { validatePacket } = await load();
    const packet = { ...(await loadFixture('completion-packet.claude.json')), ...patch };
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // release_evidence and documentation_impact — same dual-mode requirement.
  // ---------------------------------------------------------------------

  it('accepts release evidence with a canary backed by evidence paths', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.release_evidence = {
      release_control_id: 'rc-2026-08-03-01',
      canary_result: 'pass',
      evidence_paths: ['tasks/builds/demo/canary.log'],
    };
    const result = await validatePacket('completion', packet);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts a SUCCESS completion carrying a failed canary', async () => {
    // Canaries run after the work completes; attaching the observation must
    // not force a status rewrite. The release gate decides what it means.
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.status = 'SUCCESS';
    packet.release_evidence = {
      canary_result: 'fail',
      evidence_paths: ['tasks/builds/demo/canary.log'],
    };
    expect((await validatePacket('completion', packet)).ok).toBe(true);
  });

  it.each([
    ['an empty release_evidence object', { release_evidence: {} }],
    [
      'an undeclared release_evidence field',
      { release_evidence: { release_control_id: 'rc-1', deployed_by: 'nobody' } },
    ],
    ['an empty release_control_id', { release_evidence: { release_control_id: '' } }],
    [
      'a non-string evidence path',
      { release_evidence: { canary_result: 'pass', evidence_paths: [42] } },
    ],
    [
      'an empty-string evidence path',
      { release_evidence: { canary_result: 'pass', evidence_paths: [''] } },
    ],
    [
      'duplicate evidence paths',
      { release_evidence: { evidence_paths: ['same.log', 'same.log'] } },
    ],
    ['a passing canary with no evidence', { release_evidence: { canary_result: 'pass' } }],
    [
      'a failing canary with empty evidence',
      { release_evidence: { canary_result: 'fail', evidence_paths: [] } },
    ],
    ['an out-of-enum canary result', { release_evidence: { canary_result: 'flaky' } }],
  ])('rejects a completion packet with %s', async (_label, patch) => {
    const { validatePacket } = await load();
    const packet = { ...(await loadFixture('completion-packet.claude.json')), ...patch };
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate changed_docs entries', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.changed_files = ['docs/a.md'];
    packet.changed_docs = ['docs/a.md', 'docs/a.md'];
    packet.documentation_impact = 'reference';
    expect((await validatePacket('completion', packet)).ok).toBe(false);
  });

  it('rejects changed_docs that are not part of changed_files', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.changed_files = ['scripts/a.mjs'];
    packet.changed_docs = ['docs/never-touched.md'];
    packet.documentation_impact = 'reference';
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('subset'))).toBe(true);
  });

  it('rejects a non-none documentation impact with no documents listed', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.documentation_impact = 'how_to';
    packet.changed_docs = [];
    expect((await validatePacket('completion', packet)).ok).toBe(false);
  });

  it('warns without failing when code changed and no doc exemption is stated', async () => {
    // Advisory by design: documentation judgement is not mechanically
    // decidable, and failing here would make an optional field mandatory.
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.changed_files = ['scripts/packet-contract/validate-packet.mjs'];
    packet.documentation_impact = 'none';
    delete packet.doc_exemption_reason;
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('doc_exemption_reason');
  });

  it('stays silent when the exemption reason is supplied', async () => {
    const { validatePacket } = await load();
    const packet = await loadFixture('completion-packet.claude.json');
    packet.changed_files = ['scripts/packet-contract/validate-packet.mjs'];
    packet.documentation_impact = 'none';
    packet.doc_exemption_reason = 'Internal helper with no documented behaviour.';
    const result = await validatePacket('completion', packet);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('still accepts packets authored before the policy fields existed', async () => {
    // Frozen pre-2.63.0 shapes. The additive-compatibility proof: a consuming
    // repo's existing packets must not become invalid the moment this syncs.
    const { validatePacket } = await load();
    const legacyWork = {
      contract_version: 'work-packet.v1',
      packet_id: 'wp-legacy-0001',
      feature_slug: 'legacy-build',
      repo: 'claude-code-framework',
      branch: 'claude/legacy',
      objective: 'A packet authored before execution_policy existed.',
      allowed_files: ['scripts/legacy.mjs'],
      role: 'builder',
      runtime: 'claude-code',
    };
    const legacyCompletion = {
      contract_version: 'completion-packet.v1',
      packet_id: 'wp-legacy-0001',
      status: 'SUCCESS',
      role: 'builder',
      runtime: 'claude-code',
      summary: 'A completion authored before the policy echo existed.',
    };
    expect((await validatePacket('work', legacyWork)).ok).toBe(true);
    expect((await validatePacket('completion', legacyCompletion)).ok).toBe(true);
  });
});

describe('execution_policy — duplicated shape and hand-written enums cannot drift', () => {
  const SCHEMA_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'schemas',
  );

  async function loadSchema(name) {
    return JSON.parse(await readFile(path.join(SCHEMA_DIR, name), 'utf8'));
  }

  it('keeps every shared key identical between the two schema copies', async () => {
    // The shape is duplicated because validate-packet.mjs compiles each packet
    // schema standalone; a cross-file $ref would be swallowed by the compile
    // try/catch and silently downgrade the packet to the structural floor.
    const work = await loadSchema('work-packet.schema.json');
    const completion = await loadSchema('completion-packet.schema.json');
    const workPolicy = work.properties.execution_policy;
    const echoPolicy = completion.definitions.executionPolicy;

    for (const [key, subschema] of Object.entries(workPolicy.properties)) {
      expect(echoPolicy.properties[key], `${key} diverged between the two copies`).toEqual(subschema);
    }
    expect(workPolicy.allOf).toEqual(echoPolicy.allOf);
    expect(workPolicy.additionalProperties).toBe(false);
    expect(echoPolicy.additionalProperties).toBe(false);
  });

  it('permits allowed_files as the only divergence', async () => {
    const work = await loadSchema('work-packet.schema.json');
    const completion = await loadSchema('completion-packet.schema.json');
    const workKeys = new Set(Object.keys(work.properties.execution_policy.properties));
    const echoKeys = Object.keys(completion.definitions.executionPolicy.properties);
    const extra = echoKeys.filter((k) => !workKeys.has(k));
    // effective_policy folds in the packet's top-level allowed_files so the
    // echoed object is self-contained; nothing else may differ.
    expect(extra).toEqual(['allowed_files']);
  });

  it('keeps the semantic layer key sets in step with the schema', async () => {
    // These lists are what closes additionalProperties in fallback mode. If a
    // schema key is added without updating them, the new key is silently
    // unvalidated without Ajv — so the drift itself must fail the build.
    const work = await loadSchema('work-packet.schema.json');
    const completion = await loadSchema('completion-packet.schema.json');
    expect([...POLICY_KEYS].sort()).toEqual(
      Object.keys(work.properties.execution_policy.properties).sort(),
    );
    expect(['allowed_files', ...POLICY_KEYS].sort()).toEqual(
      Object.keys(completion.definitions.executionPolicy.properties).sort(),
    );
    expect([...RELEASE_EVIDENCE_KEYS].sort()).toEqual(
      Object.keys(completion.properties.release_evidence.properties).sort(),
    );
  });

  it('mirrors every schema value-constraint in the semantic layer', async () => {
    // The defect class both review rounds found: a schema constraint the
    // structural floor cannot see and the semantic layer forgot to mirror, so
    // the same packet's verdict depends on whether Ajv is installed. Walking
    // the schemas here makes the NEXT such omission a build failure.
    function constrainedPaths(node, path, out) {
      if (!node || typeof node !== 'object') return out;
      const constrained =
        (node.type === 'array' &&
          (node.uniqueItems === true ||
            (node.items && (node.items.minLength !== undefined || node.items.type === 'string')))) ||
        (node.type === 'string' &&
          (node.minLength !== undefined || node.pattern !== undefined || node.format !== undefined));
      if (constrained && path) out.push(path);
      for (const [key, value] of Object.entries(node.properties ?? {})) {
        constrainedPaths(value, path ? `${path}.${key}` : key, out);
      }
      for (const [key, value] of Object.entries(node.definitions ?? {})) {
        constrainedPaths(value, `<${key}>`, out);
      }
      return out;
    }

    const found = [
      ...constrainedPaths(await loadSchema('work-packet.schema.json'), '', []).map((p) => `work:${p}`),
      ...constrainedPaths(await loadSchema('completion-packet.schema.json'), '', []).map(
        (p) => `completion:${p}`,
      ),
    ];
    const accounted = new Set([...SEMANTICALLY_COVERED_PATHS, ...FLOOR_UNCOVERED_LEGACY_PATHS]);
    const unaccounted = found.filter((p) => !accounted.has(p));
    expect(
      unaccounted,
      'schema constraint with no semantic-layer counterpart and no legacy exemption — mirror it in packet-semanticsPure.mjs or add it to FLOOR_UNCOVERED_LEGACY_PATHS with a reason',
    ).toEqual([]);

    // And the lists must not rot in the other direction.
    const foundSet = new Set(found);
    expect([...SEMANTICALLY_COVERED_PATHS, ...FLOOR_UNCOVERED_LEGACY_PATHS].filter((p) => !foundSet.has(p))).toEqual(
      [],
    );
  });

  it('agrees with ajv-formats on date-time validity', async () => {
    // Dual-mode parity for expires_at, checked against the real Ajv format
    // rather than a remembered rule: Date.parse accepts date-only strings,
    // timezone-less strings, and rolls 2026-02-31 into March.
    // The fallback-mode suite registers vi.doMock('ajv'); undo it here or the
    // real module never loads.
    vi.doUnmock('ajv');
    vi.resetModules();
    const { default: Ajv } = await import('ajv');
    const { default: addFormats } = await import('ajv-formats');
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const ajvValid = ajv.compile({ type: 'string', format: 'date-time' });

    const cases = [
      '2026-08-03T12:00:00Z',
      '2026-08-03T12:00:00.123Z',
      '2026-08-03T12:00:00+10:00',
      '2026-08-03T12:00:00-07:30',
      '2026-02-29T00:00:00Z',
      '2024-02-29T00:00:00Z',
      '2026-02-31T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-08-32T00:00:00Z',
      '2026-08-03T24:00:00Z',
      '2026-08-03T12:60:00Z',
      '2026-01-01',
      '2026-08-03T12:00:00',
      'whenever',
      '',
    ];
    for (const value of cases) {
      expect(isRfc3339DateTime(value), `disagreed with ajv on ${JSON.stringify(value)}`).toBe(
        ajvValid(value),
      );
    }
  });

  it('keeps the semantic layer enums in step with the schema', async () => {
    const work = await loadSchema('work-packet.schema.json');
    const policyProps = work.properties.execution_policy.properties;
    for (const [key, allowed] of Object.entries(POLICY_ENUMS)) {
      expect(policyProps[key].enum, `${key} enum drifted from the schema`).toEqual(allowed);
    }
    for (const key of POLICY_PATH_KEYS) {
      const source = key === 'allowed_files' ? work.properties.allowed_files : policyProps[key];
      expect(source, `${key} is not a schema array`).toBeDefined();
      expect(source.type).toBe('array');
    }
  });
});

describe('completion-packet fixtures — structural comparability (§13.1)', () => {
  /** Same sorted key set — the structural-equivalence bar the spec asks for. */
  function structurallyComparable(a, b) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    return keysA.length === keysB.length && keysA.every((k, i) => k === keysB[i]);
  }

  it('share the same packet_id', async () => {
    const claude = await loadFixture('completion-packet.claude.json');
    const openclaw = await loadFixture('completion-packet.openclaw.json');
    expect(claude.packet_id).toBe(openclaw.packet_id);
  });

  it('share the same structural key set', async () => {
    const claude = await loadFixture('completion-packet.claude.json');
    const openclaw = await loadFixture('completion-packet.openclaw.json');
    expect(structurallyComparable(claude, openclaw)).toBe(true);
  });

  it('differ only in runtime, commit_sha, and changed_files values', async () => {
    const claude = await loadFixture('completion-packet.claude.json');
    const openclaw = await loadFixture('completion-packet.openclaw.json');
    const runtimeSpecificKeys = new Set(['runtime', 'commit_sha', 'changed_files']);
    for (const key of Object.keys(claude)) {
      if (runtimeSpecificKeys.has(key)) continue;
      expect(claude[key], `${key} should not diverge`).toEqual(openclaw[key]);
    }
    expect(claude.runtime).not.toEqual(openclaw.runtime);
  });

  it('cannot pass structural comparison while their key sets diverge', async () => {
    // Guards the comparison helper itself: a deliberately divergent clone
    // must fail structurallyComparable, proving the two real fixtures are
    // not "comparable" merely because the helper never fails.
    const claude = await loadFixture('completion-packet.claude.json');
    const divergent = { ...claude };
    delete divergent.commit_sha;
    expect(structurallyComparable(claude, divergent)).toBe(false);
  });
});
