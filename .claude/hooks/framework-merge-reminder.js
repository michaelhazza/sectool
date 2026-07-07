#!/usr/bin/env node
/**
 * SessionStart hook: framework-merge-reminder
 *
 * After a framework sync, files the operator has locally diverged from are
 * written next to the original as `<name>.framework-new` instead of being
 * overwritten. Those pending merges are easy to forget; a stale
 * .framework-new silently drifts further from the local file with every
 * release.
 *
 * This hook scans the repo at session start (bounded depth, skipping .git,
 * node_modules, and the .claude-framework submodule) and prints ONE warning
 * line when any *.framework-new files exist, so the session starts with the
 * merge debt visible.
 *
 * Fails OPEN on any error — a scan bug must never block session start.
 * Always exits 0 (SessionStart hooks are advisory).
 *
 * Tests: .claude/hooks/framework-merge-reminder.test.js
 *   Run with: node .claude/hooks/framework-merge-reminder.test.js
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MAX_DEPTH = 6;
const MAX_LISTED = 3;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude-framework']);

function scan(dir, depth, relPrefix, found) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip, fail open
  }
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      scan(join(dir, entry.name), depth + 1, rel, found);
    } else if (entry.isFile() && entry.name.endsWith('.framework-new')) {
      found.push(rel);
    }
  }
}

try {
  const found = [];
  scan(PROJECT_DIR, 0, '', found);
  if (found.length > 0) {
    found.sort();
    const sample = found.slice(0, MAX_LISTED).join(', ');
    const more = found.length > MAX_LISTED ? `, +${found.length - MAX_LISTED} more` : '';
    process.stdout.write(
      `framework-merge-reminder: ${found.length} unmerged .framework-new file(s) pending ` +
        `(${sample}${more}) — run /claudemerge to review and merge them.\n`,
    );
  }
  process.exit(0);
} catch (err) {
  // Fail open: never block session start.
  process.stderr.write(
    `framework-merge-reminder: internal error, skipping scan: ${err && err.message}\n`,
  );
  process.exit(0);
}
