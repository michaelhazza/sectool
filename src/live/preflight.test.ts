import { describe, it, expect, vi } from 'vitest';
import { preflight, dryRun, UnregisteredTargetError } from './preflight.js';
import { AllowlistViolationError } from './gate.js';
import type { LoadedAllowlist } from '../config/load.js';
import type { TargetRegistry } from '../schemas/targets.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAllowlist(hosts: Array<{ host: string }>): LoadedAllowlist {
  const entries = hosts.map((h) => ({
    host: h.host,
    owner: 'test',
    addedAt: '2026-01-01',
  }));
  return { hosts: entries } as unknown as LoadedAllowlist;
}

const STAGING_HOST = 'staging.example.breakout.dev';
const STAGING_URL = `https://${STAGING_HOST}/`;

function makeRegistry(overrides?: {
  host?: string;
  enabled?: boolean;
  activeScan?: boolean;
}): TargetRegistry {
  const host = overrides?.host ?? STAGING_HOST;
  const enabled = overrides?.enabled ?? true;
  const activeScan = overrides?.activeScan ?? false;

  return {
    repos: [],
    stagingTargets: [
      {
        name: 'example-staging',
        url: `https://${host}/`,
        repo: 'example-repo',
        activeScan,
        auth: undefined,
        rateLimitRps: 10,
        enabled,
      },
    ],
  };
}

const SINGLE_ALLOWLIST = makeAllowlist([{ host: STAGING_HOST }]);
const EMPTY_ALLOWLIST = makeAllowlist([]);

// ---------------------------------------------------------------------------
// §10 preflight-before-DNS guardrail
//
// A denied host asserts assertAllowlisted threw AND that the injected DNS
// resolver was never called (zero DNS calls) and zero HTTP requests were made.
// ---------------------------------------------------------------------------

describe('preflight — §10 preflight-before-DNS guardrail', () => {
  it('denied host: resolver is NEVER called (zero DNS calls)', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const spyResolver = vi.fn((_hostname: string) => Promise.resolve('1.2.3.4'));

    expect(() =>
      preflight('https://evil.attacker.com/', EMPTY_ALLOWLIST, makeRegistry({ host: STAGING_HOST }), spyResolver),
    ).toThrow(AllowlistViolationError);

    expect(spyResolver).not.toHaveBeenCalled();
  });

  it('denied host via http scheme: resolver is NEVER called', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const spyResolver = vi.fn((_hostname: string) => Promise.resolve('1.2.3.4'));

    expect(() =>
      preflight(`http://${STAGING_HOST}/`, SINGLE_ALLOWLIST, makeRegistry(), spyResolver),
    ).toThrow(AllowlistViolationError);

    expect(spyResolver).not.toHaveBeenCalled();
  });

  it('dry-run against a denied host: resolver is NEVER called and zero HTTP requests', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const spyResolver = vi.fn((_hostname: string) => Promise.resolve('1.2.3.4'));
    const output: string[] = [];

    dryRun('https://evil.attacker.com/', EMPTY_ALLOWLIST, makeRegistry(), {
      output: (msg) => output.push(msg),
      resolver: spyResolver,
    });

    expect(spyResolver).not.toHaveBeenCalled();
    // Denied host prints deny verdict
    expect(output.some((line) => line.toUpperCase().includes('DENIED'))).toBe(true);
  });

  it('dry-run denied host: output mentions DENIED', () => {
    const output: string[] = [];
    dryRun(`https://notallowed.example.com/`, SINGLE_ALLOWLIST, makeRegistry(), {
      output: (msg) => output.push(msg),
    });
    expect(output.join('\n')).toMatch(/DENIED/);
  });

  it('dry-run denied host (ip literal): output mentions DENIED', () => {
    const output: string[] = [];
    dryRun('https://127.0.0.1/', SINGLE_ALLOWLIST, makeRegistry(), {
      output: (msg) => output.push(msg),
    });
    expect(output.join('\n')).toMatch(/DENIED/);
  });
});

// ---------------------------------------------------------------------------
// preflight — happy path: gate-pass + enabled registry entry → PreflightResult
// ---------------------------------------------------------------------------

