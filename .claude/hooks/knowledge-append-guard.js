#!/usr/bin/env node
/**
 * PreToolUse hook: knowledge-append-guard (HITL mode)
 *
 * Enforces the CLAUDE.md §3 rule for KNOWLEDGE.md: "Never edit or remove
 * existing entries — only append new ones." Guards Edit, Write, and
 * MultiEdit calls that target a file named KNOWLEDGE.md.
 *
 * Allowed without approval (pure appends ONLY):
 *   - Edit whose old_string is empty-ish (empty / whitespace-only)
 *   - Edit whose old_string matches the TAIL of the current file AND whose
 *     new_string starts with that old_string (anchor-on-tail append)
 *   - Write whose new content starts with the existing content (append via
 *     full rewrite), or Write to a not-yet-existing KNOWLEDGE.md
 *
 * Blocked (exit 2, HITL): EVERYTHING else. Any Edit/MultiEdit that is not a
 * pure tail append — including "typo fixes" and deletions inside an existing
 * entry's body — rewrites history and requires explicit approval. Whether
 * the old_string spans a dated `### [` heading is irrelevant: a body-line
 * rewrite is still a rewrite.
 *
 * ── HITL override ─────────────────────────────────────────────────────
 * Mirrors config-protection.js: a ONE-SHOT sentinel file at
 * .claude/knowledge-edit-approved containing the target's repo-relative
 * path (e.g. "KNOWLEDGE.md") authorises exactly one blocked edit, then is
 * deleted. Only create it after an explicit user yes in the chat.
 *
 * Fails OPEN on parse or logic errors — a bug in this hook must never
 * block a legitimate edit.
 *
 * Exit codes (per Claude Code hook contract):
 *   0 — allow the tool call
 *   2 — interrupt the tool call; stderr is fed back to Claude as feedback
 *
 * Tests: .claude/hooks/knowledge-append-guard.test.js
 *   Run with: node .claude/hooks/knowledge-append-guard.test.js
 */

import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// ── Helpers ────────────────────────────────────────────────────────────────

function normalisePath(p) {
  return String(p).replace(/\\/g, '/');
}

function isKnowledgeFile(filePath) {
  const basename = normalisePath(filePath).split('/').pop() || '';
  return basename === 'KNOWLEDGE.md';
}

/** Read the current content of the target file; null when unreadable/absent. */
function readTarget(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** True when the edit is a pure append against the given file content. */
function isPureAppendEdit(fileContent, oldString, newString) {
  const old = String(oldString ?? '');
  if (old.trim() === '') return true; // empty-ish anchor — appending
  if (typeof newString !== 'string' || !newString.startsWith(old)) return false;
  if (fileContent === null) return true; // can't read the file — fail open
  // Anchor must sit at the tail (modulo trailing whitespace) so nothing
  // after it is rewritten.
  return fileContent.trimEnd().endsWith(old.trimEnd());
}

/** Classify one Edit-style change: 'allow' | 'block'. */
function classifyEdit(fileContent, oldString, newString) {
  // Append-only means append-only: anything that is not a pure tail append
  // rewrites existing content and needs HITL — body edits included.
  return isPureAppendEdit(fileContent, oldString, newString) ? 'allow' : 'block';
}

/** Classify a Write: 'allow' | 'block'. */
function classifyWrite(fileContent, content) {
  if (fileContent === null) return 'allow'; // new file (or unreadable — fail open)
  if (typeof content !== 'string') return 'allow'; // malformed — fail open
  // Allowed only if the new content starts with the existing content
  // (existing history preserved verbatim; trailing whitespace tolerated).
  const existing = fileContent.trimEnd();
  if (existing === '') return 'allow';
  return content.trimEnd().startsWith(existing) ? 'allow' : 'block';
}

// ── HITL sentinel (mirrors config-protection.js, separate sentinel file) ───

function sentinelPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.claude', 'knowledge-edit-approved');
}

