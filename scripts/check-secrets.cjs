#!/usr/bin/env node
'use strict';
/**
 * check-secrets.js — provider-shaped secret sweep over tracked files.
 *
 * Framework-synced managed file (manifest category: helper-script). Plain
 * node, zero dependencies. Runs two ways:
 *   - framework repo CI: `node scripts/check-secrets.js` (direct step)
 *   - consumer repos: via the gates wrapper `scripts/gates/verify-no-secrets.sh`
 *
 * Layered posture: enable the hosting provider's secret scanning + push
 * protection to cover full git HISTORY and block future pushes at the
 * platform layer (done for the framework repo 2026-07-16). This gate covers
 * the WORKING TREE on every CI run, so a token that slips past the platform
 * (new provider format, fork PR, offline mirror) still fails the build
 * before merge.
 *
 * Contract:
 *   - Scans every `git ls-files` path (tracked + staged). Zero files scanned
 *     is a misconfiguration, not a pass (proof-of-life).
 *   - Patterns are provider-shaped (AWS, GitHub, OpenAI/Anthropic, Stripe,
 *     Slack, Google, private-key blocks) — deliberately NOT generic entropy
 *     heuristics, which drown the signal in kebab-case-heavy repos like this.
 *   - Exemptions live ONLY in the allowlist JSON (default
 *     scripts/check-secrets-allowlist.json; override with the
 *     CHECK_SECRETS_ALLOWLIST env var — the gates wrapper points it at
 *     scripts/gates/.baselines/secrets-allowlist.json), one exact
 *     instance per entry: { path, sha256, reason }. Category-level or
 *     pattern-level exemptions are rejected (exit 2). An allowlist entry that
 *     suppresses nothing this run is stale and FAILS the gate (exit 1) —
 *     baselines are debt instruments and must not outlive their debt.
 *   - Findings print a redacted preview plus the full sha256 fingerprint so an
 *     operator can author an allowlist entry without the secret ever being
 *     echoed into CI logs.
 *
 * Exit codes: 0 = clean; 1 = findings or stale allowlist entries;
 *             2 = misconfiguration (git failure, zero files, unreadable
 *                 tracked file, malformed allowlist). All non-zero fail CI.
 *
 * Usage: node scripts/check-secrets.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ALLOWLIST_REL = 'scripts/check-secrets-allowlist.json';
const NUL = String.fromCharCode(0);

// Extensions never scanned (binary assets). Everything else is sniffed for a
// NUL byte and skipped as binary if one is found.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2',
  '.ttf', '.eot', '.otf', '.pdf', '.zip', '.gz', '.jar',
]);

// Provider-shaped token patterns. Notes on deliberate shape choices:
//  - The sk- family (OpenAI/Anthropic) carries a lookbehind so `risk-...`
//    kebab slugs never match, and a require-a-digit lookahead so English
//    kebab phrases (`sk-class-split-...`) never match while real keys
//    (random alphanumerics) virtually always do.
//  - The private-key pattern source is written `-{5}` so this file's own
//    source never contains the literal header it hunts.
const PATTERNS = [
  { id: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'openai-anthropic-key', re: /(?<![A-Za-z0-9-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}/g },
  { id: 'stripe-secret-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'private-key-block', re: new RegExp('-{5}BEGIN (?:[A-Z]+ )*PRIVATE KEY-{5}', 'g') },
];

function fingerprint(match) {
  return crypto.createHash('sha256').update(match, 'utf8').digest('hex');
}

/** Scan one file's content. Returns findings: { path, line, patternId, match }. */
function scanContent(relPath, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { id, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        findings.push({ path: relPath, line: i + 1, patternId: id, match: m[0] });
        if (m.index === re.lastIndex) re.lastIndex++; // zero-width safety
      }
    }
  }
  return findings;
}

/**
 * Validate the allowlist shape. Every entry must be an exact instance:
 * non-empty path, 64-hex sha256, non-empty reason. Anything looser (missing
 * fingerprint, glob-ish path, pattern-level exemption) is a config error —
 * category-level exemptions silently admit new members.
 */
function validateAllowlist(raw) {
  const errors = [];
  if (!Array.isArray(raw)) return { entries: [], errors: ['allowlist root must be an array'] };
  raw.forEach((e, idx) => {
    if (!e || typeof e !== 'object') { errors.push(`entry ${idx}: not an object`); return; }
    if (typeof e.path !== 'string' || !e.path.trim()) errors.push(`entry ${idx}: missing exact "path"`);
    else if (/[*?[\]]/.test(e.path)) errors.push(`entry ${idx}: path "${e.path}" contains glob characters — exact instances only`);
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) errors.push(`entry ${idx}: "sha256" must be the 64-hex fingerprint of the exact match`);
    if (typeof e.reason !== 'string' || !e.reason.trim()) errors.push(`entry ${idx}: missing "reason"`);
  });
  return { entries: errors.length ? [] : raw, errors };
}

