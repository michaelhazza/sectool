/**
 * classify-change.mjs — deterministic change classifier for the UAT gate.
 *
 * TWO independent outputs from one path scan (plan A5 + A8):
 *
 *   1. STALENESS class — does a change invalidate prior UAT evidence?
 *      Three classes, NOT a binary (plan A5, review finding F5):
 *        - application-impacting        -> rerun verify + UAT
 *        - acceptance-harness-impacting -> rerun UAT (verify only if otherwise required)
 *        - acceptance-inert             -> evidence may remain valid
 *      Unknown paths default to application-impacting (conservative — never skip
 *      UAT on a path we do not understand). Per-path precedence puts harness
 *      patterns AHEAD of the generic source default, so scripts/uat/validate.mjs
 *      is harness-impacting, not application-impacting. Across many changed
 *      paths the MOST SEVERE class wins (application > harness > inert), and a
 *      rename is classified on BOTH its old and new path (operator finding
 *      round-3 #4 — rename classification uses both paths, most severe wins).
 *
 *   2. DOMAIN-RISK tags — the A8 layer-1 baseline: path/migration-derived
 *      mandatory risk tags (money-precision, auth-tenant, database-route-
 *      migration, ui-browser, async-state-retry, export-email-artifact,
 *      external-provider). Produced independently of the tester, BEFORE blind
 *      execution, and hash-bound into the blind input manifest. The tester may
 *      ADD risks but never remove a baseline one.
 *
 * ENGINE / CONFIG split follows the g5-scoped.sh precedent: DEFAULT_TABLE below
 * is the framework's starting point; a consumer extends it with a JSON
 * registry (classification-registry.example.json) referenced from
 * agent-context.md — never parsed out of Markdown prose. Consumer patterns are
 * MERGED with (added to) the defaults; a consumer can broaden a class but the
 * conservative unknown-default and the harness-first precedence are engine
 * behaviour, not config.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLASSES = {
  APPLICATION: 'application-impacting',
  HARNESS: 'acceptance-harness-impacting',
  INERT: 'acceptance-inert',
};

// Aggregation severity: higher wins across paths. Unknown maps to APPLICATION.
const SEVERITY = {
  [CLASSES.APPLICATION]: 2,
  [CLASSES.HARNESS]: 1,
  [CLASSES.INERT]: 0,
};

// ── DEFAULT TABLE (framework starting point; consumers extend via registry) ──
export const DEFAULT_TABLE = {
  // Checked FIRST — the acceptance harness itself. A change here changes what
  // acceptance MEANS, so it invalidates evidence even when the app is untouched.
  acceptance_harness_impacting: [
    'scripts/uat/**',
    'schemas/uat-evidence.schema.json',
    'schemas/uat-plan.schema.json',
    'schemas/uat-plan-blind.schema.json',
    '.claude/skills/acceptance-testing/**',
    '.claude/agents/acceptance-phase.md',
    'templates/codex-skills/run-final-uat/**',
    '.agents/skills/run-final-uat/**',
    'references/blind-planner-runtime.md',
    'references/codex-invocation-contract.md',
    // framework pointer bumps + project UAT configuration
    '.claude-framework',
    '.claude/FRAMEWORK_VERSION',
    '.claude/project-registries.json',
    '.claude/context/uat-classification-registry.json',
  ],
  // Checked LAST among explicit rules — genuinely inert prose/config.
  acceptance_inert: [
    '**/*.md',
    '**/*.mdx',
    '**/*.txt',
    'docs/**',
    '**/LICENSE',
    '**/LICENSE.*',
    '.github/ISSUE_TEMPLATE/**',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ],
  // Explicit application surfaces (redundant with the conservative default, but
  // documents intent and keeps the class visible).
  application_impacting: [
    'src/**', 'server/**', 'client/**', 'app/**', 'lib/**', 'pages/**',
    'migrations/**', '**/*.sql',
    '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml',
  ],
  // Domain-risk tag rules (plan A8 layer 1). A path may carry several tags.
  risk_tags: {
    'database-route-migration': ['migrations/**', '**/*.sql', '**/schema/**', '**/migrations/**', '**/routes/**', '**/api/**', '**/controllers/**'],
    'money-precision': ['**/money*', '**/currency*', '**/price*', '**/*fx*', '**/aggregat*', '**/networth*', '**/net-worth*', '**/balance*'],
    'auth-tenant': ['**/auth*', '**/session*', '**/login*', '**/tenant*', '**/rls*', '**/permission*', '**/authoriz*'],
    'ui-browser': ['client/**', 'pages/**', '**/*.tsx', '**/*.jsx', '**/components/**', '**/views/**'],
    'async-state-retry': ['**/jobs/**', '**/queue*', '**/worker*', '**/retry*', '**/scheduler*', '**/lease*'],
    'export-email-artifact': ['**/export*', '**/email*', '**/pdf*', '**/csv*', '**/report*', '**/invoice*'],
    'external-provider': ['**/providers/**', '**/webhooks/**', '**/integrations/**', '**/exchange*'],
  },
};

