#!/usr/bin/env node
/**
 * Test suite for wargame-nudge.js.
 *
 * Verifies the hook fires on risky operational missions and stays silent
 * on feature-pipeline work, hotfix/incident prompts, spec authoring,
 * questions about risky topics, explicit wargame invocations, and
 * unrelated prompts.
 *
 * Run: node .claude/hooks/wargame-nudge.test.js
 * Exit 0 on all pass, 1 on any fail.
 *
 * Not picked up by vitest (config scopes to **\/__tests__/**\/*.test.ts).
 * This file is a sanity script; re-run after any regex change to the hook.
 */

import { shouldFire } from "./wargame-nudge.js";

// [prompt, expected: true = nudge fires, false = suppressed]
const CASES = [
  // --- Risky operations (should fire) ---
  ["migrate the production database to the new provider", true],
  ["let's migrate all tenant data into the new schema", true],
  ["rotate the API keys for every environment", true],
  ["we need a key rotation across all services", true],
  ["bulk delete the orphaned records from the tenants table", true],
  ["mass update every workflow config", true],
  ["drop the legacy users table in prod", true],
  ["wipe all test tenants from the database", true],
  ["this deploy is a one-way door, no rollback", true],
  ["careful, this change is irreversible", true],
  ["restructure the repo into a monorepo layout", true],
  ["cut over to the new DNS provider this weekend", true],
  ["decommission the old storage provider", true],
  ["make this plan executable by a cheaper model", true],

  // --- Already invoking the skill (should suppress) ---
  ["wargame the neon migration before we run it", false],
  ["build a war game for the provider cutover", false],

  // --- Feature-pipeline work (should suppress) ---
  ["launch feature-coordinator for the bulk edit feature", false],
  ["spec-coordinator: tenant data migration tooling", false],
  ["review tasks/builds/data-migration/spec.md before we migrate the database", false],

  // --- Hotfix / incident (should suppress) ---
  ["hotfix: the migration broke prod login", false],
  ["prod is down after the database migration, help", false],

  // --- Spec authoring (should suppress) ---
  ["write a spec for bulk editing tags across tenants", false],

  // --- Questions about risky topics (should suppress) ---
  ["explain how the migration system works", false],
  ["what is key rotation and why does it matter", false],
  ["how does the provider cutover process work?", false],
  ["review the migration in the PR and tell me if it's safe", false],

  // --- Unrelated (should not fire) ---
  ["fix this bug in the date parser", false],
  ["add a loading state to the tasks page", false],
  ["update the README with the new setup steps", false],
];

let failures = 0;
for (const [prompt, expected] of CASES) {
  const actual = shouldFire(prompt);
  if (actual !== expected) {
    failures += 1;
    console.error(
      `FAIL: expected ${expected} got ${actual} for prompt: "${prompt}"`
    );
  }
}

if (failures > 0) {
  console.error(`${failures}/${CASES.length} cases failed`);
  process.exit(1);
}
console.log(`All ${CASES.length} cases passed`);
process.exit(0);
