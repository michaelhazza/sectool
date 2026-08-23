/**
 * build-blind-snapshot.mjs — deterministic blind-input snapshot builder (plan
 * A6/A8, round-2 finding 6, round-3 finding 10). Part of the SECURITY boundary,
 * NEVER an agent.
 *
 * Exports the candidate source tree with NO `.git` (a gitdir link would expose
 * full history, commit messages, and remotes — and on the calibration branch the
 * commit messages name the defect), recursively materialising permitted
 * submodules at their recorded SHAs (a plain `git archive` records only
 * gitlinks), plus separately materialised spec / behavior manifest / routes /
 * migrations / diff, and the hashed run-final-uat harness copy injected under
 * inputs/.agents/skills/ (the historical candidate predates the skill, so the
 * harness is ALWAYS explicitly provided). Candidate source sits under
 * inputs/source/ — NOT as the project root — so candidate AGENTS.md files are
 * inspectable data, never auto-loaded instructions.
 *
 * FAIL-CLOSED submodules (round-3 finding 10): if a changed or scenario-relevant
 * submodule cannot be materialised, the required input capability is unavailable
 * and the run is `incomplete`, never a silent omission or an informational note.
 *
 * Emits input-manifest.json carrying the A8 risk baseline hash-bound, and
 * input_manifest_sha256 over the manifest (excluding that field). git/FS
 * operations are injectable so the orchestration is unit-testable without a
 * live repo.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, canonicalSha256, digestOf } from './canonicalize.mjs';
import { classifyChange } from './classify-change.mjs';
import { inventoryDigest } from './validate-uat-evidence.mjs';

/** Layer-1 risk baseline from the diff (plan A8): classifier-derived domain-risk
 *  tags, hash-bound. The tester may add risks but never remove one of these. */
export function computeRiskBaseline(changes, opts = {}) {
  const { risk_tags } = classifyChange(changes, opts);
  const risks = risk_tags.map((tag) => ({ tag, source: 'classifier' }));
  const inv = { risks };
  inv.sha256 = inventoryDigest(inv);
  return inv;
}

/** Merkle-style digest of a directory tree: sorted [{path, sha256}] + a single
 *  tree digest over that array. Deterministic and order-independent. */
export function hashTree(rootDir) {
  const files = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const p = path.join(abs, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        files.push({ path: path.relative(rootDir, p).replace(/\\/g, '/'), sha256: sha256Hex(readFileSync(p)) });
      }
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, tree_sha256: canonicalSha256(files) };
}

/** Assemble the input manifest and bind it with input_manifest_sha256 (computed
 *  over the manifest excluding that field). */
export function assembleInputManifest(fields) {
  const manifest = {
    schema_version: 'uat-input-manifest.v1',
    slug: fields.slug,
    code_candidate_sha: fields.codeCandidateSha,
    base_sha: fields.baseSha,
    source_tree_sha256: fields.sourceTreeSha256,
    submodule_shas: fields.submoduleShas || {},
    submodule_limitations: fields.submoduleLimitations || [],
    harness_skill_sha256: fields.harnessSkillSha256,
    materialised_inputs: fields.materialisedInputs || [],
    risk_baseline: fields.riskBaseline,
  };
  return { ...manifest, input_manifest_sha256: digestOf(manifest, ['input_manifest_sha256']) };
}

