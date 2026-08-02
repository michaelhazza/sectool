#!/usr/bin/env node
// adopt-ci-templates.mjs — fail-closed render of templates/github-workflows/*.yml
// into a repo's .github/workflows/ (dev-pipeline-v2 spec §7.5/§8.5; plan.md Chunk 13).
//
// Why this script exists at all (plan.md Chunk 13, plan-time-reads.md §1,
// VERIFIED against sync.js): sync.js copies framework files to the SAME
// relative consumer path, so the templates land at
// `<repo>/templates/github-workflows/*.yml`, never at `.github/workflows/`.
// `validateSubstitutions` (sync.js:710) throws only when a substitution
// VALUE contains `{{`; an empty or incomplete substitution MAP produces a
// WARNING, not an error (sync.js:718-720), and sync exits 0 having delivered
// a workflow full of literal `{{PLACEHOLDER}}` text. sync.js NEVER RENDERS —
// this script is the only thing that renders, so sync's warn-only posture is
// irrelevant here and nothing about this script should be "unified" with it.
// This script owns the strict, fail-closed half of that contract: render the
// template with per-repo substitution values, refuse outright on anything
// missing, and only then write to `.github/workflows/`.
//
// ── Requirements are PER TARGET, not global (WEB3-001) ─────────────────────
// An earlier plan revision listed one global "six required values" set, which
// would have made a ci-light render require `suite_workflow_path` before the
// heavy callee exists (C25 authors it) and made a merge-gate render silently
// accept a missing runner-labels value it cannot even place in the YAML (a
// `uses:` job cannot carry `runs-on:`). Requirements below are scoped to
// EXACTLY what each target's template body references after the header
// comment block is stripped (see next section) — nothing more.
//
//   ci-light:    light_suite_workflow_path (path, must exist at render time)
//   merge-gate:  runner_labels (array of non-empty strings)
//                suite_workflow_path (path, must exist at render time)
//                light_suite_workflow_path (path, must exist at render time)
//                push_main_full_suite (explicit JSON boolean — PRESENCE is
//                  checked, not truthiness; `false` is a valid configured
//                  value, a missing key is a hard failure)
//
// Values are sourced from `.claude/project-registries.json` under a
// `ci_templates` key, snake_case, one-to-one with the lowercased placeholder
// token (`{{RUNNER_LABELS}}` -> `runner_labels`, etc.):
//
//   {
//     "ci_templates": {
//       "runner_labels": ["self-hosted", "linux"],
//       "light_suite_workflow_path": ".github/workflows/ci-light-suite.yml",
//       "suite_workflow_path": ".github/workflows/merge-gate-suite.yml",
//       "push_main_full_suite": false
//     }
//   }
//
// ── Header-comment-block decision (deliberate — C12 flagged this) ──────────
// Both templates' leading `#`-prefixed doc comment (everything before the
// first non-comment, non-blank line — i.e. before `name: ci-light` /
// `name: merge-gate`) is STRIPPED before substitution, and never written to
// the rendered output. Reason: those header blocks document EVERY
// placeholder for operator reference, including ones a given target's BODY
// never references — e.g. ci-light.yml's header spells out
// `{{RUNNER_LABELS}}` in prose even though ci-light's per-target
// requirements (above) correctly do NOT require it. Leaving the header in
// would force a choice between two wrong outcomes: substitute it anyway
// (contradicts "per-target requires exactly what the body declares",
// WEB3-001) or leave it literal (the leftover-`{{` check below would then
// refuse a render the requirements matrix says should succeed). Stripping
// the header sidesteps both. Inline/step-level comments in the BODY are
// retained verbatim — they don't embed literal placeholder tokens, and they
// carry real operational context (the callee contract, the trust-boundary
// note, the resolved-SHA rationale) worth keeping in the rendered file.
//
// ── Placeholder vs GitHub Actions expression (the single most important
//    correctness property here) ──────────────────────────────────────────
// Bare `{{TOKEN}}` (upper-snake-case, no `$` immediately before it) is a
// placeholder this script substitutes. `${{ expression }}` is GitHub Actions
// runtime syntax and MUST pass through byte-identical — both templates use
// it constantly (`${{ github.event.pull_request.head.sha || github.sha }}`,
// job outputs, etc.). A naive global replace on `{{` would corrupt every one
// of those. Every regex below is anchored so a `{{` immediately preceded by
// `$` never matches.
//
// ── Conditional-block marker syntax (defined in merge-gate.yml's header;
//    honoured here) ─────────────────────────────────────────────────────
// An opening marker line of the exact shape `{{#if KEY}}` (KEY upper-snake,
// nothing else on the line), then content, then a closing marker line
// `{{/if}}` (nothing else on the line). KEY resolves against the same
// lowercased `ci_templates` map as ordinary placeholders. KEY must be an
// explicit JSON boolean; a missing key is a hard error (never a silent
// false). true -> keep the content verbatim, strip only the two marker
// lines. false -> strip the markers AND the content, leaving no orphaned
// blank line. Blocks do not nest; nesting is not implemented.
//
// ── Fail-closed, unconditionally ────────────────────────────────────────
// - A missing/empty/whitespace-only required value, or a required path
//   target that does not exist on disk at render time, refuses the ENTIRE
//   render for that target: nothing is written, exit code is non-zero, and
//   the message names EVERY failing requirement (not just the first).
// - Any `{{` surviving in the fully-rendered text (not part of a `${{ }}`
//   expression) also refuses the write — belt-and-braces against a
//   placeholder this script's requirements matrix does not know about.
// - An existing rendered file at the output path is never overwritten
//   without an explicit `--overwrite` flag, so a re-run cannot silently
//   clobber operator edits.
//
// ── Out of scope, deliberately ──────────────────────────────────────────
// spec §14 also names "rendered workflow templates are validated in
// framework CI by `actionlint` when available, else a YAML-parse check".
// That is CI-time validation of the RENDERED OUTPUT living in framework
// CI — a separate gate step, not a property of this script or its own test
// file (whose declared surface is exactly this file and its test file). No
// YAML/actionlint dependency is added here.
//
// Usage:
//   node scripts/adopt-ci-templates.mjs [--target ci-light|merge-gate|all]
//     [--repo <dir>] [--templates-dir <dir>] [--output-dir <dir>]
//     [--config <path>] [--overwrite]
//
//   --target         Which template(s) to render (default: all).
//   --repo           Repo root; anchors the defaults below and is the base
//                     every path VALUE resolves against (default: cwd).
//   --templates-dir  Source dir for the .yml templates
//                     (default: <repo>/templates/github-workflows).
//   --output-dir     Destination dir for rendered workflows
//                     (default: <repo>/.github/workflows).
//   --config         Path to the registry JSON holding `ci_templates`
//                     (default: <repo>/.claude/project-registries.json).
//   --overwrite      Allow replacing an existing rendered file.
//
// stdlib-only, matching board-sync.mjs / generate-current-focus.mjs.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_FILES = {
  'ci-light': 'ci-light.yml',
  'merge-gate': 'merge-gate.yml',
};

