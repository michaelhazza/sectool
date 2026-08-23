/**
 * install-codex-skill.mjs — place the canonical Codex run-final-uat skill into a
 * repo's `.agents/skills/run-final-uat/` (plan A1 / §7 C0.3).
 *
 * WHY A DEDICATED INSTALLER (resolved against sync.js at R1.6): sync.js has NO
 * path-remap field — a managed file syncs to the SAME relative path in the
 * consumer. The framework's established pattern for "template dir -> a different
 * consumer path" is a dedicated adopt/install script (the
 * scripts/adopt-ci-templates.mjs precedent for github-workflows). So the
 * manifest ships the canonical source under templates/codex-skills/, and THIS
 * installer renders it into `.agents/skills/run-final-uat/` — the agent-vendor-
 * neutral, repo-level path Codex discovers (verified this session on CLI 0.144.3).
 *
 * `--check` is a deterministic drift gate: the installed copy must be
 * byte-identical to the canonical source (no independently-edited second copy —
 * the brief's "no two independently edited copies" rule).
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './canonicalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const CANONICAL_REL = path.join('templates', 'codex-skills', 'run-final-uat');
const CONSUMER_REL = path.join('.agents', 'skills', 'run-final-uat');

function listTree(root) {
  const out = [];
  const walk = (abs) => {
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      const p = path.join(abs, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

/** Copy the canonical package into <targetRoot>/.agents/skills/run-final-uat/. */
export function installCodexSkill(targetRoot, frameworkRoot = FRAMEWORK_ROOT) {
  const src = path.join(frameworkRoot, CANONICAL_REL);
  const dest = path.join(targetRoot, CONSUMER_REL);
  if (!existsSync(src)) throw new Error(`install-codex-skill: canonical source missing at ${src}`);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  const files = listTree(src);
  for (const rel of files) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
  }
  return { dest, files };
}

/** Compare canonical vs installed copy; returns { drifted, missing, changed }. */
export function checkDrift(targetRoot, frameworkRoot = FRAMEWORK_ROOT) {
  const src = path.join(frameworkRoot, CANONICAL_REL);
  const dest = path.join(targetRoot, CONSUMER_REL);
  const missing = [];
  const changed = [];
  for (const rel of listTree(src)) {
    const to = path.join(dest, rel);
    if (!existsSync(to)) { missing.push(rel); continue; }
    if (sha256Hex(readFileSync(path.join(src, rel))) !== sha256Hex(readFileSync(to))) changed.push(rel);
  }
  return { drifted: missing.length > 0 || changed.length > 0, missing, changed };
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
  const args = process.argv.slice(2);
  const targetIdx = args.indexOf('--target');
  const targetRoot = targetIdx >= 0 ? args[targetIdx + 1] : process.cwd();
  if (args.includes('--check')) {
    const { drifted, missing, changed } = checkDrift(targetRoot);
    if (drifted) {
      console.error(`CODEX-SKILL-DRIFT: run-final-uat differs from canonical (missing: ${missing.join(', ') || 'none'}; changed: ${changed.join(', ') || 'none'})`);
      process.exit(1);
    }
    console.log('CODEX-SKILL-OK: installed run-final-uat matches canonical source');
    process.exit(0);
  }
  const { dest, files } = installCodexSkill(targetRoot);
  console.log(`Installed run-final-uat (${files.length} files) -> ${dest}`);
}
