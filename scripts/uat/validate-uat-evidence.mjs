/**
 * validate-uat-evidence.mjs — deterministic validator for uat-evidence.json.
 *
 * The coordinator populates status.json ONLY from evidence this validator
 * accepts (codex-brief §8.6). The validator is the system of record for every
 * cross-document invariant the JSON Schema cannot express: the A6 scenario-set
 * invariant, blind-plan digest/timestamp checks, the A8 risk-baseline superset,
 * recomputed artifact hashes, a deterministic secret scan, coverage
 * cross-check, realpath containment, the two-sided plan-digest identity, and
 * rejection of any `uat_enforcement_override` field (plan A2/A3 — no override
 * ships; an attempted override field is rejected, never carried dormant).
 *
 * FAIL-CLOSED: the validator never upgrades a fail/incomplete to pass/proceed.
 * It returns a flat list of {code, message}; any error => ok:false. Checks are
 * written defensively (they degrade on partially-shaped input rather than
 * throwing) so each rejection can be exercised in isolation by the test suite.
 *
 * Pure entry point: validateEvidence(evidence, opts) — no process exit, no
 * stdout. The CLI wrapper at the bottom is the only side-effecting surface.
 */

import { readFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalize, canonicalSha256, digestOf } from './canonicalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'schemas', 'uat-evidence.schema.json');
const POLICY_PATH = path.join(__dirname, 'risk-to-scenario-policy.json');

// Families whose intended branch cannot have run without seeded/stored data —
// a 200/empty/zero is vacuous evidence for these (plan A8, invariant 6).
const DATA_REQUIRING_FAMILIES = new Set([
  'success',
  'real-route-stored-rows',
  'upgrade-prior-state',
  'above-2-53',
  'aggregate-to-route-to-screen-identity',
  'screen-to-export-identity',
]);