// Minimal glob -> RegExp (segment `*` does not cross `/`; `**` spans). Mirrors
// the check-shipped-source.js approach so behaviour is consistent across gates.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** spans directories (and an optional trailing slash)
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

function anyMatch(patterns, rel) {
  return (patterns || []).some((g) => globToRegExp(g).test(rel));
}

function mergeTable(base, registry) {
  if (!registry) return base;
  const out = {
    acceptance_harness_impacting: [...base.acceptance_harness_impacting, ...(registry.staleness?.acceptance_harness_impacting || [])],
    acceptance_inert: [...base.acceptance_inert, ...(registry.staleness?.acceptance_inert || [])],
    application_impacting: [...base.application_impacting, ...(registry.staleness?.application_impacting || [])],
    risk_tags: { ...base.risk_tags },
  };
  for (const [tag, globs] of Object.entries(registry.risk_tags || {})) {
    out.risk_tags[tag] = [...(out.risk_tags[tag] || []), ...globs];
  }
  return out;
}

/** Classify one path. Harness patterns win over the generic source default;
 *  unknown paths are conservatively application-impacting. */
export function classifyPath(p, table = DEFAULT_TABLE) {
  const rel = normalize(p);
  if (anyMatch(table.acceptance_harness_impacting, rel)) return CLASSES.HARNESS;
  if (anyMatch(table.application_impacting, rel)) return CLASSES.APPLICATION;
  if (anyMatch(table.acceptance_inert, rel)) return CLASSES.INERT;
  return CLASSES.APPLICATION; // conservative default
}

function riskTagsForPath(p, table = DEFAULT_TABLE) {
  const rel = normalize(p);
  const tags = [];
  for (const [tag, globs] of Object.entries(table.risk_tags || {})) {
    if (anyMatch(globs, rel)) tags.push(tag);
  }
  return tags;
}

/**
 * @param {Array<string|{path:string,status?:string,oldPath?:string}>} changes
 * @param {object} [opts]
 * @param {object} [opts.registry] — parsed consumer classification registry
 * @param {object} [opts.table] — override the whole table (tests)
 * @returns {{staleness_class:string, reruns:{verify:boolean,uat:boolean}, risk_tags:string[], per_path:Array}}
 */
export function classifyChange(changes, opts = {}) {
  const table = opts.table || mergeTable(DEFAULT_TABLE, opts.registry);
  const perPath = [];
  const riskSet = new Set();
  let worstSeverity = -1;
  let worstClass = CLASSES.INERT;

  for (const raw of changes || []) {
    const change = typeof raw === 'string' ? { path: raw, status: 'M' } : raw;
    const paths = [change.path];
    if (change.oldPath) paths.push(change.oldPath); // rename: classify both
    let entryClass = CLASSES.INERT;
    let entrySeverity = -1;
    for (const p of paths) {
      if (!p) continue;
      const cls = classifyPath(p, table);
      if (SEVERITY[cls] > entrySeverity) {
        entrySeverity = SEVERITY[cls];
        entryClass = cls;
      }
      for (const t of riskTagsForPath(p, table)) riskSet.add(t);
    }
    perPath.push({ path: change.path, oldPath: change.oldPath, status: change.status || 'M', class: entryClass });
    if (entrySeverity > worstSeverity) {
      worstSeverity = entrySeverity;
      worstClass = entryClass;
    }
  }

  const staleness_class = perPath.length === 0 ? CLASSES.INERT : worstClass;
  const reruns = {
    verify: staleness_class === CLASSES.APPLICATION,
    uat: staleness_class === CLASSES.APPLICATION || staleness_class === CLASSES.HARNESS,
  };
  return {
    staleness_class,
    reruns,
    risk_tags: [...riskSet].sort(),
    per_path: perPath,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Reads `git diff --name-status` lines from stdin (or file paths as args) and
// prints the classification JSON.
function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function parseNameStatus(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\t+|\s{2,}|\s+/);
    const code = parts[0];
    if (/^R\d*$/.test(code) && parts.length >= 3) {
      out.push({ status: 'R', oldPath: parts[1], path: parts[2] });
    } else if (/^[AMDT]/.test(code) && parts.length >= 2) {
      out.push({ status: code[0], path: parts[1] });
    } else {
      out.push({ status: 'M', path: parts[parts.length - 1] });
    }
  }
  return out;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const registryIdx = args.indexOf('--registry');
  let registry = null;
  if (registryIdx >= 0) {
    registry = JSON.parse(readFileSync(args[registryIdx + 1], 'utf8'));
    args.splice(registryIdx, 2);
  }
  let changes;
  if (args.length > 0) {
    changes = args.map((p) => ({ path: p, status: 'M' }));
  } else {
    const stdin = readFileSync(0, 'utf8');
    changes = parseNameStatus(stdin);
  }
  const result = classifyChange(changes, { registry });
  console.log(JSON.stringify(result, null, 2));
}