const TARGET_REQUIREMENTS = {
  'ci-light': [{ key: 'light_suite_workflow_path', kind: 'path' }],
  'merge-gate': [
    { key: 'runner_labels', kind: 'array' },
    { key: 'suite_workflow_path', kind: 'path' },
    { key: 'light_suite_workflow_path', kind: 'path' },
    { key: 'push_main_full_suite', kind: 'boolean' },
  ],
};

// Matches a bare `{{TOKEN}}` placeholder (upper-snake-case) that is NOT part
// of a `${{ expression }}` GitHub Actions expression.
const PLACEHOLDER_RE = /(?<!\$)\{\{([A-Z][A-Z0-9_]*)\}\}/g;
// Any leftover `{{` not preceded by `$` — the belt-and-braces final check.
const LEFTOVER_RE = /(?<!\$)\{\{/g;
const CONDITIONAL_OPEN_RE = /^\{\{#if\s+([A-Z][A-Z0-9_]*)\}\}$/;
const CONDITIONAL_CLOSE_RE = /^\{\{\/if\}\}$/;

// ---------------------------------------------------------------------------
// Pure functions (exported for tests). validateValues touches fs.existsSync
// for path-kind requirements — that check IS the fail-closed contract, so it
// stays here rather than being pushed into the I/O layer; tests exercise it
// against real temp-dir fixtures rather than mocking fs.
// ---------------------------------------------------------------------------

/** Requirement descriptors for one render target. Throws on an unknown
 *  target name (a caller bug, not a data problem). */
export function requiredKeysFor(target) {
  const reqs = TARGET_REQUIREMENTS[target];
  if (!reqs) {
    throw new Error(`requiredKeysFor: unknown target "${target}" (expected one of: ${Object.keys(TARGET_REQUIREMENTS).join(', ')})`);
  }
  return reqs;
}

/** Validates `values` against the target's per-target requirements.
 *  `repoRoot` anchors path-kind existence checks. Returns every failing
 *  requirement, not just the first — the render refusal must name them all. */
export function validateValues(target, values, repoRoot) {
  const errors = [];
  for (const { key, kind } of requiredKeysFor(target)) {
    const present = Object.prototype.hasOwnProperty.call(values, key);
    const value = values[key];

    if (kind === 'boolean') {
      // Presence is checked, not truthiness — `false` is a valid configured
      // value; a missing key is the failure (WEB2-003).
      if (!present) {
        errors.push(`${key}: required boolean key is missing (presence is checked, not truthiness — "false" is a valid configured value)`);
      } else if (typeof value !== 'boolean') {
        errors.push(`${key}: must be an explicit JSON boolean, got ${JSON.stringify(value)}`);
      }
      continue;
    }

    if (kind === 'array') {
      const isValid = present && Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim() !== '');
      if (!isValid) {
        errors.push(`${key}: required array of non-empty strings is missing, empty, or contains a blank/non-string entry`);
      }
      continue;
    }

    if (kind === 'path') {
      if (!present || typeof value !== 'string' || value.trim() === '') {
        errors.push(`${key}: required path value is missing, empty, or whitespace-only`);
        continue;
      }
      const resolved = path.join(repoRoot, value);
      if (!fs.existsSync(resolved)) {
        errors.push(`${key}: target path "${value}" does not exist on disk at render time (resolved: ${resolved})`);
      }
      continue;
    }

    throw new Error(`validateValues: unknown requirement kind "${kind}" for key "${key}"`);
  }
  return { valid: errors.length === 0, errors };
}

/** Strips the leading `#`-prefixed / blank-line header comment block —
 *  everything before the first line that is neither blank nor a comment.
 *  See the header-comment-block decision above. */
export function stripHeaderComment(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#'))) {
    i++;
  }
  return lines.slice(i).join('\n');
}

/** Formats one substitution value for placeholder interpolation: arrays
 *  render as a YAML flow sequence (`[a, b]`, matching `runs-on:` syntax),
 *  everything else stringifies as-is. */
function formatValue(value) {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

/** Replaces every bare `{{TOKEN}}` placeholder with its value from
 *  `values[token.toLowerCase()]`. A token with no known value is left
 *  untouched — `findLeftoverPlaceholders` is the net that catches it.
 *  `${{ expression }}` GitHub Actions syntax is never touched (PLACEHOLDER_RE
 *  requires no `$` immediately before `{{`). */
export function substitutePlaceholders(text, values) {
  return text.replace(PLACEHOLDER_RE, (match, token) => {
    const key = token.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(values, key) || values[key] === undefined || values[key] === null) {
      return match;
    }
    return formatValue(values[key]);
  });
}

/** Processes `{{#if KEY}} ... {{/if}}` conditional blocks (marker syntax
 *  defined in merge-gate.yml's header). KEY resolves the same lowercased way
 *  as ordinary placeholders. Throws on an unterminated block, an unknown
 *  key, or a non-boolean value — a caller that reaches this function is
 *  expected to have already validated required values (validateValues), so
 *  these throws are a defensive backstop, not the primary fail-closed path.
 *  Blocks do not nest. */
export function stripConditionals(text, values) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const openMatch = line.match(CONDITIONAL_OPEN_RE);
    if (!openMatch) {
      out.push(line);
      i++;
      continue;
    }

    const token = openMatch[1];
    const key = token.toLowerCase();
    const contentLines = [];
    i++;
    while (i < lines.length && !CONDITIONAL_CLOSE_RE.test(lines[i])) {
      contentLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      throw new Error(`stripConditionals: unterminated conditional block for key "${token}" (no matching {{/if}})`);
    }
    i++; // consume the closing marker line

    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`stripConditionals: conditional key "${key}" is not present in values`);
    }
    if (typeof values[key] !== 'boolean') {
      throw new Error(`stripConditionals: conditional key "${key}" must be an explicit boolean, got ${JSON.stringify(values[key])}`);
    }
    if (values[key] === true) {
      out.push(...contentLines);
    }
    // false: markers and content both dropped, no orphaned blank line.
  }
  return out.join('\n');
}

