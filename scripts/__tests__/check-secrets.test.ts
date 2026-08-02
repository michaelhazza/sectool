/**
 * Tests for scripts/check-secrets.cjs — the provider-shaped secret sweep gate.
 * Runner: Vitest (per docs/testing-conventions.md).
 *
 * Every fixture secret below is assembled by string CONCATENATION so this
 * tracked file never contains a matchable literal — the gate scans its own
 * test suite on every CI run.
 *
 * Red cases deliberately vary input dialect (quoting, comments, JSON/YAML/URL
 * context, case, CRLF) — a gate that only fails on one canonical spelling is
 * not a gate.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fingerprint, scanContent, validateAllowlist, runScan } = require('../check-secrets.cjs');

// --- concatenated fixtures (never literal) ---------------------------------
const OPENAI_LEGACY = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4o5p6';
const OPENAI_PROJ = 'sk-' + 'proj-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp';
const ANTHROPIC = 'sk-' + 'ant-' + 'api03-' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d';
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const GH_TOKEN = 'ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5';
const GH_PAT = 'github_pat_' + '11ABCDEFG0' + 'abcdefghijklmnopqrstuv';
const SLACK = 'xoxb-' + '1234567890-abcdefghij';
const GOOGLE = 'AIza' + 'SyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU4v';
const STRIPE_LIVE = 'sk_live_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7';
const STRIPE_TEST = 'sk_test_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7';
const STRIPE_RESTRICTED = 'rk_live_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7';
const DASHES = '-----';
const RSA_HEADER = DASHES + 'BEGIN RSA PRIVATE KEY' + DASHES;
const OPENSSH_HEADER = DASHES + 'BEGIN OPENSSH PRIVATE KEY' + DASHES;
const PLAIN_HEADER = DASHES + 'BEGIN PRIVATE KEY' + DASHES;

function idsIn(content: string): string[] {
  return scanContent('fixture.txt', content).map((f: { patternId: string }) => f.patternId);
}

describe('red cases — the gate fires across input dialects', () => {
  it('OpenAI legacy key in a double-quoted JS assignment', () => {
    expect(idsIn(`const OPENAI_KEY = "${OPENAI_LEGACY}";`)).toContain('openai-anthropic-key');
  });

  it('OpenAI project key in an unquoted env line', () => {
    expect(idsIn(`OPENAI_API_KEY=${OPENAI_PROJ}`)).toContain('openai-anthropic-key');
  });

  it('Anthropic key single-quoted inside a line comment (a secret in a comment is still a leak)', () => {
    expect(idsIn(`  // fallback: '${ANTHROPIC}'`)).toContain('openai-anthropic-key');
  });

  it('AWS access key as a JSON value', () => {
    expect(idsIn(`{ "aws_access_key_id": "${AWS_KEY}" }`)).toContain('aws-access-key-id');
  });

  it('GitHub token embedded in a remote URL', () => {
    expect(idsIn(`url = https://x-access-token:${GH_TOKEN}@github.com/o/r.git`)).toContain('github-token');
  });

  it('GitHub fine-grained PAT as a YAML value', () => {
    expect(idsIn(`  token: ${GH_PAT}`)).toContain('github-fine-grained-pat');
  });

  it('Slack bot token in a backtick template literal', () => {
    expect(idsIn('const h = `Bearer ' + SLACK + '`;')).toContain('slack-token');
  });

  it('Google API key inside a markdown fence line', () => {
    expect(idsIn(`    key=${GOOGLE}`)).toContain('google-api-key');
  });

  it('Stripe live, test, and restricted keys (test creds do not belong in git either)', () => {
    expect(idsIn(`stripe.api_key = '${STRIPE_LIVE}'`)).toContain('stripe-secret-key');
    expect(idsIn(`STRIPE_KEY="${STRIPE_TEST}"`)).toContain('stripe-secret-key');
    expect(idsIn(STRIPE_RESTRICTED)).toContain('stripe-secret-key');
  });

  it('private key blocks: RSA, OPENSSH, and unqualified, with LF and CRLF', () => {
    expect(idsIn(`${RSA_HEADER}\nMIIEow…`)).toContain('private-key-block');
    expect(idsIn(`prefix\r\n${OPENSSH_HEADER}\r\nb3BlbnNzaC…`)).toContain('private-key-block');
    expect(idsIn(PLAIN_HEADER)).toContain('private-key-block');
  });

  it('reports the correct 1-based line number on CRLF content', () => {
    const findings = scanContent('f.env', `A=1\r\nB=2\r\nKEY=${OPENAI_LEGACY}\r\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  it('multiple distinct tokens on one line are each reported', () => {
    const findings = scanContent('f.txt', `${AWS_KEY} and ${SLACK}`);
    expect(findings.map((f: { patternId: string }) => f.patternId).sort()).toEqual([
      'aws-access-key-id',
      'slack-token',
    ]);
  });
});

describe('green cases — decoys and placeholders must not fire', () => {
  it('kebab-case slugs containing "sk-" (the docs/decisions/README.md regression)', () => {
    expect(
      idsIn('| [0005](./0005-risk-class-split-rollout-pattern.md) | Risk-class split rollout |')
    ).toEqual([]);
  });

  it('kebab phrase starting with sk- but containing no digit', () => {
    expect(idsIn('sk-class-split-rollout-pattern-extended-name')).toEqual([]);
  });

  it('ellipsis and angle-bracket placeholders', () => {
    expect(idsIn('set OPENAI_API_KEY=sk-... in your env')).toEqual([]);
    expect(idsIn('use ghp_<your-token-here> for auth')).toEqual([]);
    expect(idsIn('SLACK_TOKEN=xoxb-<token>')).toEqual([]);
  });

  it('pattern-source strings (the gate does not match its own regex sources)', () => {
    expect(idsIn('AKIA[0-9A-Z]{16} and gh[pousr]_[A-Za-z0-9]{36,}')).toEqual([]);
  });

  it('too-short and wrong-case candidates', () => {
    expect(idsIn('AKIA' + 'ABCD1234')).toEqual([]); // 8 chars, needs 16
    expect(idsIn(('akia' + 'iosfodnn7example').toLowerCase())).toEqual([]); // AWS keys are uppercase
    expect(idsIn('ghp_' + 'onlytwentychars12345')).toEqual([]); // needs 36
  });

  it('Stripe publishable keys are not secrets', () => {
    expect(idsIn('pk_live_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7')).toEqual([]);
  });
});

describe('allowlist discipline — exact instances only, stale entries fail', () => {
  const finding = { path: 'docs/example.md', content: `token: ${OPENAI_LEGACY}` };
  const goodEntry = {
    path: finding.path,
    sha256: fingerprint(OPENAI_LEGACY),
    reason: 'documented placeholder used in adoption walkthrough',
  };

  function run(files: Record<string, string>, allowlist: unknown[] = []) {
    return runScan({
      files: Object.keys(files),
      readFileFn: (p: string) => files[p],
      allowlist,
    });
  }

  it('a matching {path, sha256, reason} entry suppresses exactly that instance', () => {
    const result = run({ [finding.path]: finding.content }, [goodEntry]);
    expect(result.status).toBe('clean');
    expect(result.findings).toEqual([]);
  });

  it('the same fingerprint in a DIFFERENT file is not suppressed', () => {
    const result = run({ 'other/file.md': finding.content }, [goodEntry]);
    expect(result.status).toBe('findings');
    expect(result.findings).toHaveLength(1);
    expect(result.staleEntries).toHaveLength(1); // and the unused entry is flagged stale
  });

  it('a stale entry (suppressing nothing) fails the run even with no findings', () => {
    const result = run({ 'clean.md': 'nothing to see' }, [goodEntry]);
    expect(result.status).toBe('findings');
    expect(result.staleEntries).toEqual([goodEntry]);
  });

  it('category-level entries are config errors: glob path, missing reason, missing fingerprint', () => {
    expect(validateAllowlist([{ path: 'docs/*.md', sha256: goodEntry.sha256, reason: 'x' }]).errors).not.toEqual([]);
    expect(validateAllowlist([{ path: 'a.md', sha256: goodEntry.sha256 }]).errors).not.toEqual([]);
    expect(validateAllowlist([{ path: 'a.md', reason: 'x' }]).errors).not.toEqual([]);
    expect(validateAllowlist({ not: 'an array' }).errors).not.toEqual([]);
  });
});

describe('fail-closed mechanics', () => {
  it('zero files to scan is a config error, never a pass (proof-of-life)', () => {
    const result = runScan({ files: [], readFileFn: () => '', allowlist: [] });
    expect(result.status).toBe('config-error');
  });

  it('an unreadable tracked file is a config error, not a silent skip', () => {
    const result = runScan({
      files: ['ghost.md'],
      readFileFn: () => {
        throw new Error('EACCES');
      },
      allowlist: [],
    });
    expect(result.status).toBe('config-error');
  });

  it('binary content (NUL byte) is skipped without matching; extension-skips never read the file', () => {
    const nul = String.fromCharCode(0);
    const result = runScan({
      files: ['blob.bin', 'img.png', 'clean.md'],
      readFileFn: (p: string) => {
        if (p === 'img.png') throw new Error('should not be read — extension-skipped');
        if (p === 'blob.bin') return `data${nul}${OPENAI_LEGACY}`;
        return 'ordinary text';
      },
      allowlist: [],
    });
    expect(result.status).toBe('clean');
    expect(result.skippedBinary).toBe(2);
    expect(result.scanned).toBe(1);
  });

  it('a run where EVERY file was binary-skipped verified nothing and must not pass', () => {
    const nul = String.fromCharCode(0);
    const result = runScan({
      files: ['blob.bin'],
      readFileFn: () => `data${nul}data`,
      allowlist: [],
    });
    expect(result.status).toBe('config-error');
  });
});