function readSentinel() {
  try {
    return readFileSync(sentinelPath(), 'utf8').trim();
  } catch {
    return null;
  }
}

function consumeSentinel() {
  try {
    unlinkSync(sentinelPath());
  } catch {
    // ignore — file may already be gone
  }
}

/** Repo-relative-ish key the sentinel binds to. */
function sentinelKey(filePath) {
  const normalised = normalisePath(filePath);
  const projectDir = normalisePath(process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\/$/, '');
  if (normalised.startsWith(projectDir + '/')) return normalised.slice(projectDir.length + 1);
  return normalised;
}

function blockWithHitl(toolName, filePath) {
  const key = sentinelKey(filePath);

  const approved = readSentinel();
  if (approved && approved === key) {
    consumeSentinel();
    process.stderr.write(
      `knowledge-append-guard: one-shot approval consumed for ${key}\n`,
    );
    return; // allow this single edit
  }

  const sentinel = sentinelPath();
  const message = [
    `HITL-APPROVAL-REQUIRED: ${toolName} to "${key}" rewrites existing KNOWLEDGE.md history.`,
    ``,
    `KNOWLEDGE.md is append-only (CLAUDE.md §3): "Never edit or remove`,
    `existing entries — only append new ones." This change modifies`,
    `existing content (heading or body) instead of appending after it.`,
    ``,
    `If you meant to ADD an entry: append it at the end of the file`,
    `(anchor your edit on the current tail, or use an empty old_string`,
    `insertion) and this guard will not trigger.`,
    ``,
    `If the history genuinely must change (e.g. redacting a secret):`,
    ``,
    `  1. STOP the current tool call.`,
    `  2. Quote the intended change to the user verbatim and explain why`,
    `     rewriting history is needed.`,
    `  3. Ask the user explicitly: "Do you approve this edit to ${key}?"`,
    `  4. Wait for an explicit yes/no answer in the chat. Do NOT assume`,
    `     approval from tone or context — the user must say yes.`,
    ``,
    `If — and ONLY if — the user says yes in the chat, write the target's`,
    `repo-relative path to the one-shot sentinel file and retry the exact`,
    `same tool call:`,
    ``,
    `    echo '${key}' > '${sentinel}'`,
    ``,
    `The sentinel is single-use — it is deleted as soon as it authorises`,
    `one edit. NEVER create it pre-emptively or without an explicit user`,
    `approval in the chat.`,
  ].join('\n');

  process.stderr.write(message + '\n');
  process.exit(2);
}

// ── Main ───────────────────────────────────────────────────────────────────

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};

    const toolName = payload.tool_name || '';
    if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
      process.exit(0);
    }

    const toolInput = payload.tool_input || {};
    const filePath = toolInput.file_path ? String(toolInput.file_path) : '';
    if (!filePath || !isKnowledgeFile(filePath)) {
      process.exit(0);
    }

    const fileContent = readTarget(filePath);

    if (toolName === 'Write') {
      if (classifyWrite(fileContent, toolInput.content) === 'block') {
        blockWithHitl(toolName, filePath);
      }
      process.exit(0);
    }

    // Edit / MultiEdit
    const edits =
      toolName === 'MultiEdit' && Array.isArray(toolInput.edits)
        ? toolInput.edits
        : [{ old_string: toolInput.old_string, new_string: toolInput.new_string }];

    for (const edit of edits) {
      if (!edit) continue;
      if (classifyEdit(fileContent, edit.old_string, edit.new_string) === 'block') {
        blockWithHitl(toolName, filePath);
        break; // sentinel consumed — one approval covers this call
      }
    }

    process.exit(0);
  } catch (err) {
    // Fail open: never block a legitimate edit due to a hook bug.
    process.stderr.write(
      `knowledge-append-guard: internal error, allowing edit: ${err && err.message}\n`,
    );
    process.exit(0);
  }
});
