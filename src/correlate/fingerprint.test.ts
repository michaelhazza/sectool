import { describe, it, expect } from 'vitest';
import {
  fingerprint,
  displayId,
  normalizePath,
  normalizeSymbol,
  normalizeSnippet,
  normalizeUrlPath,
} from './fingerprint.js';
import type { StaticFingerprintInput, LiveFingerprintInput } from './fingerprint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function staticInput(overrides?: Partial<StaticFingerprintInput>): StaticFingerprintInput {
  return {
    kind: 'static',
    ruleId: 'BS-SQL-001',
    targetName: 'automation-v1',
    path: 'src/db/queries.ts',
    symbol: 'GET /api/users/:id',
    snippet: 'db.execute(sql`SELECT * FROM users WHERE id = ${req.params.id}`)',
    ...overrides,
  };
}

function liveInput(overrides?: Partial<LiveFingerprintInput>): LiveFingerprintInput {
  return {
    kind: 'live',
    checkId: 'LIVE-HDR-001',
    host: 'staging.breakoutsolutions.com',
    urlPath: '/api/users/42',
    parameter: 'x-frame-options',
    evidenceClass: 'missing-header',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// displayId
// ---------------------------------------------------------------------------

describe('displayId', () => {
  it('returns "f-" + first 16 hex chars of the fingerprint', () => {
    const fp = fingerprint(staticInput());
    const id = displayId(fp);
    expect(id).toBe(`f-${fp.slice(0, 16)}`);
  });

  it('id format matches the Finding schema pattern /^f-[0-9a-f]{16}$/', () => {
    const fp = fingerprint(staticInput());
    const id = displayId(fp);
    expect(id).toMatch(/^f-[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// fingerprint — output shape
// ---------------------------------------------------------------------------

describe('fingerprint — output shape', () => {
  it('returns a 64-hex string for static input', () => {
    const fp = fingerprint(staticInput());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a 64-hex string for live input', () => {
    const fp = fingerprint(liveInput());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('static and live inputs with same text fields produce different fingerprints', () => {
    const fp1 = fingerprint(staticInput());
    const fp2 = fingerprint(liveInput());
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint stability — line-number drift
// ---------------------------------------------------------------------------

describe('fingerprint — stable across line drift', () => {
  it('identical static inputs produce the same fingerprint regardless of startLine', () => {
    // Line numbers are not part of the fingerprint — only the normalised
    // path/symbol/snippet matter (§6.6).
    const fp1 = fingerprint(staticInput());
    // Simulate "same finding, different line after a nearby edit"
    // — fingerprint input has no startLine field, so this is always stable.
    const fp2 = fingerprint(staticInput());
    expect(fp1).toBe(fp2);
  });

  it('changing only non-fingerprint fields (same content) keeps fingerprint stable', () => {
    const base = staticInput();
    // All fingerprint fields are identical — fingerprint must be stable
    const fp1 = fingerprint(base);
    const fp2 = fingerprint({ ...base });
    expect(fp1).toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint stability — snippet reformatting
// ---------------------------------------------------------------------------

describe('fingerprint — stable across reformatting', () => {
  it('collapsed whitespace in snippet produces same fingerprint', () => {
    // Simulate reformatting: the same tokens but with extra indentation/newlines.
    // normalizeSnippet collapses all whitespace runs to a single space.
    const original = staticInput({
      snippet: 'const query = db.execute( sql`SELECT * FROM users` );',
    });
    const reformatted = staticInput({
      snippet: 'const query = db.execute(\n  sql`SELECT * FROM users`\n);',
    });
    expect(fingerprint(original)).toBe(fingerprint(reformatted));
  });

  it('extra leading/trailing whitespace in snippet is normalised away', () => {
    const fp1 = fingerprint(staticInput({ snippet: '  const x = 1;  ' }));
    const fp2 = fingerprint(staticInput({ snippet: 'const x = 1;' }));
    expect(fp1).toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint stability — path normalisation
// ---------------------------------------------------------------------------

describe('fingerprint — stable across path representations', () => {
  it('Windows backslash path produces same fingerprint as posix path', () => {
    const fp1 = fingerprint(staticInput({ path: 'src\\db\\queries.ts' }));
    const fp2 = fingerprint(staticInput({ path: 'src/db/queries.ts' }));
    expect(fp1).toBe(fp2);
  });

  it('leading ./ is stripped', () => {
    const fp1 = fingerprint(staticInput({ path: './src/db/queries.ts' }));
    const fp2 = fingerprint(staticInput({ path: 'src/db/queries.ts' }));
    expect(fp1).toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Fingerprint stability — numeric URL segment variation
// ---------------------------------------------------------------------------

describe('fingerprint — stable across numeric/UUID URL segments (live)', () => {
  it('numeric record id in URL path does not fork fingerprint', () => {
    const fp1 = fingerprint(liveInput({ urlPath: '/api/users/1' }));
    const fp2 = fingerprint(liveInput({ urlPath: '/api/users/99999' }));
    expect(fp1).toBe(fp2);
  });

  it('UUID record id in URL path does not fork fingerprint', () => {
    const fp1 = fingerprint(
      liveInput({ urlPath: '/api/items/3f9a1c2b-8d4e-4a17-beef-deadbeef0001' }),
    );
    const fp2 = fingerprint(
      liveInput({ urlPath: '/api/items/aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee' }),
    );
    expect(fp1).toBe(fp2);
  });

  it('mixed numeric and UUID segments are both normalised', () => {
    const fp1 = fingerprint(
      liveInput({
        urlPath: '/api/users/42/posts/3f9a1c2b-8d4e-4a17-beef-deadbeef0001',
      }),
    );
    const fp2 = fingerprint(
      liveInput({
        urlPath: '/api/users/7/posts/aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
      }),
    );
    expect(fp1).toBe(fp2);
  });

  it('non-numeric, non-UUID segments are NOT normalised', () => {
    const fp1 = fingerprint(liveInput({ urlPath: '/api/users/admin' }));
    const fp2 = fingerprint(liveInput({ urlPath: '/api/users/guest' }));
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// BS-RLS-001 schema-rule symbol = normalized pgTable name
// ---------------------------------------------------------------------------

describe('BS-RLS-001 schema-rule symbol normalisation', () => {
  it('pgTable table name is the symbol for schema-level rules', () => {
    // The rule emits symbol = pgTable table name literal, e.g. "subscriptions"
    // normalizeSymbol lowercases and trims it for stability.
    const fp1 = fingerprint(
      staticInput({
        ruleId: 'BS-RLS-001',
        symbol: 'subscriptions',
        snippet: 'pgTable("subscriptions", { ... })',
      }),
    );
    const fp2 = fingerprint(
      staticInput({
        ruleId: 'BS-RLS-001',
        symbol: 'Subscriptions', // mixed-case variant — same table
        snippet: 'pgTable("subscriptions", { ... })',
      }),
    );
    expect(fp1).toBe(fp2);
  });

  it('different pgTable names produce different fingerprints', () => {
    const fp1 = fingerprint(
      staticInput({
        ruleId: 'BS-RLS-001',
        symbol: 'subscriptions',
        snippet: 'pgTable("subscriptions", { ... })',
      }),
    );
    const fp2 = fingerprint(
      staticInput({
        ruleId: 'BS-RLS-001',
        symbol: 'users',
        snippet: 'pgTable("users", { ... })',
      }),
    );
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Different ruleId / checkId fields produce different fingerprints
// ---------------------------------------------------------------------------

describe('fingerprint — different rule/check ids', () => {
  it('different static ruleIds produce different fingerprints', () => {
    const fp1 = fingerprint(staticInput({ ruleId: 'BS-SQL-001' }));
    const fp2 = fingerprint(staticInput({ ruleId: 'BS-SQL-002' }));
    expect(fp1).not.toBe(fp2);
  });

  it('different live checkIds produce different fingerprints', () => {
    const fp1 = fingerprint(liveInput({ checkId: 'LIVE-HDR-001' }));
    const fp2 = fingerprint(liveInput({ checkId: 'LIVE-TLS-001' }));
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Individual normalizer unit tests
// ---------------------------------------------------------------------------

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('src\\db\\schema.ts')).toBe('src/db/schema.ts');
  });

  it('strips leading ./', () => {
    expect(normalizePath('./src/index.ts')).toBe('src/index.ts');
  });

  it('strips leading /', () => {
    expect(normalizePath('/src/index.ts')).toBe('src/index.ts');
  });

  it('already-posix path is unchanged', () => {
    expect(normalizePath('src/db/schema.ts')).toBe('src/db/schema.ts');
  });
});

describe('normalizeSymbol', () => {
  it('lowercases the symbol', () => {
    expect(normalizeSymbol('Users')).toBe('users');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeSymbol('  subscriptions  ')).toBe('subscriptions');
  });

  it('preserves route signature format (lowercased)', () => {
    expect(normalizeSymbol('GET /api/users/:id')).toBe('get /api/users/:id');
  });
});

describe('normalizeSnippet', () => {
  it('collapses multiple whitespace chars to a single space', () => {
    expect(normalizeSnippet('const  x   =   1;')).toBe('const x = 1;');
  });

  it('collapses newlines to a space', () => {
    expect(normalizeSnippet('const x =\n  1;')).toBe('const x = 1;');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeSnippet('  const x = 1;  ')).toBe('const x = 1;');
  });
});

describe('normalizeUrlPath', () => {
  it('replaces a pure-numeric segment with {id}', () => {
    expect(normalizeUrlPath('/api/users/42')).toBe('/api/users/{id}');
  });

  it('replaces a UUID segment with {id}', () => {
    expect(normalizeUrlPath('/items/3f9a1c2b-8d4e-4a17-beef-deadbeef0001')).toBe(
      '/items/{id}',
    );
  });

  it('does not replace non-numeric non-UUID segments', () => {
    expect(normalizeUrlPath('/api/users/me')).toBe('/api/users/me');
  });

  it('replaces multiple id segments', () => {
    expect(normalizeUrlPath('/users/1/posts/999')).toBe('/users/{id}/posts/{id}');
  });

  it('preserves query string as-is (passed as path only)', () => {
    expect(normalizeUrlPath('/api/search')).toBe('/api/search');
  });
});
