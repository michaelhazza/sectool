/**
 * build-certification-manifest.mjs — deterministic certification-tail builder
 * (plan A7, round-3 finding 4 + round-4 finding 4/5, round-5 finding 7). NEVER
 * an agent.
 *
 * After UAT passes, finalisation commits durable reports/status/evidence — the
 * "certification tail" X..Y where X = code_candidate_sha and Y =
 * certification_head_sha. That tail must consist ENTIRELY of permitted
 * certification-only changes, validated against a manifest generated BEFORE the
 * commit — not classified after the fact (which would leave an evidence-tamper
 * rail: edit uat-evidence.json + its recorded digest in one commit).
 *
 * Two hard rules from the plan:
 *   - The manifest is generated BEFORE the certification commit and does NOT
 *     contain the eventual commit SHA (no committed file contains its own commit
 *     SHA). certification_head_sha is derived from git AFTER the commit exists.
 *   - The manifest itself is OUT-OF-BAND: it is a coordinator-side validation
 *     input retained as a durable run artifact, NEVER part of the certification
 *     commit (committing it with a self-entry recreates the recursion one level
 *     down). buildCertificationManifest therefore returns an object to persist
 *     to evidence-tier storage, not a file to add to the commit.
 *
 * The builder accepts ONLY the validated UAT artifact set plus fixed
 * framework-owned operations, and rejects an already-dirty tree carrying
 * unexpected changes.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSha256 } from './canonicalize.mjs';

/** The exact set of paths a certification commit is permitted to touch for a
 *  build slug. Everything else is application/harness-impacting and forbidden in
 *  the certification tail. Kept narrow on purpose. */
export function certificationAllowedPaths(slug) {
  const base = `tasks/builds/${slug}`;
  return [
    `${base}/uat-plan.md`,
    `${base}/uat-plan.json`,
    `${base}/uat-plan-blind.json`,
    `${base}/uat-report.md`,
    `${base}/uat-evidence.json`,
    `${base}/uat-handoff.md`,
    `${base}/uat-fix-plan.md`,
    `${base}/status.json`,
    `${base}/progress.md`,
    `${base}/handoff.md`,
    'tasks/current-focus.md',
  ];
}

/**
 * Build the out-of-band certification manifest (a validation input, NOT part of
 * the commit). `artifacts` is the validated UAT artifact set: [{path, sha256, bytes}].
 * Throws if the current tree already carries changes outside the allowed set
 * (an already-dirty unexpected tree cannot be certified).
 *
 * @param {object} p
 * @param {string} p.slug
 * @param {string} p.codeCandidateSha — the tested SHA X; recorded, never the commit's own SHA
 * @param {{path:string,sha256:string,bytes:number}[]} p.artifacts
 * @param {string[]} [p.currentlyDirtyPaths] — paths already modified in the working tree
 * @returns {{schema_version:string, code_candidate_sha:string, allowed_paths:string[], expected:object[], document_sha256:string}}
 */
export function buildCertificationManifest({ slug, codeCandidateSha, artifacts, currentlyDirtyPaths = [] }) {
  if (!/^[0-9a-f]{40}$/.test(codeCandidateSha || '')) {
    throw new Error('buildCertificationManifest: code_candidate_sha must be a full 40-hex SHA');
  }
  const allowed = new Set(certificationAllowedPaths(slug));
  const unexpectedDirty = currentlyDirtyPaths.filter((p) => !allowed.has(normalize(p)));
  if (unexpectedDirty.length > 0) {
    throw new Error(`buildCertificationManifest: tree is already dirty with unexpected paths: ${unexpectedDirty.join(', ')}`);
  }
  const expected = (artifacts || []).map((a) => {
    if (!allowed.has(normalize(a.path))) {
      throw new Error(`buildCertificationManifest: artifact ${a.path} is not a permitted certification path`);
    }
    return { path: normalize(a.path), sha256: a.sha256, bytes: a.bytes };
  });
  const doc = {
    schema_version: 'uat-certification-manifest.v1',
    code_candidate_sha: codeCandidateSha,
    allowed_paths: [...allowed].sort(),
    expected: expected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  return { ...doc, document_sha256: canonicalSha256(doc) };
}

/**
 * Validate an actual certification-commit diff against the pre-generated
 * manifest. Every changed path must be in allowed_paths; nothing else may be in
 * the tail (operation-aware — the tail is permitted certification-only changes).
 * @returns {{ok:boolean, unexpected:string[]}}
 */
export function validateCertificationDiff(manifest, actualChangedPaths) {
  const allowed = new Set(manifest.allowed_paths || []);
  const unexpected = (actualChangedPaths || []).map(normalize).filter((p) => !allowed.has(p));
  return { ok: unexpected.length === 0, unexpected };
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  console.error('build-certification-manifest.mjs is a library (buildCertificationManifest / validateCertificationDiff); import it, do not run directly.');
  process.exit(2);
}