// Default git runner (child_process). Injectable for tests.
export function defaultGit(repoRoot) {
  return {
    archiveTree(treeish, destDir) {
      mkdirSync(destDir, { recursive: true });
      // The tar MUST live outside destDir, else it would be exported into the
      // sealed source tree and pollute source_tree_sha256.
      const tarDir = mkdtempSync(path.join(os.tmpdir(), 'uat-archive-'));
      const tmpTar = path.join(tarDir, 'candidate.tar');
      try {
        execFileSync('git', ['archive', '--format=tar', '-o', tmpTar, treeish], { cwd: repoRoot });
        // Portability: GNU tar treats a "-f C:\..." archive path as a remote
        // host:file spec. Pass the archive by RELATIVE name (cwd = tarDir) so it
        // carries no colon, and forward-slash the -C dir (accepted by GNU tar and
        // bsdtar alike).
        execFileSync('tar', ['-xf', 'candidate.tar', '-C', destDir.replace(/\\/g, '/')], { cwd: tarDir });
      } finally {
        try { rmSync(tarDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      return true;
    },
    submoduleEntries() {
      const gm = path.join(repoRoot, '.gitmodules');
      if (!existsSync(gm)) return [];
      const text = readFileSync(gm, 'utf8');
      const entries = [];
      const re = /\[submodule[^\]]*\][^[]*?path\s*=\s*(\S+)/g;
      let m;
      while ((m = re.exec(text))) entries.push({ path: m[1] });
      return entries;
    },
  };
}

/**
 * Build the sealed blind snapshot. FS/git ops via the injected `git` runner.
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.slug
 * @param {string} opts.codeCandidateSha
 * @param {string} opts.baseSha
 * @param {string} opts.outDir — the sandbox root; source goes to outDir/inputs/source
 * @param {Array} opts.changes — changed-file set (for the risk baseline)
 * @param {Array<{path:string,sha:string,relevant:boolean}>} [opts.submodules]
 * @param {string} [opts.harnessSkillDir] — dir to copy into inputs/.agents/skills/run-final-uat
 * @param {Array<{name:string,source:string}>} [opts.materialise] — extra inputs (spec, diff, manifest)
 * @param {object} [opts.git] — injected git runner (default: defaultGit)
 * @returns {{outDir:string, inputManifest:object}}
 */
export function buildBlindSnapshot(opts) {
  const git = opts.git || defaultGit(opts.repoRoot);
  const sourceDir = path.join(opts.outDir, 'inputs', 'source');
  mkdirSync(sourceDir, { recursive: true });
  git.archiveTree(opts.codeCandidateSha, sourceDir);

  // Fail-closed submodule materialisation.
  const submoduleShas = {};
  const submoduleLimitations = [];
  for (const sub of opts.submodules || []) {
    const dest = path.join(sourceDir, sub.path);
    let ok;
    try {
      ok = git.archiveSubmodule ? git.archiveSubmodule(sub.path, sub.sha, dest) : false;
    } catch {
      ok = false;
    }
    if (ok) {
      submoduleShas[sub.path] = sub.sha;
    } else if (sub.relevant) {
      // A changed / scenario-relevant submodule that cannot be materialised makes
      // the required input capability unavailable — the caller must mark incomplete.
      throw Object.assign(new Error(`blind snapshot: required submodule ${sub.path} could not be materialised`), {
        code: 'SUBMODULE_UNMATERIALISABLE',
        submodule: sub.path,
      });
    } else {
      submoduleLimitations.push({ path: sub.path, reason: 'excluded submodule not materialised (not scenario-relevant)' });
    }
  }

  // Inject the hashed harness skill under inputs/.agents/skills/run-final-uat.
  let harnessSkillSha256 = null;
  if (opts.harnessSkillDir && existsSync(opts.harnessSkillDir)) {
    const dest = path.join(opts.outDir, 'inputs', '.agents', 'skills', 'run-final-uat');
    copyDir(opts.harnessSkillDir, dest);
    harnessSkillSha256 = hashTree(dest).tree_sha256;
  }

  // Separately materialise spec / behavior manifest / routes / migrations / diff.
  const materialisedInputs = [];
  for (const item of opts.materialise || []) {
    const dest = path.join(opts.outDir, 'inputs', item.name);
    mkdirSync(path.dirname(dest), { recursive: true });
    if (existsSync(item.source)) {
      const buf = readFileSync(item.source);
      writeFileSync(dest, buf);
      materialisedInputs.push({ name: item.name, sha256: sha256Hex(buf) });
    }
  }

  const { tree_sha256 } = hashTree(sourceDir);
  const riskBaseline = computeRiskBaseline(opts.changes || [], { registry: opts.registry });
  const inputManifest = assembleInputManifest({
    slug: opts.slug,
    codeCandidateSha: opts.codeCandidateSha,
    baseSha: opts.baseSha,
    sourceTreeSha256: tree_sha256,
    submoduleShas,
    submoduleLimitations,
    harnessSkillSha256,
    materialisedInputs,
    riskBaseline,
  });
  writeFileSync(path.join(opts.outDir, 'input-manifest.json'), JSON.stringify(inputManifest, null, 2));
  return { outDir: opts.outDir, inputManifest };
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else if (st.isFile()) writeFileSync(d, readFileSync(s));
  }
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
  console.error('build-blind-snapshot.mjs is a library (buildBlindSnapshot); import it or wire it from acceptance-phase. Direct CLI is intentionally minimal.');
  process.exit(2);
}
