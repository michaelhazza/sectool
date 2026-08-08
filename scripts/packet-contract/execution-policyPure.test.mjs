/**
 * execution-policyPure.test.mjs
 *
 * Proves the composition and hashing contract in references/execution-policy.md.
 * These are SEMANTIC tests: schema validity says a policy is well-formed, this
 * suite says two producers handed the same work packet compute the same
 * effective policy and the same hash. Without that, the completion packet's
 * echo proves nothing.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalizePolicy,
  normalizeExecutionPolicy,
  normalizePathPattern,
} from './execution-policyPure.mjs';

/** Minimal packet carrying just the policy-relevant fields. */
function packet({ allowed_files, execution_policy } = {}) {
  const p = {};
  if (allowed_files !== undefined) p.allowed_files = allowed_files;
  if (execution_policy !== undefined) p.execution_policy = execution_policy;
  return p;
}

describe('normalizePathPattern', () => {
  it.each([
    ['./server/index.ts', 'server/index.ts'],
    ['server//routes//*.ts', 'server/routes/*.ts'],
    ['server/./routes/*.ts', 'server/routes/*.ts'],
    ['server/**', 'server/**'],
    ['**/*.test.ts', '**/*.test.ts'],
    ['docs/{a,b}/*.md', 'docs/{a,b}/*.md'],
    ['src/[ab]*.ts', 'src/[ab]*.ts'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizePathPattern(input)).toEqual({ value: expected, error: null });
  });

  it.each([
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/system32', 'absolute'],
    ['../outside/secrets.env', 'upward'],
    ['server/../../escape', 'upward'],
    ['server\\routes\\*.ts', 'forward slashes'],
    ['src/[ab*.ts', 'unbalanced'],
    ['docs/{a,b/*.md', 'unbalanced'],
    ['src/a]b.ts', 'unbalanced'],
    ['', 'non-empty'],
    [42, 'non-empty'],
  ])('rejects %s', (input, fragment) => {
    const { value, error } = normalizePathPattern(input);
    expect(value).toBeNull();
    expect(error).toContain(fragment);
  });

  it('accepts a pattern that matches nothing in the checkout', () => {
    // write_scope routinely authorizes files that do not exist yet — creating
    // them is most of what a builder does. Only INVALID syntax is an error.
    expect(normalizePathPattern('server/not/created/yet/**').error).toBeNull();
  });
});

