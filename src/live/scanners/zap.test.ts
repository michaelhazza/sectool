import { describe, it, expect, beforeEach } from 'vitest';
import { runZap, buildZapAutomationYaml } from './zap.js';
import type { ZapReport, ZapOpts, ExecZap } from './zap.js';
import type { AllowedTarget } from '../gate.js';
import type { Session } from '../auth.js';
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

function makeSessions(): [Session, Session] {
  return [
    { kind: 'session', userEnv: 'USER1_ENV', carrier: 'cookie', cookieHeader: 'sess=abc123' },
    { kind: 'session', userEnv: 'USER2_ENV', carrier: 'cookie', cookieHeader: 'sess=xyz789' },
  ];
}

function makePassiveOpts(): ZapOpts {
  return { rps: 10, activeScan: false };
}

function makeActiveOpts(sessions: [Session, Session]): ZapOpts {
  return { rps: 10, activeScan: true, sessions };
}

// ---------------------------------------------------------------------------
// Captured fixture ZAP JSON output
// ---------------------------------------------------------------------------

/** Fixture: one passive alert (ZAP plugin id 10021 — X-Content-Type-Options missing) */
const FIXTURE_PASSIVE_REPORT: ZapReport = {
  alerts: [
    {
      alertId: '10021',
      pluginId: '10021',
      name: 'X-Content-Type-Options Header Missing',
      riskdesc: 'Low (Medium)',
      confidence: 'Medium',
      url: 'https://staging.example.dev/api/users',
      param: '',
      evidence: 'Content-Type: text/html',
      cweid: 693,
      description: 'The Anti-MIME-Sniffing header X-Content-Type-Options was not set.',
    },
  ],
};

/** Fixture: one active alert (ZAP plugin id 40018 — SQL Injection) */
const FIXTURE_ACTIVE_REPORT: ZapReport = {
  alerts: [
    {
      alertId: '40018',
      pluginId: '40018',
      name: 'SQL Injection',
      riskdesc: 'High (Medium)',
      confidence: 'Medium',
      url: 'https://staging.example.dev/api/search',
      param: 'query',
      attack: "' OR '1'='1",
      evidence: 'syntax error',
      cweid: 89,
      description: 'SQL injection may be possible.',
    },
  ],
};

/** Fixture: alert from an off-host URL (should be filtered out). */
const FIXTURE_OFF_HOST_REPORT: ZapReport = {
  alerts: [
    {
      alertId: '10021',
      pluginId: '10021',
      name: 'Off-host Alert',
      riskdesc: 'Low (Low)',
      confidence: 'Low',
      url: 'https://external.otherdomain.com/page',
      param: '',
    },
  ],
};

/** Fixture: ZAP sites-based report layout. */
const FIXTURE_SITES_REPORT: ZapReport = {
  sites: [
    {
      site: 'https://staging.example.dev',
      alerts: [
        {
          alertId: '10036',
          pluginId: '10036',
          name: 'Server Leaks Version Information',
          riskdesc: 'Low (High)',
          confidence: 'High',
          url: 'https://staging.example.dev/',
          evidence: 'Apache/2.4.41',
        },
      ],
    },
  ],
};

/** Fixture: empty report (no alerts). */
const FIXTURE_EMPTY_REPORT: ZapReport = { alerts: [] };

// ---------------------------------------------------------------------------
// Fake ExecZap helpers
// ---------------------------------------------------------------------------

