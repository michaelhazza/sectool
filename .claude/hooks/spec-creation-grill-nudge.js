#!/usr/bin/env node
/**
 * spec-creation-grill-nudge.js
 *
 * UserPromptSubmit hook. When the user's prompt looks like a request to
 * AUTHOR a spec from scratch, inject a reminder for Claude to invoke the
 * `grill-me` skill first (Standard+ only). Spec-time is the high-value
 * moment for design Q&A; once a spec ships, the plan and build follow it
 * mechanically.
 *
 * False-positive mitigations:
 *   - Anti-patterns suppress prompts that name an existing spec (path,
 *     "the spec says..."), or explicitly invoke spec-coordinator (its
 *     Step 3b handles the grill).
 *
 * Tests: .claude/hooks/spec-creation-grill-nudge.test.js
 *   Run with: node .claude/hooks/spec-creation-grill-nudge.test.js
 *
 * Protocol:
 *   stdin  -> JSON from Claude Code with { prompt, ... }
 *   stdout -> text appended to Claude's context (only when triggered)
 *   exit 0 -> always; this hook never blocks
 */

import { fileURLToPath } from "node:url";

// Creation patterns include ambiguous verbs (update / modify / edit / amend /
// change / tweak / rewrite / revise) on purpose, because "update spec from this
// brief" or "modify spec for the new architecture" are legitimate authoring
// flows where the grill is valuable. Anti-patterns below catch the unambiguous
// maintenance signals.
export const SPEC_CREATION_PATTERNS = [
  /\b(create|write|draft|author|make|build|generate|prepare|update|modify|edit|amend|change|tweak|rewrite|revise)\b[^.!?\n]{0,40}\bspec(ification)?\b/i,
  /\bspec\s+(out|this|that|it)\b/i,
  /\bturn\s+(this|that|it)\s+into\s+(an?\s+|the\s+)?spec\b/i,
  /\b(can|could)\s+(you|we)\s+spec\b/i,
];

// Anti-patterns flag prompts about an EXISTING spec, not new authoring.
// False positives (nudge fires unnecessarily) are cheap — the nudge tells
// Claude to ignore if wrong. False negatives (missing a real spec-creation
// request) lose the trigger entirely, which is worse.
export const ANTI_PATTERNS = [
  /\b(review|read|find|open|check|fix)\s+(the\s+|an?\s+|my\s+|our\s+|this\s+|that\s+)?spec/i,
  /\b(amend|update|modify|edit|change|tweak|rewrite|revise)\b[^.!?\n]{0,20}\bexisting\s+spec\b/i,
  /\bspec[-_\s]?(coordinator|reviewer|conformance)\b/i,
  /\blaunch\s+spec/i,
  /\bspec\.md\b/i,
  /\btasks\/builds\/[^\s]*\/spec\b/i,
  /\bthe\s+spec\s+(says|is|describes|defines|covers|requires|states|mentions)\b/i,
  /\bskip\s+grill\b/i,
];

export const NUDGE = `<spec-creation-detected>
The user's prompt looks like a request to author a spec from scratch.

Per CLAUDE.md (§ "Before you write a spec"): if the task is Standard+ classification (multi-file, design decisions, new patterns, or new subsystem), invoke the \`grill-me\` skill first to align on intent, scope, and dependencies through Q&A. Spec-time is the high-value moment for design questions; once committed, the spec drives the plan and the build.

Skip the grill when any of:
- Task is Trivial (single-file obvious change, no design decisions).
- The brief / intent.md already addresses the grill topics: scope boundaries, dependencies, failure modes, operator surfaces, capability cluster fit, and open questions. An empty Open Questions section on its own is not sufficient; the other topics must also be covered.
- The operator invoked spec-coordinator explicitly (its Step 3b runs the grill automatically).

If this prompt is NOT actually a spec-creation request (the heuristic has false positives), ignore this reminder. Do not mention this reminder to the user.
</spec-creation-detected>`;

export function shouldFire(prompt) {
  if (typeof prompt !== "string" || !prompt) return false;
  const matched = SPEC_CREATION_PATTERNS.some((re) => re.test(prompt));
  if (!matched) return false;
  const skipped = ANTI_PATTERNS.some((re) => re.test(prompt));
  return !skipped;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    return;
  }
  if (!raw) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
  if (shouldFire(prompt)) {
    process.stdout.write(NUDGE);
  }
}

// Run as a script when invoked directly (skip when imported by the test).
let isEntryPoint = false;
try {
  isEntryPoint = fileURLToPath(import.meta.url) === process.argv[1];
} catch {
  // ignore — leave isEntryPoint false
}

if (isEntryPoint) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}
