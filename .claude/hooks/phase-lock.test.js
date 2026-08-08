#!/usr/bin/env node
/**
 * Test suite for phase-lock.js — decidePhaseLock pure helper.
 *
 * Verifies: block-on-mismatch during spec/plan phases, allow-on-match,
 * allow during build/review/finalise, missing/empty/invalid .phase → no-op,
 * path normalisation (.. rejection), and the dependency-free glob matcher
 * (* no-cross-dir, ** deep crossing, negative wildcard). Also verifies the
 * C9 slug-resolution fix: status.json admission, deriveSlugFromPath,
 * extractBuildSlugFromContent (marker-scoped vs pre-migration whole-file),
 * and resolvePhaseLockContext end-to-end (path-derived slug precedence,
 * the legacy-above-markers live-bug replica, absent-current-focus fail-open
 * scoped to a single write).
 *
 * Run: node .claude/hooks/phase-lock.test.js
 * Exit 0 on all pass, 1 on any fail.
 *
 * Not picked up by vitest (config scopes to **\/__tests__/**\/*.test.ts).
 * This file is a sanity script — re-run after any change to phase-lock.js.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decidePhaseLock,
  extractFilePaths,
  toRelative,
  deriveSlugFromPath,
  extractBuildSlugFromContent,
  resolvePhaseLockContext,
} from "./phase-lock.js";

// [label, input, expectedDisposition]
const CASES = [
  // 1. null phase → allow (no-op)
  [
    "null phase, Edit, server/foo.ts → allow",
    { toolName: 'Edit', targetPath: 'server/foo.ts', currentPhase: null, buildSlug: 'x' },
    'allow',
  ],

  // 2. plan phase, Edit, server file → block
  [
    "plan phase, Edit, server/foo.ts, slug x → block",
    { toolName: 'Edit', targetPath: 'server/foo.ts', currentPhase: 'plan', buildSlug: 'x' },
    'block',
  ],

  // 3. plan phase, Edit, tasks/builds/x/plan.md → allow
  [
    "plan phase, Edit, tasks/builds/x/plan.md, slug x → allow",
    { toolName: 'Edit', targetPath: 'tasks/builds/x/plan.md', currentPhase: 'plan', buildSlug: 'x' },
    'allow',
  ],

  // 4. plan phase, Edit, docs/superpowers/specs/foo.md → block (W2.7 froze superpowers spec writes)
  [
    "plan phase, Edit, docs/superpowers/specs/foo.md, slug x → block (superpowers freeze)",
    { toolName: 'Edit', targetPath: 'docs/superpowers/specs/foo.md', currentPhase: 'plan', buildSlug: 'x' },
    'block',
  ],

  // 5. spec phase, Write, tasks/builds/x/plan.md → block (plan.md not allowed in spec phase)
  [
    "spec phase, Write, tasks/builds/x/plan.md, slug x → block",
    { toolName: 'Write', targetPath: 'tasks/builds/x/plan.md', currentPhase: 'spec', buildSlug: 'x' },
    'block',
  ],

  // 6. build phase, Edit, server/foo.ts → allow
  [
    "build phase, Edit, server/foo.ts, slug x → allow",
    { toolName: 'Edit', targetPath: 'server/foo.ts', currentPhase: 'build', buildSlug: 'x' },
    'allow',
  ],

  // 7. review phase, MultiEdit, client/x.tsx → allow
  [
    "review phase, MultiEdit, client/x.tsx, slug x → allow",
    { toolName: 'MultiEdit', targetPath: 'client/x.tsx', currentPhase: 'review', buildSlug: 'x' },
    'allow',
  ],

  // 8. finalise phase, Write, KNOWLEDGE.md → allow
  [
    "finalise phase, Write, KNOWLEDGE.md, slug x → allow",
    { toolName: 'Write', targetPath: 'KNOWLEDGE.md', currentPhase: 'finalise', buildSlug: 'x' },
    'allow',
  ],

  // 9. plan phase, Edit, ../escape/foo.ts → block (.. traversal)
  [
    "plan phase, Edit, ../escape/foo.ts, slug x → block",
    { toolName: 'Edit', targetPath: '../escape/foo.ts', currentPhase: 'plan', buildSlug: 'x' },
    'block',
  ],

  // 10. plan phase, Bash (unknown tool) → allow (fail-open for non-registered tool)
  [
    "plan phase, Bash, server/foo.ts, slug x → allow (fail-open)",
    { toolName: 'Bash', targetPath: 'server/foo.ts', currentPhase: 'plan', buildSlug: 'x' },
    'allow',
  ],

  // 11. Wildcard * (no cross-dir): spec phase, mockup-review-log-2026-06-01.md → allow
  [
    "spec, Write, tasks/builds/x/mockup-review-log-2026-06-01.md → allow (* matches suffix)",
    { toolName: 'Write', targetPath: 'tasks/builds/x/mockup-review-log-2026-06-01.md', currentPhase: 'spec', buildSlug: 'x' },
    'allow',
  ],

  // 12. Wildcard * does NOT cross /: spec phase, mockup-review-log-subdir/foo.md → block
  [
    "spec, Write, tasks/builds/x/mockup-review-log-subdir/foo.md → block (* must not cross /)",
    { toolName: 'Write', targetPath: 'tasks/builds/x/mockup-review-log-subdir/foo.md', currentPhase: 'spec', buildSlug: 'x' },
    'block',
  ],

  // 13. Superpowers freeze (W2.7): spec phase, docs/superpowers/specs/nested/deep/foo.md → block
  //     (new spec writes must live under tasks/builds/<slug>/; the ** deep-match itself is covered by case 14)
  [
    "spec, Write, docs/superpowers/specs/nested/deep/foo.md → block (superpowers freeze)",
    { toolName: 'Write', targetPath: 'docs/superpowers/specs/nested/deep/foo.md', currentPhase: 'spec', buildSlug: 'x' },
    'block',
  ],

  // 14. Wildcard ** deeper: spec phase, prototypes/foo/bar/baz/index.html → allow
  [
    "spec, Write, prototypes/foo/bar/baz/index.html → allow (prototypes/**)",
    { toolName: 'Write', targetPath: 'prototypes/foo/bar/baz/index.html', currentPhase: 'spec', buildSlug: 'x' },
    'allow',
  ],

  // 15. Negative wildcard: plan phase, prototypes-other/foo.md → block (prototypes/** must not match prototypes-other)
  [
    "plan, Write, prototypes-other/foo.md → block (prototypes/** must not match prototypes-other)",
    { toolName: 'Write', targetPath: 'prototypes-other/foo.md', currentPhase: 'plan', buildSlug: 'x' },
    'block',
  ],

  // 16. tasks/review-logs **: spec phase, tasks/review-logs/some-review-log.md → allow
  [
    "spec, Write, tasks/review-logs/some-review-log.md → allow (tasks/review-logs/**)",
    { toolName: 'Write', targetPath: 'tasks/review-logs/some-review-log.md', currentPhase: 'spec', buildSlug: 'x' },
    'allow',
  ],

  // 17. (R5 OAI-PR-002 regression) plan phase, Write, tasks/builds/x/handoff.md → allow.
  // The pause-state path writes handoff.md while .phase=plan; the allow-list MUST
  // include this file or the pause persist gets blocked.
  [
    "plan, Write, tasks/builds/x/handoff.md → allow (handoff.md in specGlobs)",
    { toolName: 'Write', targetPath: 'tasks/builds/x/handoff.md', currentPhase: 'plan', buildSlug: 'x' },
    'allow',
  ],

  // 18. Same in spec phase — handoff.md write is also legitimate in spec phase
  // (e.g. mockup-loop pause writes handoff.md).
  [
    "spec, Write, tasks/builds/x/handoff.md → allow (handoff.md in specGlobs)",
    { toolName: 'Write', targetPath: 'tasks/builds/x/handoff.md', currentPhase: 'spec', buildSlug: 'x' },
    'allow',
  ],

  // 19. `..` traversal in build phase → allow. The header contract says
  // build/review/finalise are unrestricted ("always allow"), so the
  // traversal check must not run before those short-circuits.
  [
    "build phase, Edit, ../escape/foo.ts, slug x → allow (unrestricted phase never blocks)",
    { toolName: 'Edit', targetPath: '../escape/foo.ts', currentPhase: 'build', buildSlug: 'x' },
    'allow',
  ],

  // 20. `..` traversal with null phase → allow. Missing/invalid .phase is a
  // no-op per the header contract — it must never block anything.
  [
    "null phase, Edit, ../escape/foo.ts, slug x → allow (null phase is a no-op)",
    { toolName: 'Edit', targetPath: '../escape/foo.ts', currentPhase: null, buildSlug: 'x' },
    'allow',
  ],

  // 21. `..` traversal in spec phase → block (restricted phases still reject
  // traversal; case 9 pins the same for plan phase).
  [
    "spec phase, Edit, ../escape/foo.ts, slug x → block",
    { toolName: 'Edit', targetPath: '../escape/foo.ts', currentPhase: 'spec', buildSlug: 'x' },
    'block',
  ],

  // 22. status.json admitted in spec phase (C9 contract 1 — the status-write
  // step in the coordinators depends on this).
  [
    "spec phase, Write, tasks/builds/x/status.json, slug x → allow (status.json in specGlobs)",
    { toolName: 'Write', targetPath: 'tasks/builds/x/status.json', currentPhase: 'spec', buildSlug: 'x' },
    'allow',
  ],

  // 23. status.json admitted in plan phase (plan = specGlobs + plan.md, so
  // status.json is inherited from the spec allow-list).
  [
    "plan phase, Write, tasks/builds/x/status.json, slug x → allow (status.json in specGlobs, inherited into plan)",
    { toolName: 'Write', targetPath: 'tasks/builds/x/status.json', currentPhase: 'plan', buildSlug: 'x' },
    'allow',
  ],
];

let pass = 0;
const fails = [];
for (const [label, input, expected] of CASES) {
  const result = decidePhaseLock(input);
  if (result.disposition === expected) {
    pass++;
  } else {
    fails.push({ label, input, expected, actual: result.disposition, reason: result.reason });
  }
}

// ── extractFilePaths payload-shape regressions ─────────────────────────────
// Real Claude Code MultiEdit payloads carry `file_path` at the top level,
// with edits[] containing only `old_string`/`new_string`. A prior version of
// the extractor scanned edits[].file_path and returned [] for valid payloads,
// silently bypassing the phase-lock guard for MultiEdit. These cases pin the
// shape contract.
const EXTRACT_CASES = [
  [
    "MultiEdit hook payload uses top-level file_path",
    'MultiEdit',
    { file_path: 'server/foo.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
    ['server/foo.ts'],
  ],
  [
    "MultiEdit with missing top-level file_path returns empty (no false positives)",
    'MultiEdit',
    { edits: [{ old_string: 'a', new_string: 'b' }] },
    [],
  ],
  [
    "Edit hook payload uses top-level file_path",
    'Edit',
    { file_path: 'server/foo.ts', old_string: 'a', new_string: 'b' },
    ['server/foo.ts'],
  ],
  [
    "Write hook payload uses top-level file_path",
    'Write',
    { file_path: 'tasks/builds/x/spec.md', content: 'hello' },
    ['tasks/builds/x/spec.md'],
  ],
];

for (const [label, toolName, toolInput, expectedPaths] of EXTRACT_CASES) {
  const actual = extractFilePaths(toolName, toolInput);
  const ok = JSON.stringify(actual) === JSON.stringify(expectedPaths);
  if (ok) {
    pass++;
  } else {
    fails.push({
      label,
      input: { toolName, toolInput },
      expected: expectedPaths,
      actual,
      reason: 'extractFilePaths returned unexpected paths',
    });
  }
}

// ── toRelative path-prefix boundary cases (R5 OAI-PR-001 regression) ──────
// The exact-match branch previously used `lhs.startsWith(rhs)`, so a sibling
// path whose string prefix coincidentally matched the project dir (e.g.
// /tmp/repotasks given PROJECT_DIR=/tmp/repo) was incorrectly stripped and
// presented as a repo-relative path to the matcher. Pin the boundary.
const TO_REL_CASES = [
  [
    "PROJECT_DIR=/tmp/repo, abs=/tmp/repo/tasks/builds/x/plan.md → 'tasks/builds/x/plan.md'",
    '/tmp/repo',
    '/tmp/repo/tasks/builds/x/plan.md',
    'tasks/builds/x/plan.md',
  ],
  [
    "PROJECT_DIR=/tmp/repo, abs=/tmp/repotasks/builds/x/plan.md → unchanged (no boundary)",
    '/tmp/repo',
    '/tmp/repotasks/builds/x/plan.md',
    '/tmp/repotasks/builds/x/plan.md',
  ],
  [
    "PROJECT_DIR=/tmp/repo, abs=/tmp/repo → '' (exact match)",
    '/tmp/repo',
    '/tmp/repo',
    '',
  ],
  [
    "PROJECT_DIR=/tmp/repo/ trailing-slash, abs=/tmp/repo/tasks/builds/x/plan.md → 'tasks/builds/x/plan.md'",
    '/tmp/repo/',
    '/tmp/repo/tasks/builds/x/plan.md',
    'tasks/builds/x/plan.md',
  ],
];

const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
for (const [label, projectDir, abs, expected] of TO_REL_CASES) {
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  const actual = toRelative(abs);
  if (actual === expected) {
    pass++;
  } else {
    fails.push({
      label,
      input: { projectDir, abs },
      expected,
      actual,
      reason: 'toRelative returned unexpected path',
    });
  }
}
// Restore prior env so subsequent invocations of this file are deterministic.
if (prevProjectDir === undefined) {
  delete process.env.CLAUDE_PROJECT_DIR;
} else {
  process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
}

// ── cwd fallback when CLAUDE_PROJECT_DIR is unset ──────────────────────────
// toRelative previously returned absolute paths unchanged when
// CLAUDE_PROJECT_DIR was unset, so an absolute path inside the repo never
// matched the relative allow-globs and spec/plan phases blocked legitimate
// edits (fail-closed bug). Pin the process.cwd() fallback: an absolute path
// under the cwd must resolve relative and be allowed in spec phase.
let cwdFallbackCases = 0;
{
  const saved = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  const cwd = process.cwd().replace(/\\/g, '/');

  cwdFallbackCases++;
  const relActual = toRelative(`${cwd}/tasks/builds/x/spec.md`);
  if (relActual === 'tasks/builds/x/spec.md') {
    pass++;
  } else {
    fails.push({
      label: "no CLAUDE_PROJECT_DIR: toRelative(cwd + '/tasks/builds/x/spec.md') → 'tasks/builds/x/spec.md'",
      input: { projectDir: '(unset)', abs: `${cwd}/tasks/builds/x/spec.md` },
      expected: 'tasks/builds/x/spec.md',
      actual: relActual,
      reason: 'toRelative did not fall back to process.cwd()',
    });
  }

  cwdFallbackCases++;
  const decision = decidePhaseLock({
    toolName: 'Write',
    targetPath: `${cwd}/tasks/builds/x/spec.md`,
    currentPhase: 'spec',
    buildSlug: 'x',
  });
  if (decision.disposition === 'allow') {
    pass++;
  } else {
    fails.push({
      label: "no CLAUDE_PROJECT_DIR: spec, Write, <cwd>/tasks/builds/x/spec.md → allow",
      input: { projectDir: '(unset)', abs: `${cwd}/tasks/builds/x/spec.md` },
      expected: 'allow',
      actual: decision.disposition,
      reason: decision.reason,
    });
  }

  if (saved === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = saved;
  }
}

// ── deriveSlugFromPath pure cases (C9 contract 2 — path-derived slug) ──────
const DERIVE_SLUG_CASES = [
  [
    "tasks/builds/my-slug/spec.md → 'my-slug'",
    'tasks/builds/my-slug/spec.md',
    'my-slug',
  ],
  [
    "tasks/builds/my-slug/nested/deep/file.ts → 'my-slug' (nested build-dir path)",
    'tasks/builds/my-slug/nested/deep/file.ts',
    'my-slug',
  ],
  [
    "docs/superpowers/specs/foo.md → null (not a build-dir path)",
    'docs/superpowers/specs/foo.md',
    null,
  ],
  [
    "tasks/builds/ → null (no slug segment)",
    'tasks/builds/',
    null,
  ],
  [
    "tasks\\builds\\win-slug\\spec.md → 'win-slug' (backslash path normalised)",
    'tasks\\builds\\win-slug\\spec.md',
    'win-slug',
  ],
];

for (const [label, input, expected] of DERIVE_SLUG_CASES) {
  const actual = deriveSlugFromPath(input);
  if (actual === expected) {
    pass++;
  } else {
    fails.push({ label, input, expected, actual, reason: 'deriveSlugFromPath returned unexpected slug' });
  }
}

// ── extractBuildSlugFromContent pure cases (C9 contract 3 — marker-scoped
// fallback) ─────────────────────────────────────────────────────────────
// No-markers content mirrors the pre-migration whole-file first-match regex
// — byte-identical behaviour to the original single-pointer readBuildSlug.
const NO_MARKER_CONTENT =
  '<!-- mission-control\nbuild_slug: geo-auto-publish\nbranch: some-branch\n-->\n' +
  'some other prose mentioning the build slug is not a match\n';

// Markers present: only the region between BEGIN/END is searched. The
// content before the markers deliberately contains a DIFFERENT build_slug
// (the live-bug replica: a frozen legacy top block naming slug-a with no
// .phase, plus a marker region naming slug-b which has a .phase) to prove
// marker-scoping, not just "which content wins when there is one candidate".
const MARKER_CONTENT =
  '<!-- mission-control\nbuild_slug: slug-a\nbranch: legacy-branch\n-->\n' +
  '<!-- STATUS:GENERATED:BEGIN -->\n' +
  '### slug-b\nbuild_slug: slug-b\nstatus: BUILDING\nphase: spec\n' +
  '<!-- STATUS:GENERATED:END -->\n';

const EXTRACT_SLUG_FROM_CONTENT_CASES = [
  [
    "no markers → whole-file first match (pre-migration, byte-identical to original regex)",
    NO_MARKER_CONTENT,
    'geo-auto-publish',
  ],
  [
    "markers present → first match INSIDE region wins, legacy block above ignored (live-bug replica)",
    MARKER_CONTENT,
    'slug-b',
  ],
  [
    "no build_slug anywhere → null",
    '# Nothing relevant here\n',
    null,
  ],
];

for (const [label, content, expected] of EXTRACT_SLUG_FROM_CONTENT_CASES) {
  const actual = extractBuildSlugFromContent(content);
  if (actual === expected) {
    pass++;
  } else {
    fails.push({ label, input: content, expected, actual, reason: 'extractBuildSlugFromContent returned unexpected slug' });
  }
}

// ── resolvePhaseLockContext FS-fixture cases (C9 end-to-end) ───────────────
// mkdtempSync temp-dir fixtures, same pattern as memory-digest.test.js and
// config-protection.test.js.
let resolveContextCases = 0;

// RC-1. Path-derived slug takes precedence over the current-focus fallback.
// slug-a (named by current-focus.md) is unrestricted (build phase); slug-b
// (derived from the write's own path) is restricted (spec phase). If the
// resolver wrongly fell back to slug-a, a non-allow-listed file would be
// ALLOWED (build is unrestricted) — the assertions below catch that.
{
  const proj = mkdtempSync(join(tmpdir(), 'pl-pathderiv-'));
  mkdirSync(join(proj, 'tasks', 'builds', 'slug-a'), { recursive: true });
  mkdirSync(join(proj, 'tasks', 'builds', 'slug-b'), { recursive: true });
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), 'build_slug: slug-a\n');
  writeFileSync(join(proj, 'tasks', 'builds', 'slug-a', '.phase'), 'build\n');
  writeFileSync(join(proj, 'tasks', 'builds', 'slug-b', '.phase'), 'spec\n');

  resolveContextCases++;
  const ctx = resolvePhaseLockContext(proj, 'tasks/builds/slug-b/spec.md');
  if (ctx.slug === 'slug-b' && ctx.phase === 'spec') {
    pass++;
  } else {
    fails.push({
      label: 'path-derived slug: write to tasks/builds/slug-b/spec.md while current-focus names slug-a → resolves slug-b',
      input: 'tasks/builds/slug-b/spec.md',
      expected: { slug: 'slug-b', phase: 'spec' },
      actual: ctx,
      reason: 'resolvePhaseLockContext did not derive slug from path',
    });
  }

  resolveContextCases++;
  const ctx2 = resolvePhaseLockContext(proj, 'tasks/builds/slug-b/random-code.ts');
  const decision = decidePhaseLock({
    toolName: 'Write',
    targetPath: 'tasks/builds/slug-b/random-code.ts',
    currentPhase: ctx2.phase,
    buildSlug: ctx2.slug,
  });
  if (decision.disposition === 'block') {
    pass++;
  } else {
    fails.push({
      label: 'path-derived slug: tasks/builds/slug-b/random-code.ts blocked under slug-b spec phase (proves path precedence over the unrestricted slug-a fallback)',
      input: 'tasks/builds/slug-b/random-code.ts',
      expected: 'block',
      actual: decision.disposition,
      reason: decision.reason,
    });
  }

  rmSync(proj, { recursive: true, force: true });
}

// RC-2. Legacy-above-markers end-to-end (the live-bug replica, via real
// files): a non-build-dir write must resolve slug-b (marker-scoped), not
// slug-a (frozen legacy block, no .phase — the pre-fix bug enforced nothing
// because readPhase(slug-a) returned null).
{
  const proj = mkdtempSync(join(tmpdir(), 'pl-legacy-markers-'));
  mkdirSync(join(proj, 'tasks', 'builds', 'slug-b'), { recursive: true });
  const content =
    '<!-- mission-control\n' +
    'build_slug: slug-a\n' +
    'branch: legacy-branch\n' +
    '-->\n' +
    '<!-- STATUS:GENERATED:BEGIN -->\n' +
    '### slug-b\n' +
    'build_slug: slug-b\n' +
    'status: BUILDING\n' +
    'phase: spec\n' +
    '<!-- STATUS:GENERATED:END -->\n';
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), content);
  // slug-a deliberately has NO .phase file.
  writeFileSync(join(proj, 'tasks', 'builds', 'slug-b', '.phase'), 'spec\n');

  resolveContextCases++;
  const ctx = resolvePhaseLockContext(proj, 'docs/superpowers/specs/foo.md');
  if (ctx.slug === 'slug-b' && ctx.phase === 'spec') {
    pass++;
  } else {
    fails.push({
      label: 'legacy-above-markers: non-build-dir write resolves slug-b (marker-scoped), not slug-a (legacy block)',
      input: 'docs/superpowers/specs/foo.md',
      expected: { slug: 'slug-b', phase: 'spec' },
      actual: ctx,
      reason: 'resolvePhaseLockContext did not scope the fallback read to the marker region',
    });
  }

  rmSync(proj, { recursive: true, force: true });
}

// RC-3. Build-dir write with current-focus.md entirely absent → still
// governed by the path-derived build's phase. Must not crash; must not
// regress to fail-open.
{
  const proj = mkdtempSync(join(tmpdir(), 'pl-absent-focus-builddir-'));
  mkdirSync(join(proj, 'tasks', 'builds', 'slug-c'), { recursive: true });
  writeFileSync(join(proj, 'tasks', 'builds', 'slug-c', '.phase'), 'plan\n');
  // Deliberately no tasks/current-focus.md at all.

  resolveContextCases++;
  const ctx = resolvePhaseLockContext(proj, 'tasks/builds/slug-c/random-code.ts');
  if (ctx.slug === 'slug-c' && ctx.phase === 'plan') {
    pass++;
  } else {
    fails.push({
      label: 'build-dir write, current-focus.md entirely absent → still governed by path-derived slug (no crash, no fail-open regression)',
      input: 'tasks/builds/slug-c/random-code.ts',
      expected: { slug: 'slug-c', phase: 'plan' },
      actual: ctx,
      reason: 'resolvePhaseLockContext failed to derive from path when current-focus.md is missing',
    });
  }

  resolveContextCases++;
  const decision = decidePhaseLock({
    toolName: 'Write',
    targetPath: 'tasks/builds/slug-c/random-code.ts',
    currentPhase: ctx.phase,
    buildSlug: ctx.slug,
  });
  if (decision.disposition === 'block') {
    pass++;
  } else {
    fails.push({
      label: 'build-dir write, current-focus.md absent → plan phase still enforces (random-code.ts blocked)',
      input: 'tasks/builds/slug-c/random-code.ts',
      expected: 'block',
      actual: decision.disposition,
      reason: decision.reason,
    });
  }

  rmSync(proj, { recursive: true, force: true });
}

// RC-4. True fail-open: no slug derivable at all (no path match AND no
// current-focus fallback). This is the only case resolvePhaseLockContext
// should return null for.
{
  const proj = mkdtempSync(join(tmpdir(), 'pl-true-failopen-'));

  resolveContextCases++;
  const ctx = resolvePhaseLockContext(proj, 'server/foo.ts');
  if (ctx.slug === null && ctx.phase === null) {
    pass++;
  } else {
    fails.push({
      label: 'no slug derivable at all (no path match, no current-focus fallback) → { slug: null, phase: null }',
      input: 'server/foo.ts',
      expected: { slug: null, phase: null },
      actual: ctx,
      reason: 'resolvePhaseLockContext should fail-open when nothing can be derived',
    });
  }

  rmSync(proj, { recursive: true, force: true });
}

// RC-5. Pre-migration whole-file fallback via real files (no markers) — a
// non-build-dir write resolves the same way it did before this fix.
{
  const proj = mkdtempSync(join(tmpdir(), 'pl-premigration-'));
  mkdirSync(join(proj, 'tasks', 'builds', 'legacy-slug'), { recursive: true });
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), 'build_slug: legacy-slug\nbranch: some-branch\n');
  writeFileSync(join(proj, 'tasks', 'builds', 'legacy-slug', '.phase'), 'finalise\n');

  resolveContextCases++;
  const ctx = resolvePhaseLockContext(proj, 'tasks/review-logs/some-log.md');
  if (ctx.slug === 'legacy-slug' && ctx.phase === 'finalise') {
    pass++;
  } else {
    fails.push({
      label: 'pre-migration (no markers): non-build-dir write resolves the whole-file first-match build_slug, byte-identical to today',
      input: 'tasks/review-logs/some-log.md',
      expected: { slug: 'legacy-slug', phase: 'finalise' },
      actual: ctx,
      reason: 'resolvePhaseLockContext regressed the pre-migration whole-file fallback',
    });
  }

  rmSync(proj, { recursive: true, force: true });
}

const totalCases =
  CASES.length +
  EXTRACT_CASES.length +
  TO_REL_CASES.length +
  cwdFallbackCases +
  DERIVE_SLUG_CASES.length +
  EXTRACT_SLUG_FROM_CONTENT_CASES.length +
  resolveContextCases;
console.log(`Cases: ${totalCases}, passed: ${pass}, failed: ${fails.length}`);
if (fails.length) {
  for (const f of fails) {
    console.log(
      `FAIL disposition=${f.actual} expected=${f.expected} | ${f.label} | reason: ${f.reason}`,
    );
  }
  process.exit(1);
}
process.exit(0);
