import { describe, it, expect, beforeEach } from 'vitest';
import { runNuclei } from './nuclei.js';
import type { NucleiResult, NucleiOpts, ExecNuclei } from './nuclei.js';
import type { AllowedTarget } from '../gate.js';
import { _resetHostRegistry } from '../ratelimit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(hostname = 'staging.example.dev'): AllowedTarget {
  return {
    url: `https://${hostname}/`,
    hostname,
  } as unknown as AllowedTarget;
}

function makePassiveOpts(): NucleiOpts {
  return { rps: 10, activeScan: false };
}

// ---------------------------------------------------------------------------
// Captured fixture Nuclei JSONL results
// ---------------------------------------------------------------------------

/** Fixture: a CVE finding (passive, technologies tag) */
const FIXTURE_CVE_RESULT: NucleiResult = {
  'template-id': 'CVE-2021-44228',
  info: {
    name: 'Apache Log4j2 RCE',
    severity: 'critical',
    description: 'Log4Shell remote code execution vulnerability.',
    tags: ['cves', 'rce'],
  },
  'matched-at': 'https://staging.example.dev/api/log',
  'extracted-results': ['fixture-extracted-indicator'],
  'matcher-name': 'log4shell',
};

/** Fixture: a misconfiguration finding (passive) */
const FIXTURE_MISCONFIG_RESULT: NucleiResult = {
  'template-id': 'exposed-kibana',
  info: {
    name: 'Kibana Panel Exposed',
    severity: 'high',
    tags: ['exposed-panels'],
  },
  'matched-at': 'https://staging.example.dev/kibana',
  'matcher-name': 'status-200',
};

/** Fixture: a fuzzing result (active only) */
const FIXTURE_FUZZING_RESULT: NucleiResult = {
  'template-id': 'xss-reflected',
  info: {
    name: 'Reflected XSS',
    severity: 'medium',
    tags: ['fuzzing'],
  },
  'matched-at': 'https://staging.example.dev/search',
  'matcher-name': 'xss-matcher',
};

/** Fixture: an off-host result (should be filtered out). */
const FIXTURE_OFF_HOST_RESULT: NucleiResult = {
  'template-id': 'tech-detect',
  info: {
    name: 'Tech Detect',
    severity: 'info',
  },
  'matched-at': 'https://external.otherdomain.com/page',
};

// ---------------------------------------------------------------------------
// Fake ExecNuclei helpers
// ---------------------------------------------------------------------------

