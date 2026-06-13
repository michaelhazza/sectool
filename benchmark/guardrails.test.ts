/**
 * P6-2 — §10 guardrail test consolidation (engine-available subset)
 *
 * This file is the normative guardrail registry for audit-tool-v1.
 * Each guardrail is either:
 *   (a) fully covered in its owning module's test file — referenced below, and
 *   (b) completed here where P6-2 is the designated owner per the plan.
 *
 * §10 guardrails in scope (engine-available, HTML inert-text matrix deferred to P7):
 *
 *   1. allowlist IP-literal rejection          → src/live/gate.test.ts
 *   2. preflight-before-DNS ordering           → src/live/preflight.test.ts
 *   3. aggregate per-host rate limit           → src/live/ratelimit.test.ts
 *   4. carrier-aware login success             → src/live/auth.test.ts
 *   5. active-scan cred failure                → src/live/auth.test.ts + HERE (consolidated assertion)
 *   6. §4.7 abort (AllowlistViolationError)    → benchmark/safety-abort.test.ts
 *   7. scoped suppression                      → src/report/baseline.test.ts
 *   8. partial-run trend                       → src/report/trend.test.ts
 *   9. secret redaction — redaction.ts unit    → src/report/redaction.test.ts
 *  10. secret redaction across all surfaces    → HERE (cross-surface consolidated assertion)
 *
 * Tests authored in this file:
 *   § active-scan cred failure (consolidated)
 *   § secret-redaction across-all-surfaces (raw findings → report.json → MD → SARIF)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loginForTarget, type LoginResult, type HttpClient } from '../src/live/auth.js';
import type { AllowedTarget } from '../src/live/gate.js';
import type { AuthForm } from '../src/schemas/targets.js';
import { redact } from '../src/report/redaction.js';
import { buildReport, type BuildReportInput } from '../src/report/json.js';
import { toMarkdown } from '../src/report/markdown.js';
import { toSarif } from '../src/report/sarif.js';
import type { Finding } from '../src/schemas/finding.js';
import type { RunMeta, RunTarget } from '../src/schemas/report.js';
import type { Baseline } from '../src/schemas/baseline.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fakeTarget(hostname = 'staging.test.localhost'): AllowedTarget {
  return {
    __allowedTarget: true,
    url: `https://${hostname}`,
    hostname,
  } as unknown as AllowedTarget;
}

function baseAuth(overrides?: Partial<AuthForm>): AuthForm {
  return {
    kind: 'form',
    loginPath: '/api/auth/login',
    method: 'POST',
    userField: 'email',
    passField: 'password',
    bodyType: 'json',
    sessionCarrier: 'cookie',
    successCheck: { statusIn: [200] },
    testUsers: [
      { userEnv: 'AUDIT_GRL_USER_A', passEnv: 'AUDIT_GRL_PASS_A' },
      { userEnv: 'AUDIT_GRL_USER_B', passEnv: 'AUDIT_GRL_PASS_B' },
    ],
    ...overrides,
  };
}

// Innocuous non-detector-matching strings (no standard entropy patterns).
const FAKE_USER = 'testoperator-guardrail-a';
const FAKE_PASS = 'fakepass-guardrail-notasecret';

function makeFingerprint(seed: string): string {
  return seed.padEnd(64, '0').slice(0, 64);
}

function makeStaticFinding(overrides: Partial<Finding> = {}): Finding {
  const fp = makeFingerprint('grl00001');
  return {
    id: `f-${fp.slice(0, 16)}`,
    fingerprint: fp,
    ruleId: 'BS-SQL-001',
    source: 'ast',
    surface: 'static',
    vulnClass: 'injection',
    severity: 'high',
    baseSeverity: 'high',
    confidence: 'probable',
    target: { kind: 'repo', name: 'repo-guardrail' },
    location: { path: 'src/index.ts', symbol: 'GET /api/users/:id' },
    evidence: { snippet: 'db.query(id)', cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    docs: 'docs/rules/BS-SQL-001.md',
    externalRefs: [],
    firstSeen: '2026-06-12T00:00:00Z',
    suppressed: false,
    suppression: null,
    note: null,
    ...overrides,
  } as Finding;
}

function makeBuildInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  const meta: RunMeta = {
    status: 'success',
    failures: [],
    scannerStatus: [],
    startedAt: '2026-06-12T03:00:00Z',
    finishedAt: '2026-06-12T03:08:11Z',
    toolVersion: 'audit-tool/1.0.0',
  };
  const target: RunTarget = { kind: 'repo', name: 'repo-guardrail', coverageGaps: [] };
  const baseline: Baseline = { entries: [] };
  return {
    runId: '2026-06-12T03-00-00Z-grl1',
    date: '2026-06-12',
    rawFindings: [],
    scannerStatus: [],
    targets: [target],
    meta,
    baseline,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §10 Guardrail 5 — active-scan cred failure (consolidated assertion)
//
// Spec §6.2: an activeScan:true target with missing creds MUST produce a
// LoginFailure — never a silent downgrade to an unauthenticated scan.
// This mirrors the assertions in src/live/auth.test.ts but provides a
// single consolidated home for the guardrail registry entry.
// ---------------------------------------------------------------------------

describe('§10 guardrail: active-scan cred failure (§6.2 / §4.7 analogous)', () => {
  beforeEach(() => {
    process.env['AUDIT_GRL_USER_A'] = FAKE_USER;
    process.env['AUDIT_GRL_PASS_A'] = FAKE_PASS;
    process.env['AUDIT_GRL_USER_B'] = FAKE_USER + '-b';
    process.env['AUDIT_GRL_PASS_B'] = FAKE_PASS + '-b';
    return () => {
      delete process.env['AUDIT_GRL_USER_A'];
      delete process.env['AUDIT_GRL_PASS_A'];
      delete process.env['AUDIT_GRL_USER_B'];
      delete process.env['AUDIT_GRL_PASS_B'];
    };
  });

  it('activeScan:true + missing env-var creds → LoginFailure (not unauthenticated)', async () => {
    delete process.env['AUDIT_GRL_USER_A'];
    delete process.env['AUDIT_GRL_PASS_A'];

    const auth = baseAuth();
    const httpClient: HttpClient = () => Promise.reject(new Error('must not be called'));

    const result: LoginResult = await loginForTarget(fakeTarget(), auth, true, httpClient);

    expect(result.kind).toBe('failure');
  });

  it('activeScan:true + login 401 → LoginFailure (never silent downgrade)', async () => {
    const auth = baseAuth({ sessionCarrier: 'cookie', successCheck: { statusIn: [200] } });
    const httpClient: HttpClient = () =>
      Promise.resolve({ status: 401, body: { error: 'bad creds' }, headers: {} });

    const result: LoginResult = await loginForTarget(fakeTarget(), auth, true, httpClient);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('login-error');
    }
  });

  it('activeScan:true + no auth config → LoginFailure', async () => {
    const httpClient: HttpClient = () => Promise.reject(new Error('must not be called'));
    const result: LoginResult = await loginForTarget(fakeTarget(), undefined, true, httpClient);

    expect(result.kind).toBe('failure');
  });

  it('activeScan:false + missing creds → UnauthenticatedWithGap (NOT LoginFailure)', async () => {
    delete process.env['AUDIT_GRL_USER_A'];
    delete process.env['AUDIT_GRL_PASS_A'];

    const auth = baseAuth();
    const httpClient: HttpClient = () => Promise.reject(new Error('must not be called'));

    const result: LoginResult = await loginForTarget(fakeTarget(), auth, false, httpClient);

    expect(result.kind).toBe('unauthenticated');
  });
});

// ---------------------------------------------------------------------------
// §10 Guardrail 10 — secret-redaction across all engine-available surfaces
//
// Spec §5.4: credential material MUST be absent from every emitted surface.
// This test feeds ONE fixture secret through the full output pipeline
// (redact() → buildReport() → toMarkdown() → toSarif()) and asserts the
// raw value is absent from each surface's serialized output.
//
// Surfaces covered here: raw findings (redact()), report.json (buildReport()),
// Markdown (toMarkdown()), SARIF (toSarif()).
// HTML + fix-issue surfaces: P7/P8 (deferred per plan P6-2 spec).
//
// Innocuous fixture secret: non-detector-matching string, no real entropy.
// ---------------------------------------------------------------------------

// The test secret must not match any common secret-detector pattern.
const FIXTURE_SECRET = 'fakecred-notasecret-p6guardrail-xyzzy';

describe('§10 guardrail: secret-redaction across-all-surfaces (§5.4)', () => {
  it('raw findings — redact() removes the fixture secret from evidence.raw', () => {
    const finding = makeStaticFinding({
      evidence: {
        snippet: 'const key = "PLACEHOLDER"',
        cvss: null,
        raw: { secret: FIXTURE_SECRET },
      },
    });

    const redacted = redact(finding);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(FIXTURE_SECRET);
  });

  it('report.json — buildReport() removes the fixture secret from the assembled report', () => {
    const fp = makeFingerprint('grl00002');
    const finding = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      evidence: {
        snippet: 'const key = "PLACEHOLDER"',
        cvss: null,
        raw: { secret: FIXTURE_SECRET },
      },
    });

    const report = buildReport(makeBuildInput({ rawFindings: [finding] }));
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(FIXTURE_SECRET);
  });

  it('Markdown — toMarkdown() removes the fixture secret', () => {
    const fp = makeFingerprint('grl00003');
    const finding = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      evidence: {
        snippet: 'const key = "PLACEHOLDER"',
        cvss: null,
        raw: { secret: FIXTURE_SECRET },
      },
    });

    const report = buildReport(makeBuildInput({ rawFindings: [finding] }));
    const md = toMarkdown(report);

    expect(md).not.toContain(FIXTURE_SECRET);
  });

  it('SARIF — toSarif() removes the fixture secret', () => {
    const fp = makeFingerprint('grl00004');
    const finding = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      evidence: {
        snippet: 'const key = "PLACEHOLDER"',
        cvss: null,
        raw: { secret: FIXTURE_SECRET },
      },
    });

    const report = buildReport(makeBuildInput({ rawFindings: [finding] }));
    const sarif = toSarif(report);

    expect(sarif).not.toContain(FIXTURE_SECRET);
  });

  it('all four surfaces in one pass — the same fixture secret is absent from every output', () => {
    const fp = makeFingerprint('grl00005');
    const finding = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      evidence: {
        snippet: 'const key = "PLACEHOLDER"',
        cvss: null,
        raw: { secret: FIXTURE_SECRET },
      },
    });

    const rawRedacted = JSON.stringify(redact(finding));
    const report = buildReport(makeBuildInput({ rawFindings: [finding] }));
    const reportJson = JSON.stringify(report);
    const md = toMarkdown(report);
    const sarif = toSarif(report);

    for (const surface of [rawRedacted, reportJson, md, sarif]) {
      expect(surface).not.toContain(FIXTURE_SECRET);
    }
  });
});