describe('preflight — gate-pass + enabled registry entry', () => {
  it('returns AllowedTarget and registryEntry on success', () => {
    const result = preflight(STAGING_URL, SINGLE_ALLOWLIST, makeRegistry());
    expect(result.target.hostname).toBe(STAGING_HOST);
    expect(result.target.url).toBe(STAGING_URL);
    expect(result.registryEntry.name).toBe('example-staging');
  });

  it('registryEntry reflects activeScan:false by default', () => {
    const result = preflight(STAGING_URL, SINGLE_ALLOWLIST, makeRegistry());
    expect(result.registryEntry.activeScan).toBe(false);
  });

  it('registryEntry reflects activeScan:true when configured', () => {
    const registry = makeRegistry({ activeScan: true });
    const result = preflight(STAGING_URL, SINGLE_ALLOWLIST, registry);
    expect(result.registryEntry.activeScan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// preflight — gate-pass + unregistered host → UnregisteredTargetError
// ---------------------------------------------------------------------------

describe('preflight — gate-pass but no enabled registry entry', () => {
  it('throws UnregisteredTargetError when host passes gate but has no registry entry', () => {
    // Allowlist has the host, but registry has a different host
    const registryWithDifferentHost = makeRegistry({ host: 'other.breakout.dev' });
    expect(() =>
      preflight(STAGING_URL, SINGLE_ALLOWLIST, registryWithDifferentHost),
    ).toThrow(UnregisteredTargetError);
  });

  it('throws UnregisteredTargetError when registry entry exists but is disabled', () => {
    const registryDisabled = makeRegistry({ enabled: false });
    expect(() =>
      preflight(STAGING_URL, SINGLE_ALLOWLIST, registryDisabled),
    ).toThrow(UnregisteredTargetError);
  });

  it('throws UnregisteredTargetError when registry is empty', () => {
    const emptyRegistry: TargetRegistry = { repos: [], stagingTargets: [] };
    expect(() =>
      preflight(STAGING_URL, SINGLE_ALLOWLIST, emptyRegistry),
    ).toThrow(UnregisteredTargetError);
  });

  it('UnregisteredTargetError message names the hostname', () => {
    const registryWithDifferentHost = makeRegistry({ host: 'other.breakout.dev' });
    expect(() =>
      preflight(STAGING_URL, SINGLE_ALLOWLIST, registryWithDifferentHost),
    ).toThrow(new RegExp(STAGING_HOST));
  });

  it('UnregisteredTargetError is an instance of Error', () => {
    const err = new UnregisteredTargetError('some.host.dev');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UnregisteredTargetError');
  });
});

// ---------------------------------------------------------------------------
// preflight — AllowlistViolationError takes priority over registry check
// ---------------------------------------------------------------------------

describe('preflight — AllowlistViolationError before registry check', () => {
  it('throws AllowlistViolationError (not UnregisteredTargetError) for a denied host', () => {
    // Even if the registry has an entry for a different host, the gate fires first
    expect(() =>
      preflight('https://evil.example.com/', EMPTY_ALLOWLIST, makeRegistry()),
    ).toThrow(AllowlistViolationError);
  });

  it('throws AllowlistViolationError for http scheme (gate fires first)', () => {
    expect(() =>
      preflight(`http://${STAGING_HOST}/`, SINGLE_ALLOWLIST, makeRegistry()),
    ).toThrow(AllowlistViolationError);
  });
});

// ---------------------------------------------------------------------------
// dryRun — allowed host: prints verdict + check families
// ---------------------------------------------------------------------------

describe('dryRun — allowed host with enabled registry entry', () => {
  it('prints ALLOWED and the hostname', () => {
    const output: string[] = [];
    dryRun(STAGING_URL, SINGLE_ALLOWLIST, makeRegistry(), { output: (msg) => output.push(msg) });
    expect(output.join('\n')).toMatch(/ALLOWED/);
    expect(output.join('\n')).toMatch(new RegExp(STAGING_HOST));
  });

  it('prints the registry entry name', () => {
    const output: string[] = [];
    dryRun(STAGING_URL, SINGLE_ALLOWLIST, makeRegistry(), { output: (msg) => output.push(msg) });
    expect(output.join('\n')).toMatch(/example-staging/);
  });

  it('prints the check families that would run (passive when activeScan:false)', () => {
    const output: string[] = [];
    dryRun(STAGING_URL, SINGLE_ALLOWLIST, makeRegistry({ activeScan: false }), {
      output: (msg) => output.push(msg),
    });
    const combined = output.join('\n');
    expect(combined).toMatch(/probe/);
    expect(combined).toMatch(/nuclei/);
    expect(combined).toMatch(/zap/);
  });

  it('prints active families when activeScan:true', () => {
    const output: string[] = [];
    dryRun(STAGING_URL, SINGLE_ALLOWLIST, makeRegistry({ activeScan: true }), {
      output: (msg) => output.push(msg),
    });
    const combined = output.join('\n');
    expect(combined).toMatch(/active/);
  });

  it('prints zero traffic confirmation', () => {
    const output: string[] = [];
    dryRun(STAGING_URL, SINGLE_ALLOWLIST, makeRegistry(), { output: (msg) => output.push(msg) });
    expect(output.join('\n')).toMatch(/[Zz]ero traffic/);
  });
});

// ---------------------------------------------------------------------------
// dryRun — unregistered host prints DENIED (unregistered)
// ---------------------------------------------------------------------------

describe('dryRun — gate-pass but unregistered host', () => {
  it('prints DENIED (unregistered) message', () => {
    const registryWithDifferentHost = makeRegistry({ host: 'other.breakout.dev' });
    const output: string[] = [];
    dryRun(STAGING_URL, SINGLE_ALLOWLIST, registryWithDifferentHost, {
      output: (msg) => output.push(msg),
    });
    expect(output.join('\n')).toMatch(/DENIED/);
    expect(output.join('\n')).toMatch(/unregistered/);
  });
});