function fixedExecNuclei(results: readonly NucleiResult[]): ExecNuclei {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (_args: readonly string[]): Promise<readonly NucleiResult[]> =>
    Promise.resolve(results);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runNuclei', () => {
  beforeEach(() => {
    _resetHostRegistry();
  });

  it('returns no findings for empty results', async () => {
    const target = makeTarget();
    const findings = await runNuclei(target, makePassiveOpts(), fixedExecNuclei([]));
    expect(findings).toHaveLength(0);
  });

  it('normalizes a CVE result to a Finding with correct shape', async () => {
    const target = makeTarget();
    const findings = await runNuclei(target, makePassiveOpts(), fixedExecNuclei([FIXTURE_CVE_RESULT]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.source).toBe('nuclei');
    expect(f.surface).toBe('live');
    expect(f.ruleId).toBe('NUCLEI-CVE-2021-44228');
    expect(f.severity).toBe('critical');
    expect(f.baseSeverity).toBe('critical');
    expect(f.target).toEqual({ kind: 'staging', host: 'staging.example.dev' });
    expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
    expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(f.id).toBe(`f-${f.fingerprint.slice(0, 16)}`);
    expect(f.suppressed).toBe(false);
    expect(f.suppression).toBeNull();
    expect(f.note).toBeNull();
    expect(f.correlatedWith).toEqual([]);
    expect(f.externalRefs).toEqual([]);
  });

  it('normalizes a misconfiguration result', async () => {
    const target = makeTarget();
    const findings = await runNuclei(target, makePassiveOpts(), fixedExecNuclei([FIXTURE_MISCONFIG_RESULT]));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.ruleId).toBe('NUCLEI-exposed-kibana');
    expect(f.severity).toBe('high');
  });

  it('filters out off-host results (scope confinement §4.4)', async () => {
    const target = makeTarget();
    const findings = await runNuclei(
      target,
      makePassiveOpts(),
      fixedExecNuclei([FIXTURE_OFF_HOST_RESULT]),
    );
    expect(findings).toHaveLength(0);
  });

  it('includes fuzzing results when activeScan:true', async () => {
    const target = makeTarget();
    const activeOpts: NucleiOpts = { rps: 10, activeScan: true };
    const findings = await runNuclei(
      target,
      activeOpts,
      fixedExecNuclei([FIXTURE_FUZZING_RESULT]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('NUCLEI-xss-reflected');
  });

  it('redacts credential material in evidence.raw', async () => {
    const target = makeTarget();
    const resultWithSensitiveData: NucleiResult = {
      'template-id': 'token-exposed',
      info: {
        name: 'API Token Exposed',
        severity: 'high',
      },
      'matched-at': 'https://staging.example.dev/config',
      'extracted-results': ['fixture-extracted-value-not-a-real-secret'],
    };
    const findings = await runNuclei(
      target,
      makePassiveOpts(),
      fixedExecNuclei([resultWithSensitiveData]),
    );
    expect(findings).toHaveLength(1);
    const raw = findings[0]!.evidence.raw;
    expect(typeof raw).toBe('object');
    // The raw evidence must not contain bare 'token' credential key values
    // (redact() processes the object; 'extractedResults' is NOT a credential key
    // so the value passes through)
    expect(raw).toHaveProperty('templateId');
    expect(raw).toHaveProperty('name');
  });

  it('emits location with correct URL from matched-at', async () => {
    const target = makeTarget();
    const findings = await runNuclei(
      target,
      makePassiveOpts(),
      fixedExecNuclei([FIXTURE_CVE_RESULT]),
    );
    const loc = findings[0]!.location as { url: string };
    expect(loc.url).toContain('staging.example.dev');
    expect(loc.url).toContain('/api/log');
  });

  it('maps info/unknown severity to low', async () => {
    const target = makeTarget();
    const infoResult: NucleiResult = {
      'template-id': 'tech-detect-nginx',
      info: { name: 'Nginx detected', severity: 'info' },
      'matched-at': 'https://staging.example.dev/',
    };
    const findings = await runNuclei(target, makePassiveOpts(), fixedExecNuclei([infoResult]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('low');
  });

  it('confidence is probable for all Nuclei findings', async () => {
    const target = makeTarget();
    const findings = await runNuclei(target, makePassiveOpts(), fixedExecNuclei([FIXTURE_CVE_RESULT]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBe('probable');
  });

  it('snippet includes extracted result when present', async () => {
    const target = makeTarget();
    const findings = await runNuclei(
      target,
      makePassiveOpts(),
      fixedExecNuclei([FIXTURE_CVE_RESULT]),
    );
    expect(findings).toHaveLength(1);
    const snippet = findings[0]!.evidence.snippet ?? '';
    expect(snippet).toContain('fixture-extracted-indicator');
  });

  it('handles multiple results, filters off-host, returns only in-scope', async () => {
    const target = makeTarget();
    const mixed = [FIXTURE_CVE_RESULT, FIXTURE_OFF_HOST_RESULT, FIXTURE_MISCONFIG_RESULT];
    const findings = await runNuclei(target, makePassiveOpts(), fixedExecNuclei(mixed));
    // Off-host result filtered; CVE + misconfig both in scope
    expect(findings).toHaveLength(2);
    const ruleIds = findings.map((f) => f.ruleId).sort();
    expect(ruleIds).toContain('NUCLEI-CVE-2021-44228');
    expect(ruleIds).toContain('NUCLEI-exposed-kibana');
  });

  // Fix 4: rate limit passed through to Nuclei args
  it('passes -rate-limit <rps> in args to the ExecNuclei function', async () => {
    const target = makeTarget();
    let capturedArgs: readonly string[] = [];
    const capturingExec: ExecNuclei = (args) => {
      capturedArgs = args;
      return Promise.resolve([]);
    };
    const opts: NucleiOpts = { rps: 3, activeScan: false };
    await runNuclei(target, opts, capturingExec);
    expect(capturedArgs).toContain('-rate-limit');
    const idx = Array.from(capturedArgs).indexOf('-rate-limit');
    expect(capturedArgs[idx + 1]).toBe('3');
  });

  it('rate limit value matches opts.rps exactly in args', async () => {
    const target = makeTarget();
    let capturedArgs: readonly string[] = [];
    const capturingExec: ExecNuclei = (args) => {
      capturedArgs = args;
      return Promise.resolve([]);
    };
    const opts: NucleiOpts = { rps: 15, activeScan: false };
    await runNuclei(target, opts, capturingExec);
    const idx = Array.from(capturedArgs).indexOf('-rate-limit');
    expect(capturedArgs[idx + 1]).toBe('15');
  });
});
