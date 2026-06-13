# LIVE-TLS-001 — TLS/certificate configuration issues

**Engine:** direct probe (`src/live/probes/tls.ts`)
**Scanner family:** probe
**checkId:** LIVE-TLS-001
**vulnClass:** tls
**Base severity:** high

## What it flags

TLS and certificate configuration weaknesses on the staging target, including:

- **Deprecated protocol versions** — TLS 1.0 or TLS 1.1 accepted by the server
  (both are deprecated; TLS 1.2+ required)
- **Weak cipher suites** — export-grade, NULL, RC4, or DES/3DES cipher suites
  offered in the TLS handshake
- **Certificate issues** — expired certificate, self-signed certificate in a
  non-development context, hostname mismatch between the certificate CN/SAN and
  the scanned host, certificate chain validation failures
- **Missing HSTS header** — HTTP Strict Transport Security not set, allowing
  protocol downgrade attacks (see also `LIVE-HDR-001`)
- **Mixed content / HTTP redirect** — the host redirects HTTP to HTTPS
  incorrectly or serves mixed content

## Why it matters

Weak TLS configuration allows network-level attackers to intercept or tamper
with traffic via protocol downgrade attacks (POODLE, BEAST), weak cipher
exploitation (SWEET32, RC4 attacks), or man-in-the-middle attacks against
improperly validated certificates. Staging environments frequently inherit
TLS configuration from development and are not hardened before production
promotion.

## Fix pattern

**Restrict protocol versions** — enforce TLS 1.2 minimum (TLS 1.3 preferred)
in the server configuration:

```ts
// Express + Node HTTPS — restrict TLS versions
import https from 'node:https';

const server = https.createServer({
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.crt'),
  minVersion: 'TLSv1.2',
  cipherSuites: [
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    // ... strong suites only
  ].join(':'),
}, app);
```

**Add HSTS header** — set `Strict-Transport-Security` with a long `max-age`
and `includeSubDomains` (see `LIVE-HDR-001.md` for the full header fix pattern).

**Certificate hygiene** — use a valid, non-expired certificate from a trusted
CA (Let's Encrypt is free for staging). Ensure the certificate covers the exact
hostname used in the allowlist.

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: LIVE-TLS-001` with the
same fingerprint must be absent from the next `audit run` output. Verify that
the probe detects the correct protocol version and cipher configuration after
the server is updated and redeployed.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entry: `LIVE-TLS-001`)
