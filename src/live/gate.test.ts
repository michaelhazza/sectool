import { describe, it, expect } from 'vitest';
import { assertAllowlisted, AllowlistViolationError } from './gate.js';
import type { AllowedTarget } from './gate.js';
import type { LoadedAllowlist } from '../config/load.js';

// ---------------------------------------------------------------------------
// Test helpers — build a LoadedAllowlist without going through the filesystem.
// The brand is a type-level intersection; the runtime value is just the shape.
// We cast via `unknown` to satisfy the branded type — the same technique used
// internally in load.ts's mintAllowlist().
// ---------------------------------------------------------------------------

function makeAllowlist(
  hosts: Array<{ host: string; owner?: string; addedAt?: string }>,
): LoadedAllowlist {
  const entries = hosts.map((h) => ({
    host: h.host,
    owner: h.owner ?? 'test',
    addedAt: h.addedAt ?? '2026-01-01',
  }));
  return { hosts: entries } as unknown as LoadedAllowlist;
}

const STAGING_HOST = 'staging.example.breakout.dev';
const SINGLE_HOST_ALLOWLIST = makeAllowlist([{ host: STAGING_HOST }]);
const EMPTY_ALLOWLIST = makeAllowlist([]);

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('assertAllowlisted — happy path', () => {
  it('returns an AllowedTarget for a valid https URL on an allowlisted host', () => {
    const target = assertAllowlisted(`https://${STAGING_HOST}/`, SINGLE_HOST_ALLOWLIST);
    expect(target.url).toBe(`https://${STAGING_HOST}/`);
    expect(target.hostname).toBe(STAGING_HOST);
  });

  it('accepts the explicit port 443 as default', () => {
    const target = assertAllowlisted(
      `https://${STAGING_HOST}:443/path`,
      SINGLE_HOST_ALLOWLIST,
    );
    expect(target.hostname).toBe(STAGING_HOST);
  });

  it('accepts URLs with paths and query strings', () => {
    const target = assertAllowlisted(
      `https://${STAGING_HOST}/api/v1?foo=bar`,
      SINGLE_HOST_ALLOWLIST,
    );
    expect(target.hostname).toBe(STAGING_HOST);
  });

  it('AllowedTarget has url and hostname properties (no network I/O occurs)', () => {
    const target: AllowedTarget = assertAllowlisted(
      `https://${STAGING_HOST}/`,
      SINGLE_HOST_ALLOWLIST,
    );
    // Pure parse — if we got here without a network call, the invariant holds.
    expect(typeof target.url).toBe('string');
    expect(typeof target.hostname).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Empty allowlist rejects everything
// ---------------------------------------------------------------------------

describe('assertAllowlisted — empty allowlist', () => {
  it('rejects an otherwise valid https URL when the allowlist is empty', () => {
    expect(() =>
      assertAllowlisted(`https://${STAGING_HOST}/`, EMPTY_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });

  it('error message mentions the rejected host', () => {
    expect(() =>
      assertAllowlisted(`https://${STAGING_HOST}/`, EMPTY_ALLOWLIST),
    ).toThrow(new RegExp(STAGING_HOST));
  });
});

// ---------------------------------------------------------------------------
// Non-https scheme rejected (§4.2 clause a)
// ---------------------------------------------------------------------------

describe('assertAllowlisted — non-https scheme', () => {
  it('rejects http://', () => {
    expect(() =>
      assertAllowlisted(`http://${STAGING_HOST}/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects http:// with error mentioning scheme', () => {
    expect(() =>
      assertAllowlisted(`http://${STAGING_HOST}/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(/http:/);
  });

  it('rejects ftp://', () => {
    expect(() =>
      assertAllowlisted(`ftp://${STAGING_HOST}/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects invalid URL string', () => {
    expect(() =>
      assertAllowlisted('not-a-url', SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });
});

// ---------------------------------------------------------------------------
// Wrong host rejected (§4.2 clause b)
// ---------------------------------------------------------------------------

describe('assertAllowlisted — hostname not on allowlist', () => {
  it('rejects a host not on the allowlist', () => {
    expect(() =>
      assertAllowlisted('https://notallowed.example.com/', SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects a subdomain of an allowlisted host (exact match only)', () => {
    expect(() =>
      assertAllowlisted(`https://sub.${STAGING_HOST}/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects a host that is a prefix of an allowlisted host', () => {
    const partial = STAGING_HOST.slice(0, -4); // strip last chars
    expect(() =>
      assertAllowlisted(`https://${partial}/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });
});

// ---------------------------------------------------------------------------
// Non-default port rejected (§4.2 clause c)
// ---------------------------------------------------------------------------

describe('assertAllowlisted — non-default port', () => {
  it('rejects port 8443', () => {
    expect(() =>
      assertAllowlisted(`https://${STAGING_HOST}:8443/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects port 80', () => {
    expect(() =>
      assertAllowlisted(`https://${STAGING_HOST}:80/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects port 3000', () => {
    expect(() =>
      assertAllowlisted(`https://${STAGING_HOST}:3000/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(AllowlistViolationError);
  });

  it('error message mentions the port', () => {
    expect(() =>
      assertAllowlisted(`https://${STAGING_HOST}:8443/`, SINGLE_HOST_ALLOWLIST),
    ).toThrow(/8443/);
  });
});

// ---------------------------------------------------------------------------
// IP-literal rejection — §10 allowlist IP-literal rejection guardrail (§4.2 clause d)
// The production gate must reject ALL IP-literal forms.
// ---------------------------------------------------------------------------

describe('assertAllowlisted — IP-literal rejection (§10 guardrail)', () => {
  // Build an allowlist that contains the dotted-decimal form so clause (b)
  // cannot interfere — we're testing that clause (d) fires first (before any
  // string comparison passes). In practice the §6.3 AllowlistSchema already
  // rejects IP literals in production config, but the gate must be independently
  // robust — a loopback IP on a specially-crafted benchmark allowlist must still
  // be caught by the gate itself.
  //
  // We use a direct cast (same as makeAllowlist) to simulate that edge case.

  function makeIpAllowlist(ip: string): LoadedAllowlist {
    return {
      hosts: [{ host: ip, owner: 'test', addedAt: '2026-01-01' }],
    } as unknown as LoadedAllowlist;
  }

  // Dotted-decimal IPv4
  it('rejects https://127.0.0.1/', () => {
    expect(() =>
      assertAllowlisted('https://127.0.0.1/', makeIpAllowlist('127.0.0.1')),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects https://192.168.1.1/', () => {
    expect(() =>
      assertAllowlisted('https://192.168.1.1/', makeIpAllowlist('192.168.1.1')),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects https://10.0.0.1/', () => {
    expect(() =>
      assertAllowlisted('https://10.0.0.1/', makeIpAllowlist('10.0.0.1')),
    ).toThrow(AllowlistViolationError);
  });

  // Numeric IPv4 (Node-accepted integer form) — new URL('https://2130706433/').hostname === '2130706433'
  it('rejects numeric IPv4 https://2130706433/ (= 127.0.0.1)', () => {
    expect(() =>
      assertAllowlisted('https://2130706433/', makeIpAllowlist('2130706433')),
    ).toThrow(AllowlistViolationError);
  });

  // Hex IPv4 — new URL('https://0x7f000001/').hostname === '0x7f000001'
  it('rejects hex IPv4 https://0x7f000001/ (= 127.0.0.1)', () => {
    expect(() =>
      assertAllowlisted('https://0x7f000001/', makeIpAllowlist('0x7f000001')),
    ).toThrow(AllowlistViolationError);
  });

  // Bracketed IPv6 — new URL('https://[::1]/').hostname === '[::1]'
  it('rejects bracketed IPv6 https://[::1]/', () => {
    expect(() =>
      assertAllowlisted('https://[::1]/', makeIpAllowlist('[::1]')),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects bracketed IPv4-mapped IPv6 https://[::ffff:127.0.0.1]/', () => {
    expect(() =>
      assertAllowlisted(
        'https://[::ffff:127.0.0.1]/',
        makeIpAllowlist('[::ffff:127.0.0.1]'),
      ),
    ).toThrow(AllowlistViolationError);
  });

  it('rejects bracketed full IPv6 https://[2001:db8::1]/', () => {
    expect(() =>
      assertAllowlisted('https://[2001:db8::1]/', makeIpAllowlist('[2001:db8::1]')),
    ).toThrow(AllowlistViolationError);
  });

  // Error message mentions IP-literal
  it('error message for IP-literal mentions the hostname', () => {
    expect(() =>
      assertAllowlisted('https://127.0.0.1/', makeIpAllowlist('127.0.0.1')),
    ).toThrow(/127\.0\.0\.1/);
  });

  // Confirm no network I/O: these are pure parse/throw — the test reaching this
  // line without hanging proves no DNS/HTTP was attempted.
  it('throws synchronously with no async I/O for dotted-decimal IP', () => {
    let threw = false;
    try {
      assertAllowlisted('https://127.0.0.1/', makeIpAllowlist('127.0.0.1'));
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(AllowlistViolationError);
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AllowlistViolationError properties
// ---------------------------------------------------------------------------

describe('AllowlistViolationError', () => {
  it('is an instance of Error', () => {
    const err = new AllowlistViolationError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name AllowlistViolationError', () => {
    const err = new AllowlistViolationError('test');
    expect(err.name).toBe('AllowlistViolationError');
  });

  it('carries the provided message', () => {
    const err = new AllowlistViolationError('denied: foo');
    expect(err.message).toMatch(/denied: foo/);
  });
});