// Deterministic secret/credential patterns (plan A8). Scanned over textual
// evidence and the evidence document itself. redaction_status:"redacted" is a
// claim, not proof — these run regardless of it.
export const SECRET_PATTERNS = [
  { name: 'authorization-header', re: /authorization\s*[:=]\s*(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { name: 'bearer-token', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { name: 'set-cookie', re: /\bset-cookie\s*:\s*\S+=\S+/i },
  { name: 'session-cookie', re: /\b(session|sid|sess|connect\.sid)=[A-Za-z0-9._%+/=-]{12,}/i },
  { name: 'db-url-with-credentials', re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s:/@]+@/i },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

let cachedValidateFn = null;
function getSchemaValidator() {
  if (cachedValidateFn) return cachedValidateFn;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidateFn = ajv.compile(schema);
  return cachedValidateFn;
}

function loadPolicy(opts) {
  if (opts.policy) return opts.policy;
  return JSON.parse(readFileSync(opts.policyPath || POLICY_PATH, 'utf8'));
}

/** Deterministic set-digest of a risk inventory: canonical hash of the risks
 *  array sorted by (tag, source). Producer and validator MUST agree on this. */
export function inventoryDigest(inv) {
  const risks = Array.isArray(inv?.risks) ? inv.risks.slice() : [];
  risks.sort((a, b) => {
    const ta = String(a?.tag ?? ''), tb = String(b?.tag ?? '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    const sa = String(a?.source ?? ''), sb = String(b?.source ?? '');
    return sa === sb ? 0 : sa < sb ? -1 : 1;
  });
  return canonicalSha256(risks);
}

function tagsOf(inv) {
  return new Set((inv?.risks || []).map((r) => r?.tag).filter(Boolean));
}

function isSuperset(sup, sub) {
  for (const x of sub) if (!sup.has(x)) return false;
  return true;
}

function deepFindKey(obj, key, trail = '$') {
  const hits = [];
  if (obj && typeof obj === 'object') {
    if (!Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)) {
      hits.push(trail + '.' + key);
    }
    for (const [k, v] of Object.entries(obj)) {
      hits.push(...deepFindKey(v, key, `${trail}.${k}`));
    }
  }
  return hits;
}

function sha256File(absPath) {
  const buf = readFileSync(absPath);
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, buf };
}

function isTextualMedia(mediaType) {
  const m = String(mediaType || '').toLowerCase();
  return (
    m.startsWith('text/') ||
    m.includes('json') ||
    m.includes('xml') ||
    m.includes('csv') ||
    m.includes('yaml') ||
    m.includes('log') ||
    m.includes('ndjson')
  );
}

function scanSecrets(text) {
  const hits = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

/**
 * @param {object} evidence — the parsed uat-evidence.json
 * @param {object} opts
 * @param {string} [opts.repoRoot] — base for resolving relative artifact paths (default: repo root)
 * @param {string[]} [opts.allowedRoots] — absolute roots artifact realpaths must sit within
 *   (default derived from slug: tasks/builds/<slug>/ and .test-runs/<slug>-uat/)
 * @param {object} [opts.policy] — parsed risk-to-scenario-policy (default: the shipped file)
 * @param {object} [opts.blindPlan] — parsed uat-plan-blind.json for cross-file digest/set checks
 * @param {object} [opts.finalPlan] — parsed uat-plan.json for expected-plan-digest recompute
 * @param {object} [opts.inputManifest] — parsed blind input manifest for input-manifest-digest + baseline
 * @param {string} [opts.reportText] — uat-report.md contents, added to the secret scan
 * @returns {{ok: boolean, errors: {code: string, message: string}[]}}
 */
export function validateEvidence(evidence, opts = {}) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  const repoRoot = opts.repoRoot || REPO_ROOT;

  // 0. Override rejection — runs first, on the RAW document, regardless of shape.
  const overrideHits = deepFindKey(evidence, 'uat_enforcement_override');
  for (const at of overrideHits) {
    add('OVERRIDE_FIELD_PRESENT', `uat_enforcement_override is rejected, never accepted (at ${at}). No override ships in this delivery.`);
  }

  // 1. Structural schema validation. (The verdict is carried entirely by the
  // accumulated errors — there is no separate schemaOk flag to keep in sync.)
  try {
    const validate = getSchemaValidator();
    if (!validate(evidence)) {
      for (const e of validate.errors || []) {
        add('SCHEMA_INVALID', `${e.instancePath || '$'} ${e.message}`);
      }
    }
  } catch (err) {
    add('SCHEMA_ERROR', `schema validation threw: ${err.message}`);
  }

  // Everything below is defensive: it never throws on partial input, so each
  // rejection is exercisable in isolation even when the doc is otherwise valid.
  if (!evidence || typeof evidence !== 'object') {
    add('NOT_AN_OBJECT', 'evidence is not an object');
    return { ok: false, errors };
  }

  const verdict = evidence.verdict;
  const scenarios = Array.isArray(evidence.scenarios) ? evidence.scenarios : [];
  const isPass = verdict === 'pass';

  // 2. Applicability / verdict / enforcement consistency (round-3 finding 5).
  if (evidence.applicability === 'non-applicable' && verdict !== 'proceed') {
    add('APPLICABILITY_VERDICT_MISMATCH', `applicability=non-applicable requires verdict=proceed (got ${verdict})`);
  }
  if (verdict === 'proceed') {
    if (evidence.applicability !== 'non-applicable') {
      add('PROCEED_WHEN_APPLICABLE', 'verdict=proceed is reserved for genuine non-applicability (applicability must be non-applicable)');
    }
    if (!evidence.applicability_reason || !String(evidence.applicability_reason).trim()) {
      add('PROCEED_WITHOUT_REASON', 'verdict=proceed requires a non-empty applicability_reason');
    }
    if (!/^[0-9a-f]{40}$/.test(evidence?.candidate?.head_sha || '')) {
      add('PROCEED_WITHOUT_CURRENT_SHA', 'verdict=proceed requires a full 40-hex candidate head SHA');
    }
  }

  // 3. Pass preconditions (brief §8.6). Only meaningful when verdict=pass.
  if (isPass) {
    if (!/^[0-9a-f]{40}$/.test(evidence?.candidate?.head_sha || '')) {
      add('PASS_ABBREVIATED_SHA', 'verdict=pass requires a full 40-hex candidate head SHA');
    }
    if (evidence?.candidate?.runtime_tree_clean !== true) {
      add('PASS_UNCLEAN_TREE', 'verdict=pass requires candidate.runtime_tree_clean=true (a modified runtime file or dirty submodule invalidates a pass)');
    }
    for (const s of scenarios) {
      if (!s?.required) continue;
      if (s.status === 'fail') add('PASS_WITH_FAILED_SCENARIO', `verdict=pass but required scenario ${s.id} failed`);
      if (s.status === 'incomplete') add('PASS_WITH_INCOMPLETE_SCENARIO', `verdict=pass but required scenario ${s.id} is incomplete`);
      if (s.status === 'skipped') add('PASS_WITH_SKIPPED_REQUIRED', `verdict=pass but required scenario ${s.id} was skipped`);
    }
    // Missing required capability.
    for (const c of evidence.capabilities || []) {
      if (c?.required && c?.available === false) {
        add('PASS_MISSING_CAPABILITY', `verdict=pass but required capability "${c.name}" is unavailable`);
      }
    }
    // Browser-claim-without-capability.
    const browserAbsent = (evidence.capabilities || []).some(
      (c) => /browser|authenticated|auth-session/i.test(c?.name || '') && c?.available === false
    );
    if (browserAbsent) {
      for (const s of scenarios) {
        const tagsBrowser = (s?.risk_tags || []).some((t) => /ui-browser|browser/i.test(t));
        if (tagsBrowser && s.status === 'pass') {
          add('PASS_BROWSER_CLAIM_WITHOUT_CAPABILITY', `scenario ${s.id} claims a browser pass while browser capability is absent`);
        }
      }
    }
  }

  // 4. Anti-vacuity for applicable scenarios (plan A8, invariant 6).
  if (verdict !== 'proceed') {
    for (const s of scenarios) {
      if (!s?.required || s.status !== 'pass') continue;
      const av = s.anti_vacuity || {};
      const present = Object.entries(av).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (present.length === 0) {
        add('MISSING_ANTI_VACUITY', `applicable passing scenario ${s.id} has no structured anti-vacuity proof`);
        continue;
      }
      const needsData = (s.families || []).some((f) => DATA_REQUIRING_FAMILIES.has(f));
      if (needsData) {
        const hasData =
          (typeof av.observed_record_count === 'number' && av.observed_record_count > 0) ||
          (av.seeded_id && String(av.seeded_id).trim()) ||
          (av.seeded_value && String(av.seeded_value).trim());
        if (!hasData) {
          add('VACUOUS_DATA_SCENARIO', `scenario ${s.id} covers a data-requiring family but proves no seeded/stored data (record count 0, no seeded id/value)`);
        }
      }
    }
  }

  // 5. Scenario digest integrity + set invariant (plan A6).
  for (const s of scenarios) {
    if (!s || typeof s !== 'object' || !s.digest) continue;
    let recomputed;
    try {
      recomputed = digestOf(s, ['digest']);
    } catch {
      recomputed = null;
    }
    if (recomputed && recomputed !== s.digest) {
      add('SCENARIO_DIGEST_MISMATCH', `scenario ${s.id} digest does not match its canonical content`);
    }
  }
  const byId = new Map(scenarios.map((s) => [s?.id, s]));
  const blindIds = Array.isArray(evidence.blind_scenario_ids) ? evidence.blind_scenario_ids : [];
  for (const id of blindIds) {
    const s = byId.get(id);
    if (!s) {
      add('BLIND_SCENARIO_DELETED', `blind scenario ${id} is absent from the executed plan (deletion forbidden)`);
      continue;
    }
    if (!s.required) {
      add('BLIND_SCENARIO_DOWNGRADED', `blind scenario ${id} was downgraded to optional (required->optional forbidden)`);
    }
    if (s.status === 'skipped') {
      add('BLIND_SCENARIO_NOT_EXECUTED', `blind scenario ${id} was not executed (skipped)`);
    }
  }

  // 6. Risk inventories: hash integrity + monotonic superset chain (plan A8).
  const baseline = evidence.risk_baseline;
  const start = evidence.risk_inventory_at_execution_start;
  const final = evidence.risk_inventory_final;
  for (const [name, inv] of [['risk_baseline', baseline], ['risk_inventory_at_execution_start', start], ['risk_inventory_final', final]]) {
    if (inv && inv.sha256 && inventoryDigest(inv) !== inv.sha256) {
      add('RISK_INVENTORY_HASH_MISMATCH', `${name}.sha256 does not match the canonical digest of its risks set`);
    }
  }
  if (baseline && start && !isSuperset(tagsOf(start), tagsOf(baseline))) {
    add('RISK_START_NOT_SUPERSET_OF_BASELINE', 'risk_inventory_at_execution_start dropped a baseline risk (baseline risks can be added to, never removed)');
  }
  if (start && final && !isSuperset(tagsOf(final), tagsOf(start))) {
    add('RISK_FINAL_NOT_SUPERSET_OF_START', 'risk_inventory_final is not a superset of the execution-start inventory (inventory is monotonic)');
  }

  // 7. Coverage cross-check against the risk-to-scenario policy (plan A8).
  if (isPass && start) {
    let policy;
    try {
      policy = loadPolicy(opts);
    } catch (err) {
      add('POLICY_LOAD_ERROR', `could not load risk policy: ${err.message}`);
      policy = { risk_families: {} };
    }
    const coveredFamilies = new Set();
    for (const s of scenarios) {
      if (s?.required && s.status === 'pass') for (const f of s.families || []) coveredFamilies.add(f);
    }
    for (const tag of tagsOf(start)) {
      const fams = policy.risk_families?.[tag];
      if (!fams) continue; // non-domain tag with no policy entry — nothing to require
      for (const fam of fams) {
        if (fam.required && !coveredFamilies.has(fam.family)) {
          add('COVERAGE_MISSING_FAMILY', `risk tag "${tag}" requires scenario family "${fam.family}" but no passing required scenario covers it`);
        }
      }
    }
  }

  // 8. Timestamps: augmentation cannot precede the blind freeze (plan A6).
  const frozenAt = Date.parse(evidence?.timestamps?.blind_plan_frozen_at || '');
  const augAt = Date.parse(evidence?.timestamps?.augmentation_started_at || '');
  if (Number.isFinite(frozenAt) && Number.isFinite(augAt) && augAt <= frozenAt) {
    add('AUGMENTATION_BEFORE_FREEZE', 'augmentation_started_at must be strictly after blind_plan_frozen_at');
  }

  // 9. Two-sided plan-digest identity (plan A6, round-4 finding 6).
  const pd = evidence.plan_digests || {};
  if (pd.expected_plan_sha256 && pd.executed_plan_sha256 && pd.expected_plan_sha256 !== pd.executed_plan_sha256) {
    add('PLAN_DIGEST_HANDOFF_MISMATCH', 'expected_plan_sha256 != executed_plan_sha256 (a frozen plan was swapped between validation and execution)');
  }
  if (opts.finalPlan) {
    let d;
    try { d = digestOf(opts.finalPlan, ['document_sha256']); } catch { d = null; }
    if (d && pd.expected_plan_sha256 && d !== pd.expected_plan_sha256) {
      add('PLAN_DIGEST_FILE_MISMATCH', 'expected_plan_sha256 does not match the supplied uat-plan.json');
    }
  }
  if (opts.blindPlan) {
    let d;
    try { d = digestOf(opts.blindPlan, ['document_sha256']); } catch { d = null; }
    if (d && pd.blind_plan_sha256 && d !== pd.blind_plan_sha256) {
      add('BLIND_PLAN_DIGEST_MISMATCH', 'blind_plan_sha256 does not match the supplied uat-plan-blind.json');
    }
    const planBlindIds = new Set((opts.blindPlan.scenarios || []).map((s) => s?.id).filter(Boolean));
    for (const id of planBlindIds) {
      if (!blindIds.includes(id)) {
        add('BLIND_ID_SET_MISMATCH', `blind plan scenario ${id} is missing from evidence.blind_scenario_ids`);
      }
    }
  }
  if (opts.inputManifest) {
    let d;
    try { d = digestOf(opts.inputManifest, ['document_sha256']); } catch { d = null; }
    if (d && pd.input_manifest_sha256 && d !== pd.input_manifest_sha256) {
      add('INPUT_MANIFEST_MISMATCH', 'input_manifest_sha256 does not match the supplied input manifest');
    }
    // Baseline in the manifest must equal the evidence risk_baseline.
    if (opts.inputManifest.risk_baseline && baseline) {
      if (inventoryDigest(opts.inputManifest.risk_baseline) !== inventoryDigest(baseline)) {
        add('RISK_BASELINE_MANIFEST_MISMATCH', 'evidence risk_baseline differs from the hash-bound baseline in the blind input manifest');
      }
    }
  }

  // 10. Artifact integrity + realpath containment + secret scan (plan A8).
  const allowedRoots = (opts.allowedRoots || defaultAllowedRoots(repoRoot, evidence.slug)).map((r) => path.resolve(r));
  const artifacts = collectArtifacts(evidence);
  for (const a of artifacts) {
    const abs = path.resolve(repoRoot, a.path);
    // Containment first (on the declared path), then realpath (defeats symlink escape).
    if (!withinRoots(abs, allowedRoots)) {
      add('ARTIFACT_PATH_ESCAPE', `evidence artifact ${a.path} is outside the permitted UAT artifact roots`);
      continue;
    }
    if (!existsSync(abs)) {
      // Missing cited artifact is fatal for a pass; recorded (non-fatal) otherwise.
      if (isPass) add('ARTIFACT_MISSING', `verdict=pass cites artifact ${a.path} which does not exist`);
      continue;
    }
    let real;
    try {
      real = realpathSync(abs);
    } catch {
      add('ARTIFACT_REALPATH_ERROR', `could not resolve realpath for ${a.path}`);
      continue;
    }
    if (!withinRoots(real, allowedRoots)) {
      add('ARTIFACT_SYMLINK_ESCAPE', `evidence artifact ${a.path} resolves (via symlink) outside the permitted roots`);
      continue;
    }
    let stat;
    try { stat = statSync(real); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      add('ARTIFACT_NOT_A_FILE', `evidence artifact ${a.path} is not a regular file`);
      continue;
    }
    const { sha256, bytes, buf } = sha256File(real);
    if (a.sha256 && sha256 !== a.sha256) {
      add('ARTIFACT_HASH_MISMATCH', `artifact ${a.path} sha256 does not match the recorded value (manifest cannot self-declare integrity)`);
    }
    if (typeof a.bytes === 'number' && bytes !== a.bytes) {
      add('ARTIFACT_BYTES_MISMATCH', `artifact ${a.path} byte length ${bytes} != recorded ${a.bytes}`);
    }
    if (isTextualMedia(a.media_type)) {
      const hits = scanSecrets(buf.toString('utf8'));
      for (const h of hits) add('SECRET_DETECTED', `artifact ${a.path} contains a prohibited secret pattern (${h})`);
    }
  }

  // Secret scan over the evidence document + optional report text.
  for (const h of scanSecrets(canonicalize(safeForScan(evidence)))) {
    add('SECRET_DETECTED', `evidence document contains a prohibited secret pattern (${h})`);
  }
  if (opts.reportText) {
    for (const h of scanSecrets(String(opts.reportText))) {
      add('SECRET_DETECTED', `uat-report contains a prohibited secret pattern (${h})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function safeForScan(evidence) {
  // canonicalize rejects undefined/functions; evidence is plain JSON already,
  // but guard against a caller passing a live object with odd values.
  return JSON.parse(JSON.stringify(evidence));
}

function collectArtifacts(evidence) {
  const out = [];
  for (const s of evidence.scenarios || []) {
    for (const a of s?.evidence || []) out.push(a);
  }
  for (const a of evidence.artifacts || []) out.push(a);
  return out;
}

function defaultAllowedRoots(repoRoot, slug) {
  const s = slug || '';
  return [
    path.join(repoRoot, 'tasks', 'builds', s),
    path.join(repoRoot, '.test-runs', `${s}-uat`),
  ];
}

function withinRoots(abs, roots) {
  const norm = path.resolve(abs);
  return roots.some((root) => {
    const r = path.resolve(root);
    return norm === r || norm.startsWith(r + path.sep);
  });
}

// ── CLI ───────────────────────────────────────────────────────────────────
function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node scripts/uat/validate-uat-evidence.mjs <uat-evidence.json> [--repo-root <dir>]');
    process.exit(2);
  }
  const evidencePath = args[0];
  const repoRootIdx = args.indexOf('--repo-root');
  const repoRoot = repoRootIdx >= 0 ? args[repoRootIdx + 1] : process.cwd();
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (err) {
    console.error(`UAT-EVIDENCE-INVALID: cannot read/parse ${evidencePath}: ${err.message}`);
    process.exit(1);
  }
  const { ok, errors } = validateEvidence(evidence, { repoRoot });
  if (ok) {
    console.log(`UAT-EVIDENCE-VALID: ${evidencePath}`);
    process.exit(0);
  }
  console.error(`UAT-EVIDENCE-INVALID: ${evidencePath} (${errors.length} error(s))`);
  for (const e of errors) console.error(`  [${e.code}] ${e.message}`);
  process.exit(1);
}
