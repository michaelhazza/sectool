#!/usr/bin/env node
/**
 * review-artifact-nudge.js
 *
 * UserPromptSubmit hook. When the operator asks for an artifact to hand to an
 * external reviewer — a code diff, a spec, a plan, a brief, a cross-tool
 * handoff — or asks for a file link, inject the mandatory handoff contract
 * into context BEFORE the response is composed.
 *
 * WHY THIS EXISTS
 * The contract lived in references/review-mode-resolution.md, but only the
 * three ChatGPT review agents' round loops consulted it. An ad-hoc request
 * ("give me a code-only diff") ran through none of them, so nothing bound the
 * response and the handoff came out wrong three ways at once: file written
 * OUTSIDE the workspace (uneditable, unlinkable), path printed as bare text
 * rather than a clickable link, and no reviewer prompt supplied. Same lesson
 * as the Codex binary-resolution rule the day this was written: prose
 * re-applied by each caller from memory drifts; injection at the moment of
 * the ask binds.
 *
 * Deliberately UserPromptSubmit rather than Stop: nudging after the fact
 * still ships a broken handoff and costs the operator a round trip.
 *
 * Detection is conservative: it requires an artifact noun AND a
 * review/handoff-or-link intent, so ordinary talk about "the spec" does not
 * fire it. False negatives are cheap (the review agents still carry the rule
 * themselves); false positives are context noise on every unrelated turn.
 *
 * Protocol:
 *   stdin  → JSON from Claude Code with { prompt, ... }
 *   stdout → text appended to Claude's context (only on detection)
 *   exit 0 → always; this hook never blocks
 */

// The thing being asked for.
const ARTIFACT_PATTERNS = [
  /\bcode[- ]only\b/i,
  /\bdiff\b/i,
  /\bpatch file\b/i,
  /\bspec\b/i,
  /\bplan\b/i,
  /\bbrief\b/i,
  /\bhandoff\b/i,
  /\bpr\b/i,
];

// What they want to do with it. Without this gate, "the spec says X" would fire.
const HANDOFF_INTENT_PATTERNS = [
  /\b(external|outside|independent)\s+(review|reviewer|opinion)\b/i,
  /\bfor\s+(a\s+|final\s+|external\s+)?review\b/i,
  /\breview\s+(file|bundle|package|artifact|artefact)\b/i,
  // A tool NAME alone is not handoff intent. This originally matched a bare
  // mention of `codex`/`chatgpt`, which fires constantly in a codebase whose
  // pipeline discusses those tools in ordinary conversation — e.g. "can Codex
  // decide the frontend test scope?" tripped it via `spec` + `codex`. The name
  // must now be paired with a verb that means "hand it over".
  // Directed AT the tool ("to/into/for ChatGPT"), which is handoff intent,
  // rather than merely ABOUT it. Covers "prepare the brief for ChatGPT" and
  // "create a handoff for codex" without matching "does the spec say Codex
  // owns the plan review?".
  /\b(to|into|for)\s+(chat\s?gpt|gpt-?\d|openai|codex|gemini)\b/i,
  /\b(chat\s?gpt|gpt-?\d|openai|codex|gemini)\s+(review|to review)\b/i,
  /\b(give|get|send|hand|export|generate|produce|create|prepare)\s+(me|us)\b/i,
  /\b(link|attach)\s+(me\s+)?(the|a|that|this)\b/i,
  /\bso i can (copy|paste|share|send|upload)\b/i,
  /\bclickable\b/i,
];

const CONTRACT = `<review-artifact-handoff>
The operator appears to be asking for an artifact to hand to an external
reviewer, or for a file link. references/review-mode-resolution.md
§ "External-review artifact handoff" is MANDATORY. Three requirements, all in
the SAME message:

1. FILE INSIDE THE WORKSPACE — never a temp dir or outside the repo root; the
   editor can only open/copy workspace files, and copying out is the whole
   point. Must-not-commit files get GITIGNORED, not exiled. Canonical:
   tasks/builds/<slug>/code-only.diff + code-only-review-prompt.md
   (gitignore tasks/builds/*/code-only.diff once; covers every build).
2. CLICKABLE workspace-relative markdown link: [name](path). A bare absolute
   path is not a link. State size + file count.
3. READY-TO-PASTE REVIEWER PROMPT as its own linked file, never buried in
   chat: what the code is / is not; how to read the artifact (multi-repo
   layout, apparent duplicates, where fixes land); what to prioritise from
   where prior passes found real defects; do-not-re-report + verified-clean
   lists; wanted output format.

Requirements 1+2 also bind ANY file the operator is told about (mockups,
audit logs, post-mortems, research briefs). Requirement 3 distinguishes
"someone else reviews this" from "you read this".

Pre-send check: file inside workspace; git check-ignore confirms
non-committable where applicable; link workspace-relative; prompt file exists
and is linked.
</review-artifact-handoff>`;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // If stdin never delivers, do not hang the turn.
    const t = setTimeout(() => resolve(data), 2000);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Does this prompt ask for a review artifact or a file link? */
function wantsReviewArtifact(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return false;
  if (!ARTIFACT_PATTERNS.some((re) => re.test(prompt))) return false;
  return HANDOFF_INTENT_PATTERNS.some((re) => re.test(prompt));
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {
    process.exit(0); // Malformed stdin is never this hook's problem to report.
  }
  if (wantsReviewArtifact(payload.prompt)) {
    process.stdout.write(CONTRACT + '\n');
  }
  process.exit(0);
}

// House style (correction-nudge.js): runs unconditionally; tests spawn this
// file as a child process rather than importing it.
await main();