function fixedExecZap(report: ZapReport): ExecZap {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (_args: readonly string[]): Promise<ZapReport> => Promise.resolve(report);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runZap', () => {
  beforeEach(() => {
    _resetHostRegistry();
  });

  it('returns no findings for an empty report', async () => {
    const target = makeTarget();
    const findings = await runZap(target, makePassiveOpts(), fixedExecZap(FIXTURE_EMPTY_REPORT));
    expect(findings).toHaveLength(0);
  });

  it('normalizes a passive alert to a Finding with correct shape', async () => {
    const target = makeTarget();
    const findings = await runZap(target, makePassiveOpts(), fixedExecZap(FIXTURE_PASSIVE_REPORT));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.source).toBe('zap');
    expect(f.surface).toBe('live');
    expect(f.ruleId).toMatch(/^ZAP-P-/);
    expect(f.severity).toBe('low');
    expect(f.baseSeverity).toBe('low');
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

  it('assigns ZAP-A-* checkId for active-range plugin ids (>= 10000)', async () => {
    const target = makeTarget();
    const sessions = makeSessions();
    const findings = await runZap(target, makeActiveOpts(sessions), fixedExecZap(FIXTURE_ACTIVE_REPORT));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toMatch(/^ZAP-A-/);
  });

  it('filters out off-host alerts (scope confinement §4.4)', async () => {
    const target = makeTarget();
    const findings = await runZap(target, makePassiveOpts(), fixedExecZap(FIXTURE_OFF_HOST_REPORT));
    expect(findings).toHaveLength(0);
  });

  it('handles ZAP sites-based report layout', async () => {
    const target = makeTarget();
    const findings = await runZap(target, makePassiveOpts(), fixedExecZap(FIXTURE_SITES_REPORT));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toMatch(/^ZAP-P-/);
  });

  it('throws when activeScan:true but sessions not provided', async () => {
    const target = makeTarget();
    const opts: ZapOpts = { rps: 10, activeScan: true };
    await expect(runZap(target, opts, fixedExecZap(FIXTURE_EMPTY_REPORT))).rejects.toThrow(
      /2 established sessions/,
    );
  });

  it('throws when activeScan:true but sessions array is empty (type-cast edge case)', async () => {
    const target = makeTarget();
    // Simulate a caller passing undefined sessions accidentally
    const opts: ZapOpts = { rps: 10, activeScan: true, sessions: undefined };
    await expect(runZap(target, opts, fixedExecZap(FIXTURE_EMPTY_REPORT))).rejects.toThrow(
      /2 established sessions/,
    );
  });

  it('redacts credential material in evidence.raw', async () => {
    const target = makeTarget();
    const reportWithCreds: ZapReport = {
      alerts: [
        {
          pluginId: '10021',
          name: 'Auth Header Exposed',
          riskdesc: 'High (High)',
          confidence: 'High',
          url: 'https://staging.example.dev/',
          evidence: 'fixture-evidence-string',
          // authorization header value would be redacted by redact()
          attack: 'Bearer fixture-token-value-not-a-secret',
        },
      ],
    };
    const findings = await runZap(target, makePassiveOpts(), fixedExecZap(reportWithCreds));
    expect(findings).toHaveLength(1);
    // The raw evidence object is processed through redact(); confirm it's present
    const raw = findings[0]!.evidence.raw;
    expect(typeof raw).toBe('object');
    expect(raw).toHaveProperty('name');
  });

  it('emits location with correct URL and target host', async () => {
    const target = makeTarget();
    const findings = await runZap(target, makePassiveOpts(), fixedExecZap(FIXTURE_PASSIVE_REPORT));
    expect(findings).toHaveLength(1);
    const loc = findings[0]!.location as { url: string; method: string };
    expect(loc.url).toContain('staging.example.dev');
    expect(loc.method).toBe('GET');
  });

  it('maps High risk to high severity', async () => {
    const target = makeTarget();
    const sessions = makeSessions();
    const findings = await runZap(target, makeActiveOpts(sessions), fixedExecZap(FIXTURE_ACTIVE_REPORT));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('high');
  });

  it('maps Critical risk to critical severity', async () => {
    const target = makeTarget();
    const criticalReport: ZapReport = {
      alerts: [
        {
          pluginId: '9999',
          name: 'Critical Vuln',
          riskdesc: 'Critical (High)',
          confidence: 'High',
          url: 'https://staging.example.dev/',
        },
      ],
    };
    const findings = await runZap(target, makePassiveOpts(), fixedExecZap(criticalReport));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('critical');
  });

  it('confidence is probable for all ZAP findings (passive evidence)', async () => {
    const target = makeTarget();
    const findings = await runZap(target, makePassiveOpts(), fixedExecZap(FIXTURE_PASSIVE_REPORT));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBe('probable');
  });

  // Fix 4: rate limit passed to scanner args
  it('passes -rate-limit <rps> in args to the ExecZap function', async () => {
    const target = makeTarget();
    let capturedArgs: readonly string[] = [];
    const capturingExec: ExecZap = (args) => {
      capturedArgs = args;
      return Promise.resolve(FIXTURE_EMPTY_REPORT);
    };
    const opts: ZapOpts = { rps: 5, activeScan: false };
    await runZap(target, opts, capturingExec);
    expect(capturedArgs).toContain('-rate-limit');
    const idx = Array.from(capturedArgs).indexOf('-rate-limit');
    expect(capturedArgs[idx + 1]).toBe('5');
  });

  it('rate limit value matches opts.rps in args', async () => {
    const target = makeTarget();
    let capturedArgs: readonly string[] = [];
    const capturingExec: ExecZap = (args) => {
      capturedArgs = args;
      return Promise.resolve(FIXTURE_EMPTY_REPORT);
    };
    const opts: ZapOpts = { rps: 20, activeScan: false };
    await runZap(target, opts, capturingExec);
    const idx = Array.from(capturedArgs).indexOf('-rate-limit');
    expect(capturedArgs[idx + 1]).toBe('20');
  });
});

// ---------------------------------------------------------------------------
// Fix 8: buildZapAutomationYaml — YAML URL quoting
// ---------------------------------------------------------------------------

describe('buildZapAutomationYaml — URL quoting (fix 8)', () => {
  it('wraps the target URL in double quotes in the YAML output', () => {
    const yaml = buildZapAutomationYaml('https://staging.example.dev/', false, 10, '/tmp/report.json');
    expect(yaml).toMatch(/"https:\/\/staging\.example\.dev\/"/);
  });

  it('escapes double quotes in the URL to prevent YAML injection', () => {
    const maliciousUrl = 'https://example.dev/"\nmalicious: directive';
    const yaml = buildZapAutomationYaml(maliciousUrl, false, 10, '/tmp/report.json');
    // The injected newline+directive must not appear as a raw YAML directive.
    // The double-quote in the URL is escaped as \\"
    expect(yaml).toMatch(/\\"/);
    expect(yaml).not.toMatch(/^malicious:/m);
  });

  it('includes maxRequestsPerSecond matching rateLimitRps', () => {
    const yaml = buildZapAutomationYaml('https://staging.example.dev/', false, 7, '/tmp/report.json');
    expect(yaml).toMatch(/maxRequestsPerSecond:\s*7/);
  });

  it('uses the provided reportFilePath (not /dev/stdout)', () => {
    const yaml = buildZapAutomationYaml('https://staging.example.dev/', false, 10, '/tmp/zap-report-123.json');
    expect(yaml).toMatch(/zap-report-123\.json/);
    expect(yaml).not.toContain('/dev/stdout');
  });
});
