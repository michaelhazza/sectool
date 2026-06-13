import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { redact, redactString } from './redaction.js';

const _moduleDir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(_moduleDir, '..', '..', 'benchmark', 'fixtures', 'redaction', 'known-secrets.json');

interface KnownSecretsFixture {
  gitleaksSecret: string;
  bearerToken: string;
  setCookieValue: string;
  cookieValue: string;
  apiKey: string;
  password: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as KnownSecretsFixture;

const PLACEHOLDER_RE = /^\[redacted:[0-9a-f]{8}\]$/;

// ---------------------------------------------------------------------------
// redactString — treats the whole input as a raw credential value
// ---------------------------------------------------------------------------

describe('redactString', () => {
  it('replaces a gitleaks-detected secret with [redacted:<8hex>]', () => {
    const result = redactString(fixture.gitleaksSecret);
    expect(result).toMatch(PLACEHOLDER_RE);
    expect(result).not.toContain(fixture.gitleaksSecret);
  });

  it('returns the same placeholder for the same secret (stable)', () => {
    const first = redactString(fixture.gitleaksSecret);
    const second = redactString(fixture.gitleaksSecret);
    expect(first).toBe(second);
  });

  it('returns different placeholders for different secrets', () => {
    const a = redactString(fixture.gitleaksSecret);
    const b = redactString(fixture.bearerToken);
    expect(a).not.toBe(b);
  });

  it('returns an empty string unchanged', () => {
    expect(redactString('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// redact — object/string dispatch
// ---------------------------------------------------------------------------

describe('redact — string at root', () => {
  it('treats a root-level string as a raw credential', () => {
    const result = redact(fixture.gitleaksSecret);
    expect(typeof result).toBe('string');
    expect(result as string).toMatch(PLACEHOLDER_RE);
    expect(result as string).not.toContain(fixture.gitleaksSecret);
  });
});

describe('redact — Authorization header', () => {
  it('replaces the credential portion of a Bearer token header value', () => {
    const obj = { Authorization: `Bearer ${fixture.bearerToken}` };
    const out = redact(obj) as Record<string, string>;
    expect(out['Authorization']).toMatch(/^Bearer \[redacted:[0-9a-f]{8}\]$/);
    expect(out['Authorization']).not.toContain(fixture.bearerToken);
  });

  it('same bearer token → same placeholder (stable across artifacts)', () => {
    const obj1 = { Authorization: `Bearer ${fixture.bearerToken}` };
    const obj2 = { Authorization: `Bearer ${fixture.bearerToken}` };
    const out1 = redact(obj1) as Record<string, string>;
    const out2 = redact(obj2) as Record<string, string>;
    expect(out1['Authorization']).toBe(out2['Authorization']);
  });

  it('preserves the scheme label (Bearer) in the output', () => {
    const obj = { Authorization: `Bearer ${fixture.bearerToken}` };
    const out = redact(obj) as Record<string, string>;
    expect(out['Authorization']).toMatch(/^Bearer /);
  });
});

describe('redact — Set-Cookie header', () => {
  it('replaces the cookie value but retains the cookie name and attributes', () => {
    const obj = { 'set-cookie': fixture.setCookieValue };
    const out = redact(obj) as Record<string, string>;
    expect(out['set-cookie']).toMatch(/^session=\[redacted:[0-9a-f]{8}\]/);
    // Raw value must not appear
    expect(out['set-cookie']).not.toContain('s%3Afake_session_secret_abc123');
  });

  it('cookie header: replaces the value, retains the name', () => {
    const obj = { cookie: fixture.cookieValue };
    const out = redact(obj) as Record<string, string>;
    expect(out['cookie']).toMatch(/^session=\[redacted:[0-9a-f]{8}\]/);
    expect(out['cookie']).not.toContain('s%3Afake_session_secret_abc123');
  });

  // Fix 6: ALL cookie pairs must be redacted (not just the first one)
  it('redacts ALL cookie pairs — both SECRET1 and SECRET2 are replaced (fix 6)', () => {
    const obj = { cookie: 'a=SECRET1; b=SECRET2' };
    const out = redact(obj) as Record<string, string>;
    expect(out['cookie']).not.toContain('SECRET1');
    expect(out['cookie']).not.toContain('SECRET2');
    // Both names are preserved; both values are placeholders
    expect(out['cookie']).toMatch(/a=\[redacted:[0-9a-f]{8}\]/);
    expect(out['cookie']).toMatch(/b=\[redacted:[0-9a-f]{8}\]/);
  });

  it('redacts all pairs in a multi-pair cookie header with different values', () => {
    const multiCookie = 'session=abc123; csrf=xyz789; user=alice';
    const obj = { cookie: multiCookie };
    const out = redact(obj) as Record<string, string>;
    expect(out['cookie']).not.toContain('abc123');
    expect(out['cookie']).not.toContain('xyz789');
    expect(out['cookie']).not.toContain('alice');
  });
});

describe('redact — gitleaks secret field', () => {
  it('redacts a "secret" field value (gitleaks Finding)', () => {
    const obj = {
      ruleId: 'github-token',
      secret: fixture.gitleaksSecret,
      file: 'src/config.ts',
      line: 42,
    };
    const out = redact(obj) as Record<string, unknown>;
    expect(out['secret'] as string).toMatch(PLACEHOLDER_RE);
    expect(out['secret'] as string).not.toContain(fixture.gitleaksSecret);
    // Non-credential fields are preserved
    expect(out['ruleId']).toBe('github-token');
    expect(out['file']).toBe('src/config.ts');
    expect(out['line']).toBe(42);
  });

  it('redacts a "match" field value (gitleaks Finding)', () => {
    const obj = { match: fixture.gitleaksSecret, ruleId: 'generic-api-key' };
    const out = redact(obj) as Record<string, unknown>;
    expect(out['match'] as string).toMatch(PLACEHOLDER_RE);
    expect(out['ruleId']).toBe('generic-api-key');
  });
});

describe('redact — staging credential fields', () => {
  it('redacts a "password" field', () => {
    const obj = { username: 'alice@example.com', password: fixture.password };
    const out = redact(obj) as Record<string, unknown>;
    expect(out['password'] as string).toMatch(PLACEHOLDER_RE);
    expect(out['password'] as string).not.toContain(fixture.password);
    expect(out['username']).toBe('alice@example.com');
  });

  it('redacts a "token" field', () => {
    const obj = { userId: 1, token: fixture.apiKey };
    const out = redact(obj) as Record<string, unknown>;
    expect(out['token'] as string).toMatch(PLACEHOLDER_RE);
    expect(out['userId']).toBe(1);
  });
});

describe('redact — non-secret context is preserved', () => {
  it('retains file, rule id, line number alongside a redacted secret', () => {
    const finding = {
      ruleId: 'gitleaks-github-pat',
      file: 'src/db/seed.ts',
      startLine: 7,
      secret: fixture.gitleaksSecret,
      message: 'GitHub Personal Access Token detected',
    };
    const out = redact(finding) as Record<string, unknown>;
    expect(out['ruleId']).toBe('gitleaks-github-pat');
    expect(out['file']).toBe('src/db/seed.ts');
    expect(out['startLine']).toBe(7);
    expect(out['message']).toBe('GitHub Personal Access Token detected');
    expect(out['secret'] as string).toMatch(PLACEHOLDER_RE);
  });
});

describe('redact — nested objects and arrays', () => {
  it('recursively redacts credential fields inside nested objects', () => {
    const obj = {
      target: { host: 'staging.example.com' },
      headers: {
        Authorization: `Bearer ${fixture.bearerToken}`,
        'Content-Type': 'application/json',
      },
    };
    const out = redact(obj) as { target: Record<string, string>; headers: Record<string, string> };
    expect(out.headers['Authorization']).toMatch(/^Bearer \[redacted:[0-9a-f]{8}\]$/);
    expect(out.headers['Content-Type']).toBe('application/json');
    expect(out.target['host']).toBe('staging.example.com');
  });

  it('recursively redacts credential fields inside arrays', () => {
    const arr = [
      { secret: fixture.gitleaksSecret, file: 'a.ts' },
      { secret: fixture.apiKey, file: 'b.ts' },
    ];
    const out = redact(arr) as Array<Record<string, unknown>>;
    expect(out[0]?.['secret'] as string).toMatch(PLACEHOLDER_RE);
    expect(out[1]?.['secret'] as string).toMatch(PLACEHOLDER_RE);
    expect(out[0]?.['file']).toBe('a.ts');
    expect(out[1]?.['file']).toBe('b.ts');
    // Different secrets → different placeholders
    expect(out[0]?.['secret']).not.toBe(out[1]?.['secret']);
  });
});

describe('redact — fail-safe / edge cases', () => {
  it('passes null through unchanged', () => {
    expect(redact(null)).toBeNull();
  });

  it('passes numbers through unchanged', () => {
    expect(redact(42)).toBe(42);
  });

  it('passes boolean through unchanged', () => {
    expect(redact(true)).toBe(true);
  });

  it('does not throw on undefined input', () => {
    expect(() => redact(undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §10 secret-redaction guardrail: no known fixture secret survives redact()
// ---------------------------------------------------------------------------

describe('§10 secret-redaction guardrail', () => {
  const knownSecrets = [
    fixture.gitleaksSecret,
    fixture.bearerToken,
    // Raw cookie/session value extracted from the header
    's%3Afake_session_secret_abc123',
    fixture.apiKey,
    fixture.password,
  ];

  it('no known-secret fixture value survives redact() on a carrying object', () => {
    const evidenceObject = {
      Authorization: `Bearer ${fixture.bearerToken}`,
      'set-cookie': fixture.setCookieValue,
      secret: fixture.gitleaksSecret,
      password: fixture.password,
      token: fixture.apiKey,
      ruleId: 'test-rule',
      file: 'src/some.ts',
    };

    const serialized = JSON.stringify(redact(evidenceObject));

    for (const secret of knownSecrets) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('same secret reads identically across two separate redact() calls', () => {
    const obj1 = { secret: fixture.gitleaksSecret };
    const obj2 = { secret: fixture.gitleaksSecret };
    const out1 = redact(obj1) as Record<string, string>;
    const out2 = redact(obj2) as Record<string, string>;
    expect(out1['secret']).toBe(out2['secret']);
  });
});