/** Full render pipeline for one template's text: strip the header comment,
 *  resolve conditional blocks, then substitute placeholders. Order matters —
 *  conditionals must resolve before substitution so a key that is ONLY used
 *  as a conditional (push_main_full_suite) never needs a plain-text
 *  substitution path too. */
export function renderTemplate(text, values) {
  const withoutHeader = stripHeaderComment(text);
  const withoutConditionals = stripConditionals(withoutHeader, values);
  return substitutePlaceholders(withoutConditionals, values);
}

/** Every remaining bare `{{` in fully-rendered text — should be empty for a
 *  successful render. Non-empty means a placeholder this script's
 *  requirements matrix didn't know about survived substitution. */
export function findLeftoverPlaceholders(text) {
  return text.match(LEFTOVER_RE) || [];
}

// ---------------------------------------------------------------------------
// Thin I/O layer.
// ---------------------------------------------------------------------------

/** Renders one target end-to-end and writes it, or refuses and reports why.
 *  Never partially writes: validation, then leftover-marker check, then the
 *  overwrite guard, all happen before any bytes touch disk. */
export function adoptTarget({ target, repoRoot, templatesDir, outputDir, values, overwrite = false }) {
  const validation = validateValues(target, values, repoRoot);
  if (!validation.valid) {
    return { written: false, outputPath: null, errors: validation.errors };
  }

  const templateFile = TEMPLATE_FILES[target];
  const templatePath = path.join(templatesDir, templateFile);
  const raw = fs.readFileSync(templatePath, 'utf8');
  const rendered = renderTemplate(raw, values);

  const leftovers = findLeftoverPlaceholders(rendered);
  if (leftovers.length > 0) {
    return {
      written: false,
      outputPath: null,
      errors: [
        `rendered output for target "${target}" still contains ${leftovers.length} unresolved template marker(s) — refusing to write (a placeholder this script's requirements matrix does not know about)`,
      ],
    };
  }

  const outputPath = path.join(outputDir, templateFile);
  if (fs.existsSync(outputPath) && !overwrite) {
    return {
      written: false,
      outputPath,
      errors: [`refusing to overwrite existing file at ${outputPath} without --overwrite`],
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, rendered, 'utf8');
  return { written: true, outputPath, errors: [] };
}

function extractFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

function loadCiTemplateValues(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config not found at ${configPath} — cannot render without ci_templates values`);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`cannot parse ${configPath}: ${err.message}`, { cause: err });
  }
  return data.ci_templates ?? {};
}

function main() {
  const argv = process.argv.slice(2);
  const repoRoot = path.resolve(extractFlagValue(argv, '--repo') ?? process.cwd());
  const templatesDir = path.resolve(extractFlagValue(argv, '--templates-dir') ?? path.join(repoRoot, 'templates', 'github-workflows'));
  const outputDir = path.resolve(extractFlagValue(argv, '--output-dir') ?? path.join(repoRoot, '.github', 'workflows'));
  const configPath = path.resolve(extractFlagValue(argv, '--config') ?? path.join(repoRoot, '.claude', 'project-registries.json'));
  const overwrite = argv.includes('--overwrite');
  const targetFlag = extractFlagValue(argv, '--target') ?? 'all';
  const targets = targetFlag === 'all' ? Object.keys(TEMPLATE_FILES) : [targetFlag];

  let values;
  try {
    values = loadCiTemplateValues(configPath);
  } catch (err) {
    console.error(`[adopt-ci-templates] ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let hadFailure = false;
  for (const target of targets) {
    if (!TEMPLATE_FILES[target]) {
      console.error(`[adopt-ci-templates] unknown target "${target}" (expected one of: ${Object.keys(TEMPLATE_FILES).join(', ')}, or "all")`);
      hadFailure = true;
      continue;
    }
    const result = adoptTarget({ target, repoRoot, templatesDir, outputDir, values, overwrite });
    if (!result.written) {
      hadFailure = true;
      console.error(`[adopt-ci-templates] refused to render target "${target}":`);
      for (const err of result.errors) console.error(`  - ${err}`);
    } else {
      console.log(`[adopt-ci-templates] wrote ${result.outputPath}`);
    }
  }

  if (hadFailure) process.exitCode = 1;
}

// Entry-point guard: adopt-ci-templates.test.mjs imports this module for its
// pure functions; main() must not run as a side effect of that import.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
