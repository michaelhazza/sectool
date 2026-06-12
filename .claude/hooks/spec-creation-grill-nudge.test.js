#!/usr/bin/env node
/**
 * Test suite for spec-creation-grill-nudge.js.
 *
 * Verifies the hook fires on spec-creation prompts and stays silent on
 * existing-spec maintenance, explicit coordinator invocation, explicit
 * skip-grill requests, and ambiguous prompts that don't mention spec.
 *
 * Run: node .claude/hooks/spec-creation-grill-nudge.test.js
 * Exit 0 on all pass, 1 on any fail.
 *
 * Not picked up by vitest (config scopes to **\/__tests__/**\/*.test.ts).
 * This file is a sanity script — re-run after any regex change to the hook.
 */

import { shouldFire } from "./spec-creation-grill-nudge.js";

// [prompt, expected: true = nudge fires, false = suppressed]
const CASES = [
  // --- Creation (should fire) ---
  ["create a spec for the auth flow", true],
  ["can you write a spec?", true],
  ["draft up a quick spec for me", true],
  ["please draft a new specification", true],
  ["spec out the caching layer", true],
  ["turn this into a spec", true],

  // --- Ambiguous verbs treated as creation (round 2 reviewer fix) ---
  ["update the spec to reflect the change", true],
  ["modify spec for the new architecture", true],
  ["update spec from this brief", true],
  ["edit spec and add a new subsystem", true],

  // --- Existing-spec maintenance (should suppress) ---
  ["review the spec at tasks/builds/x/spec.md", false],
  ["the spec says we should redirect", false],
  ["amend the existing spec to reflect the change", false],
  ["fix the spec typo", false],
  ["read the spec at docs/superpowers/specs/2026-05-18-foo-spec.md", false],
  ["check the spec for the auth flow", false],

  // --- Coordinator invocation (should suppress) ---
  ["launch spec-coordinator with this brief", false],

  // --- Explicit skip (should suppress) ---
  ["skip grill, just write the spec", false],

  // --- No spec word / unrelated (should not fire) ---
  ["fix this bug", false],
  ["write some code for the auth flow", false],
  ["lets write a test", false],
  ["create a new feature", false],
  ["explain how this works", false],

  // --- Edge cases ---
  ["", false],
  [null, false],
  [undefined, false],
];

let pass = 0;
const fails = [];
for (const [prompt, expected] of CASES) {
  const actual = shouldFire(prompt);
  if (actual === expected) {
    pass++;
  } else {
    fails.push({ prompt, expected, actual });
  }
}

console.log(`Cases: ${CASES.length}, passed: ${pass}, failed: ${fails.length}`);
if (fails.length) {
  for (const f of fails) {
    console.log(
      `FAIL fires=${f.actual} expected=${f.expected} | ${JSON.stringify(f.prompt)}`,
    );
  }
  process.exit(1);
}
process.exit(0);
