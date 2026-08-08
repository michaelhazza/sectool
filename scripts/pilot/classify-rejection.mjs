#!/usr/bin/env node
/**
 * classify-rejection.mjs — pure verdict classifier for the OpenClaw
 * disposable-repo rejection test (spec `framework-runtime-neutral-v3`
 * §12.B Chunk B1, F5 seam).
 *
 * WHY THIS EXISTS
 * The live rejection test (`rejection-test.sh`) hits real GitHub with the
 * `myatdevelopment` builder identity and cannot run in CI. Splitting the
 * pass/fail/INCONCLUSIVE decision into this importable, network-free module
 * lets `classify-rejection.test.mjs` exercise every branch — including the
 * two branches that matter most ("a forbidden action unexpectedly
 * succeeded" and "an auth/network error means we can't tell") — against
 * captured fixture probe results, with no live token.
 *
 * Contract: `classifyRejection` never throws. Malformed or unrecognised
 * input degrades to `INCONCLUSIVE`, never a thrown exception, so a caller
 * (the shell script, or a future dispatcher) can always read a verdict.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID_EXPECTED = new Set(['rejected', 'allowed']);
const VALID_OBSERVED = new Set(['rejected', 'allowed', 'error']);

// The 7 canonical probes rejection-test.sh emits (spec §13.4/§13.5, §14).
// F2 (security hardening, adversarial review): a run that never attempted
// (say) the delete-default-branch probe — because the script errored out
// early, or a future edit dropped a probe — must not be able to reach PASS
// just because every probe that DID run happened to succeed. Overridable via
// opts.requiredProbes for testability.
const DEFAULT_REQUIRED_PROBES = [
  'positive-control',
  'direct-push-default',
  'force-push-default',
  'delete-default-branch',
  'merge-without-approval',
  'agent-approval-openclaw-pr',
  'agent-approval-claude-pr',
];

/**
 * @typedef {Object} ProbeResult
 * @property {string} [name]
 * @property {string} [action]
 * @property {'rejected'|'allowed'} expected
 * @property {'rejected'|'allowed'|'error'} observed
 * @property {string} [detail]
 */

/**
 * Classifies a set of probe results from the OpenClaw rejection test.
 *
 * Rules (spec §13.4/§13.5, §14):
 *  - Any probe whose forbidden action was OBSERVED ALLOWED (expected
 *    "rejected", observed "allowed") -> FAIL, with a loud reason naming the
 *    action.
 *  - Any probe observed "error" (auth/network failure) -> INCONCLUSIVE; this
 *    blocks Phase B exactly like FAIL, it just means the gate is unproven
 *    rather than proven-broken.
 *  - The positive-control probe (expected "allowed" — e.g. push a feature
 *    branch / open a PR) observed "rejected" -> FAIL.
 *  - A definitive FAIL always outranks an INCONCLUSIVE when both are
 *    present in the same run: a proven security failure is a stronger
 *    signal than an unproven probe, so FAIL wins the verdict.
 *  - F2: PASS additionally requires every probe in the required set (the 7
 *    canonical probes by default, see DEFAULT_REQUIRED_PROBES) to have run
 *    at all. A required probe absent from the input -> INCONCLUSIVE, naming
 *    the missing probe(s), even when every probe that DID run succeeded.
 *  - All expected outcomes met (and no errors, and nothing required is
 *    missing) -> PASS.
 *
 * @param {ProbeResult[]} probeResults
 * @param {{requiredProbes?: string[]}} [opts] - requiredProbes overrides
 *   DEFAULT_REQUIRED_PROBES (testability seam).
 * @returns {{verdict: 'PASS'|'FAIL'|'INCONCLUSIVE', reasons: string[]}}
 */
export function classifyRejection(probeResults, opts = {}) {
  try {
    if (!Array.isArray(probeResults) || probeResults.length === 0) {
      return {
        verdict: 'INCONCLUSIVE',
        reasons: ['no probe results supplied — cannot determine a verdict'],
      };
    }

    const requiredProbes = Array.isArray(opts.requiredProbes) ? opts.requiredProbes : DEFAULT_REQUIRED_PROBES;

    const failReasons = [];
    const inconclusiveReasons = [];
    const seenNames = new Set();

    for (const probe of probeResults) {
      if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
        inconclusiveReasons.push('malformed probe entry (not an object)');
        continue;
      }

      const { name, action, expected, observed, detail } = probe;
      if (typeof name === 'string') seenNames.add(name);
      const label = name || action || '(unnamed probe)';

      if (!VALID_EXPECTED.has(expected) || !VALID_OBSERVED.has(observed)) {
        inconclusiveReasons.push(
          `${label}: malformed probe result (expected=${JSON.stringify(expected)}, observed=${JSON.stringify(observed)})`,
        );
        continue;
      }

      if (observed === 'error') {
        inconclusiveReasons.push(
          `${label}: probe errored (auth/network) — cannot confirm expected outcome "${expected}" for action "${action}"${detail ? `: ${detail}` : ''}`,
        );
        continue;
      }

      if (expected !== observed) {
        const message = expected === 'rejected'
          ? `forbidden action "${action}" was OBSERVED ALLOWED (expected rejected) — GitHub did not block it`
          : `expected-allowed action "${action}" was OBSERVED REJECTED (positive control failed)`;
        failReasons.push(`${label}: ${message}${detail ? ` — ${detail}` : ''}`);
      }
    }

    const missingProbes = requiredProbes.filter((requiredName) => !seenNames.has(requiredName));
    if (missingProbes.length > 0) {
      inconclusiveReasons.unshift(
        `missing required probe(s): ${missingProbes.join(', ')} — cannot confirm PASS without every canonical probe having run`,
      );
    }

    if (failReasons.length > 0) {
      return { verdict: 'FAIL', reasons: failReasons };
    }
    if (inconclusiveReasons.length > 0) {
      return { verdict: 'INCONCLUSIVE', reasons: inconclusiveReasons };
    }
    return { verdict: 'PASS', reasons: ['all probes met their expected outcome'] };
  } catch (err) {
    return { verdict: 'INCONCLUSIVE', reasons: [`classifier error: ${err && err.message ? err.message : String(err)}`] };
  }
}

// --- CLI mode -------------------------------------------------------------
// Reads newline-delimited JSON probe results from stdin, prints the verdict
// as JSON to stdout, and exits with a code matching the verdict so the
// calling shell script can gate on it: 0 = PASS, 1 = FAIL, 2 = INCONCLUSIVE.
async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

async function main() {
  const lines = await readStdinLines();
  const probeResults = [];
  const parseErrors = [];
  for (const line of lines) {
    try {
      probeResults.push(JSON.parse(line));
    } catch (err) {
      parseErrors.push(`unparseable probe line: ${line} (${err.message})`);
    }
  }

  const result = classifyRejection(probeResults);
  if (parseErrors.length > 0) {
    result.reasons = [...parseErrors, ...result.reasons];
    if (result.verdict === 'PASS') result.verdict = 'INCONCLUSIVE';
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ verdict: 'INCONCLUSIVE', reasons: [`unexpected error: ${err.message}`] }, null, 2)}\n`);
    process.exit(2);
  });
}