/**
 * Core run, injectable for tests.
 * Returns { status: 'clean'|'findings'|'config-error', findings, staleEntries,
 *           scanned, skippedBinary, errors }.
 */
function runScan({ files, readFileFn, allowlist }) {
  const errors = [];
  const { entries, errors: allowlistErrors } = validateAllowlist(allowlist);
  errors.push(...allowlistErrors);

  if (!Array.isArray(files) || files.length === 0) {
    errors.push('zero files to scan — file enumeration is broken, refusing to pass');
  }
  if (errors.length) return { status: 'config-error', findings: [], staleEntries: [], scanned: 0, skippedBinary: 0, errors };

  let scanned = 0;
  let skippedBinary = 0;
  const rawFindings = [];
  for (const rel of files) {
    if (BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase())) { skippedBinary++; continue; }
    let content;
    try {
      content = readFileFn(rel);
    } catch (err) {
      errors.push(`unreadable tracked file ${rel}: ${err.message}`);
      continue;
    }
    if (content.includes(NUL)) { skippedBinary++; continue; }
    scanned++;
    rawFindings.push(...scanContent(rel, content));
  }
  if (scanned === 0) {
    errors.push('zero text files scanned (all inputs binary-skipped) — the sweep verified nothing, refusing to pass');
  }
  if (errors.length) return { status: 'config-error', findings: [], staleEntries: [], scanned, skippedBinary, errors };

  const usedEntries = new Set();
  const findings = rawFindings.filter((f) => {
    const hit = entries.find((e) => e.path === f.path && e.sha256 === fingerprint(f.match));
    if (hit) { usedEntries.add(hit); return false; }
    return true;
  });
  const staleEntries = entries.filter((e) => !usedEntries.has(e));

  return {
    status: findings.length || staleEntries.length ? 'findings' : 'clean',
    findings, staleEntries, scanned, skippedBinary, errors,
  };
}

function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split(NUL).filter(Boolean);
}

function redact(match) {
  return `${match.slice(0, 6)}…(${match.length} chars)`;
}

function main() {
  let files;
  try {
    files = listTrackedFiles();
  } catch (err) {
    console.error(`check-secrets: git ls-files failed: ${err.message}`);
    process.exit(2);
  }

  let allowlist = [];
  const allowlistRel = process.env.CHECK_SECRETS_ALLOWLIST || DEFAULT_ALLOWLIST_REL;
  const allowlistAbs = path.resolve(REPO_ROOT, allowlistRel);
  if (fs.existsSync(allowlistAbs)) {
    try {
      allowlist = JSON.parse(fs.readFileSync(allowlistAbs, 'utf8'));
    } catch (err) {
      console.error(`check-secrets: malformed allowlist ${allowlistRel}: ${err.message}`);
      process.exit(2);
    }
  }

  const result = runScan({
    files,
    readFileFn: (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
    allowlist,
  });

  if (result.status === 'config-error') {
    for (const e of result.errors) console.error(`check-secrets: CONFIG ERROR: ${e}`);
    process.exit(2);
  }

  for (const f of result.findings) {
    console.error(
      `check-secrets: ${f.path}:${f.line} [${f.patternId}] ${redact(f.match)} sha256=${fingerprint(f.match)}`
    );
  }
  for (const e of result.staleEntries) {
    console.error(
      `check-secrets: STALE allowlist entry (suppressed nothing this run — remove it): ${e.path} sha256=${e.sha256}`
    );
  }

  if (result.status === 'findings') {
    console.error(
      `check-secrets: FAIL — ${result.findings.length} finding(s), ${result.staleEntries.length} stale allowlist entr(ies). ` +
      `To exempt a genuine placeholder, add an exact-instance entry {path, sha256, reason} to ${allowlistRel}.`
    );
    process.exit(1);
  }

  console.log(
    `check-secrets: OK — scanned ${result.scanned} tracked files (${result.skippedBinary} binary skipped), ` +
    `${PATTERNS.length} pattern families, 0 findings.`
  );
}

module.exports = { PATTERNS, fingerprint, scanContent, validateAllowlist, runScan };

if (require.main === module) main();