describe('normalizeExecutionPolicy — composition matrix', () => {
  it('carries both lists when both are present (conjunction, not merge)', () => {
    const { normalized_policy, errors } = normalizeExecutionPolicy(
      packet({ allowed_files: ['server/**'], execution_policy: { write_scope: ['**/*.test.ts'] } }),
    );
    expect(errors).toEqual([]);
    // Neither list is collapsed into the other: the intersection of these two
    // patterns is not expressible as a pattern.
    expect(normalized_policy).toEqual({
      allowed_files: ['server/**'],
      write_scope: ['**/*.test.ts'],
    });
  });

  it('carries allowed_files alone when no policy is declared', () => {
    const { normalized_policy } = normalizeExecutionPolicy(packet({ allowed_files: ['server/**'] }));
    expect(normalized_policy).toEqual({ allowed_files: ['server/**'] });
  });

  it('carries write_scope alone when allowed_files is absent', () => {
    const { normalized_policy } = normalizeExecutionPolicy(
      packet({ execution_policy: { write_scope: ['docs/**'] } }),
    );
    expect(normalized_policy).toEqual({ write_scope: ['docs/**'] });
  });

  it('returns null policy and null hash when nothing is declared', () => {
    expect(normalizeExecutionPolicy(packet())).toEqual({
      normalized_policy: null,
      effective_policy_hash: null,
      errors: [],
    });
  });

  it('preserves protected_paths alongside the allow lists', () => {
    const { normalized_policy } = normalizeExecutionPolicy(
      packet({
        allowed_files: ['server/**'],
        execution_policy: { protected_paths: ['server/db/schema.ts'] },
      }),
    );
    expect(normalized_policy.protected_paths).toEqual(['server/db/schema.ts']);
  });

  it('distinguishes an empty array ("nothing allowed") from an absent field', () => {
    const empty = normalizeExecutionPolicy(packet({ execution_policy: { write_scope: [] } }));
    const absent = normalizeExecutionPolicy(packet({ execution_policy: { destructive_actions: 'forbidden' } }));
    expect(empty.normalized_policy).toEqual({ write_scope: [] });
    expect(absent.normalized_policy).not.toHaveProperty('write_scope');
    expect(empty.effective_policy_hash).not.toEqual(absent.effective_policy_hash);
  });

  it('carries capability fields through unchanged', () => {
    const { normalized_policy } = normalizeExecutionPolicy(
      packet({
        execution_policy: {
          destructive_actions: 'forbidden',
          credential_access: 'none',
          network_egress: 'allowlist',
          egress_allowlist: ['api.github.com'],
          deploy_authority: false,
          expires_at: '2026-08-03T12:00:00Z',
        },
      }),
    );
    expect(normalized_policy).toEqual({
      destructive_actions: 'forbidden',
      credential_access: 'none',
      network_egress: 'allowlist',
      egress_allowlist: ['api.github.com'],
      deploy_authority: false,
      expires_at: '2026-08-03T12:00:00Z',
    });
  });

  it('reports every malformed pattern at once and yields no policy', () => {
    const { normalized_policy, effective_policy_hash, errors } = normalizeExecutionPolicy(
      packet({ execution_policy: { write_scope: ['/abs/path', '../escape'] } }),
    );
    expect(normalized_policy).toBeNull();
    expect(effective_policy_hash).toBeNull();
    expect(errors).toHaveLength(2);
  });

  it('rejects a non-object packet and a non-object policy without throwing', () => {
    expect(normalizeExecutionPolicy(null).errors).toHaveLength(1);
    expect(normalizeExecutionPolicy('nope').errors).toHaveLength(1);
    expect(normalizeExecutionPolicy({ execution_policy: [] }).errors).toHaveLength(1);
  });
});

describe('normalizeExecutionPolicy — canonical hashing', () => {
  const base = packet({
    allowed_files: ['server/**', 'shared/**'],
    execution_policy: { write_scope: ['**/*.ts'], destructive_actions: 'forbidden' },
  });

  it('is stable across key order in the source object', () => {
    const reordered = {
      execution_policy: { destructive_actions: 'forbidden', write_scope: ['**/*.ts'] },
      allowed_files: ['server/**', 'shared/**'],
    };
    expect(normalizeExecutionPolicy(reordered).effective_policy_hash).toBe(
      normalizeExecutionPolicy(base).effective_policy_hash,
    );
  });

  it('is stable across array order and duplicate entries', () => {
    const shuffled = packet({
      allowed_files: ['shared/**', 'server/**', 'server/**'],
      execution_policy: { write_scope: ['**/*.ts'], destructive_actions: 'forbidden' },
    });
    expect(normalizeExecutionPolicy(shuffled).effective_policy_hash).toBe(
      normalizeExecutionPolicy(base).effective_policy_hash,
    );
  });

  it('is stable across equivalent path spellings', () => {
    const spelled = packet({
      allowed_files: ['./server/**', 'shared//**'],
      execution_policy: { write_scope: ['**/*.ts'], destructive_actions: 'forbidden' },
    });
    expect(normalizeExecutionPolicy(spelled).effective_policy_hash).toBe(
      normalizeExecutionPolicy(base).effective_policy_hash,
    );
  });

  it('changes when any declaration changes', () => {
    const widened = packet({
      allowed_files: ['server/**', 'shared/**', 'client/**'],
      execution_policy: { write_scope: ['**/*.ts'], destructive_actions: 'forbidden' },
    });
    expect(normalizeExecutionPolicy(widened).effective_policy_hash).not.toBe(
      normalizeExecutionPolicy(base).effective_policy_hash,
    );
  });

  it('is a lowercase hex sha-256 digest', () => {
    expect(normalizeExecutionPolicy(base).effective_policy_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('canonicalizes to sorted keys and sorted, de-duplicated arrays', () => {
    expect(canonicalizePolicy({ b: 1, a: ['z', 'a', 'z'] })).toBe('{"a":["a","z"],"b":1}');
  });
});
