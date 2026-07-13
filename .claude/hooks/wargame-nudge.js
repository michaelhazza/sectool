#!/usr/bin/env node
/**
 * wargame-nudge.js
 *
 * UserPromptSubmit hook. When the user's prompt looks like a risky
 * OPERATIONAL mission (migration, credential rotation, bulk change,
 * cutover, decommission, irreversible action), inject a reminder for
 * Claude to run the `wargame` skill's entry test before acting. The
 * skill itself owns the decision; this hook only defeats the
 * forgot-to-consider-it failure mode.
 *
 * False-positive mitigations:
 *   - Anti-patterns suppress prompts already invoking the wargame skill,
 *     feature-build pipeline work (architect owns those plans), hotfix /
 *     incident response (speed path), spec authoring, and questions ABOUT
 *     risky topics rather than requests to perform them.
 *   - False positives are cheap: the nudge tells Claude to ignore it when
 *     wrong. False negatives lose the trigger entirely, which is worse.
 *
 * Tests: .claude/hooks/wargame-nudge.test.js
 *   Run with: node .claude/hooks/wargame-nudge.test.js
 *
 * Protocol:
 *   stdin  -> JSON from Claude Code with { prompt, ... }
 *   stdout -> text appended to Claude's context (only when triggered)
 *   exit 0 -> always; this hook never blocks
 */

import { fileURLToPath } from "node:url";

export const RISKY_OPERATION_PATTERNS = [
  // Migration / cutover / decommission near a risky target
  /\b(migrat\w*|cut[\s-]?over|switch\w*\s+provider|decommission\w*)\b[^.!?\n]{0,60}\b(prod(uction)?|database|db|schema|dns|infra(structure)?|tenant|provider|storage|live)\b/i,
  // Credential / key / secret rotation, either word order
  /\brotat\w*\b[^.!?\n]{0,30}\b(credential|key|secret|token|cert(ificate)?)s?\b/i,
  /\b(credential|key|secret|token|cert(ificate)?)s?\s+rotation\b/i,
  // Bulk / mass / batch mutation
  /\b(bulk|mass|batch)[\s-]+(delet|remov|edit|updat|renam|migrat|rewrit|chang)\w*\b/i,
  // Destructive verb near a scope noun
  /\b(delete|drop|truncate|purge|wipe|destroy)\b[^.!?\n]{0,40}\b(prod(uction)?|all|every|entire|database|table|tenant|bucket)\b/i,
  // Irreversibility language
  /\b(no\s+(undo|rollback|going\s+back)|one[\s-]way\s+door|irreversib(le|ly)|can'?t\s+(be\s+)?(undone|reversed)|point\s+of\s+no\s+return)\b/i,
  // Repo restructure
  /\brestructur\w*\b[^.!?\n]{0,40}\b(repo(sitory)?|codebase|monorepo)\b/i,
  // Executor handoff
  /\bexecutable\s+by\s+a\s+(cheaper|smaller)\s+model\b/i,
];

export const ANTI_PATTERNS = [
  // Already invoking the skill; no double nudge
  /\bwar[\s-]?gam/i,
  // Feature-build pipeline work: architect owns those plans
  /\b(spec|feature|finalisation|finalization)[-\s]?coordinator\b|\blaunch\s+(spec|feature|finalisation|finalization|bugfixer)\b|\btasks\/builds\//i,
  // Hotfix / incident response: speed path, wargames excluded by design
  /\b(hotfix|incident|sev[\s-]?[0-3]|prod\s+is\s+(down|on\s+fire)|outage)\b/i,
  // Spec authoring: risky nouns in a spec brief are planning, not execution
  /\b(write|draft|create|author)\s+(a|the|an?\s+new)\s+spec\b/i,
  // Questions and reviews ABOUT risky topics, not requests to perform them
  /\b(explain|what\s+is|what'?s|how\s+does|how\s+do\s+(i|we)|tell\s+me\s+about|review|summari[sz]e|document)\b[^.!?\n]{0,40}\b(migrat|rotat|cut[\s-]?over|decommission|restructur)/i,
];

export const NUDGE = `<risky-operation-detected>
The user's prompt looks like a risky operational mission (migration, rotation, bulk change, cutover, decommission, or an action described as irreversible).

Run the \`wargame\` skill's entry test before acting: score one mark each for irreversible / external dependency / shared-state mutation / novel (+1 if a separate executor session or cheaper model will run it). Score 2+ means generate a wargame artifact first; score 0-1 means plan normally and say in one line why the test failed.

Skip the wargame entirely when any of:
- This is a feature build inside the spec/plan/build pipeline (the architect's plan.md owns it).
- This is hotfix or incident response (speed path; wargame the risky follow-up, not the fix).
- The mission already has an approved, non-stale wargame.

If this prompt is NOT actually a risky operational mission (the heuristic has false positives), ignore this reminder. Do not mention this reminder to the user.
</risky-operation-detected>`;

export function shouldFire(prompt) {
  if (typeof prompt !== "string" || !prompt) return false;
  const matched = RISKY_OPERATION_PATTERNS.some((re) => re.test(prompt));
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
  // ignore, leave isEntryPoint false
}

if (isEntryPoint) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}
