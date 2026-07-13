#!/usr/bin/env node
/**
 * Test suite for phase-lock.js — decidePhaseLock pure helper.
 *
 * Verifies: block-on-mismatch during spec/plan phases, allow-on-match,
 * allow during build/review/finalise, missing/empty/invalid .phase → no-op,
 * path normalisation (.. rejection), and the dependency-free glob matcher
 * (* no-cross-dir, ** deep crossing, negative wildcard).
 *
 * Run: node .claude/hooks/phase-lock.test.js
 * Exit 0 on all pass, 1 on any fail.
 *
 * Not picked up by vitest (config scopes to **\/__tests__/**\/*.test.ts).
 * This file is a sanity script — re-run after any change to phase-lock.js.
 */

import { decidePhaseLock, extractFilePaths, toRelative } from "./phase-lock.js";

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

  // 4. plan phase, Edit, docs/superpowers/specs/foo.md → allow
  [
    "plan phase, Edit, docs/superpowers/specs/foo.md, slug x → allow",
    { toolName: 'Edit', targetPath: 'docs/superpowers/specs/foo.md', currentPhase: 'plan', buildSlug: 'x' },
    'allow',
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

  // 13. Wildcard ** deep: spec phase, docs/superpowers/specs/nested/deep/foo.md → allow
  [
    "spec, Write, docs/superpowers/specs/nested/deep/foo.md → allow (** matches deep)",
    { toolName: 'Write', targetPath: 'docs/superpowers/specs/nested/deep/foo.md', currentPhase: 'spec', buildSlug: 'x' },
    'allow',
  ],

  // 14. Wildcard ** deeper: spec phase, prototypes/foo/bar/baz/index.html → allow
  [
    "spec, Write, prototypes/foo/bar/baz/index.html → allow (prototypes/**)",
    { toolName: 'Write', targetPath: 'prototypes/foo/bar/baz/index.html', currentPhase: 'spec', buildSlug: 'x' },
    'allow',
  ],

  // 15. Negative wildcard: plan phase, docs/superpowers/specs-other/foo.md → block
  [
    "plan, Write, docs/superpowers/specs-other/foo.md → block (docs/superpowers/specs/** must not match specs-other)",
    { toolName: 'Write', targetPath: 'docs/superpowers/specs-other/foo.md', currentPhase: 'plan', buildSlug: 'x' },
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

const totalCases = CASES.length + EXTRACT_CASES.length + TO_REL_CASES.length + cwdFallbackCases;
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
