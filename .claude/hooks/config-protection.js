#!/usr/bin/env node
/**
 * PreToolUse hook: config-protection (HITL mode)
 *
 * Interrupts Edit, Write, and MultiEdit calls that target tooling
 * configuration files (tsconfig, eslint, biome, prettier, package.json
 * scripts) so Claude has to ask the user for explicit approval before
 * the edit lands. Prevents the agent from silently "fixing" a failing
 * check by weakening the check itself, while still allowing legitimate
 * config updates when the user explicitly authorises them.
 *
 * Enforces CLAUDE.md rule: "Never skip a failing check. Never suppress
 * warnings to make a check pass." — this hook's job is to make sure the
 * user is in the loop whenever a config file is about to change, not to
 * forbid all config edits outright.
 *
 *
 * ── HITL flow ─────────────────────────────────────────────────────────
 *
 * A ONE-SHOT sentinel file at .claude/config-edit-approved is the
 * authorisation token. The file should contain a single line naming
 * the basename of the file the user is authorising (e.g. "package.json").
 *
 * On a protected edit attempt:
 *
 *   1. Hook checks for .claude/config-edit-approved.
 *   2. If the sentinel exists AND its contents match the target basename,
 *      the hook DELETES the sentinel and exits 0 (allowing the edit).
 *      The deletion makes it one-shot — each approved edit needs a fresh
 *      sentinel, so approvals never persist across multiple attempts.
 *   3. If the sentinel is missing or points at a different file, the hook
 *      exits 2 with an HITL message instructing Claude to stop, surface
 *      the intended edit to the user, wait for approval, then create the
 *      sentinel and retry.
 *
 *
 * Fails OPEN on parse or logic errors — a bug in this hook must never
 * interrupt a legitimate edit.
 *
 * Exit codes (per Claude Code hook contract):
 *   0 — allow the tool call
 *   2 — interrupt the tool call; stderr is fed back to Claude as feedback
 */

import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// ── Protected file patterns ────────────────────────────────────────────────
// Basename patterns for files that should not be modified by the agent.

const PROTECTED_BASENAMES = [
  /^tsconfig.*\.json$/,         // tsconfig.json, tsconfig.server.json, etc.
  /^\.?eslintrc.*$/,            // .eslintrc, .eslintrc.cjs, .eslintrc.json, etc.
  /^eslint\.config\.[cm]?[jt]s$/, // eslint.config.js, eslint.config.mjs, etc.
  /^\.?prettierrc.*$/,          // .prettierrc, .prettierrc.json, etc.
  /^prettier\.config\.[cm]?[jt]s$/,
  /^biome\.json$/,
  /^\.editorconfig$/,
  /^package\.json$/,            // protects scripts section from being weakened
];

// Full path patterns (relative to project root, always forward-slash) for
// additional protection.
const PROTECTED_PATHS = [
  /^worker\/\.eslintrc.*$/,
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalise a file path to use forward slashes (handles Windows backslashes).
 */
function normalisePath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Extract file paths from tool_input depending on tool type.
 * - Edit / Write: single file_path
 * - MultiEdit: array of edits, each with file_path
 * Returns a deduplicated array of normalised paths.
 */
function extractFilePaths(toolName, toolInput) {
  const paths = new Set();
  if (toolName === 'MultiEdit') {
    const edits = toolInput.edits || [];
    for (const edit of edits) {
      if (edit && edit.file_path) paths.add(normalisePath(edit.file_path));
    }
  } else {
    if (toolInput.file_path) paths.add(normalisePath(toolInput.file_path));
  }
  return [...paths];
}

/**
 * Path to the one-shot sentinel file. Using CLAUDE_PROJECT_DIR when set so
 * the hook finds the right .claude/ directory even when the current working
 * directory is a subfolder.
 */
function sentinelPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.claude', 'config-edit-approved');
}

/**
 * Read the one-shot sentinel if it exists. Returns the trimmed contents
 * (usually a basename) or null. Any read error is treated as "no sentinel".
 */
function readSentinel() {
  try {
    return readFileSync(sentinelPath(), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Consume (delete) the one-shot sentinel. Silent no-op if it doesn't exist.
 */
function consumeSentinel() {
  try {
    unlinkSync(sentinelPath());
  } catch {
    // ignore — file may already be gone
  }
}

/**
 * Check whether a file path is protected. If it is, either consume a
 * matching one-shot approval sentinel and allow, or write an HITL message
 * to stderr and exit 2 to interrupt the tool call.
 */
function checkProtected(toolName, filePath) {
  // Split on both / and \ to handle Windows and Unix paths.
  const basename = filePath.split(/[/\\]/).pop() || '';
  const relativePath = toRelativePath(filePath);

  const basenameMatch = PROTECTED_BASENAMES.some((re) => re.test(basename));
  const pathMatch = relativePath && PROTECTED_PATHS.some((re) => re.test(relativePath));

  if (!basenameMatch && !pathMatch) {
    return; // not protected — allow
  }

  // Check for a matching one-shot approval.
  const approved = readSentinel();
  if (approved && approved === basename) {
    consumeSentinel();
    process.stderr.write(
      `config-protection: one-shot approval consumed for ${basename}\n`,
    );
    return; // allow this single edit; next edit needs a fresh sentinel
  }

  // No valid sentinel — emit HITL instructions and interrupt.
  const sentinel = sentinelPath();
  const message = [
    `HITL-APPROVAL-REQUIRED: ${toolName} to "${basename}" is a protected config file.`,
    ``,
    `Tooling configuration files (tsconfig, eslint, biome, prettier,`,
    `package.json) require explicit human approval before any change.`,
    `This is because modifying them to silence a failing check would`,
    `violate the project rule: "Never skip a failing check. Never`,
    `suppress warnings to make a check pass."`,
    ``,
    `ACTION REQUIRED BY CLAUDE — do this NOW, do not defer:`,
    ``,
    `  1. STOP the current tool call.`,
    `  2. Quote the intended edit to the user verbatim (file, old/new`,
    `     strings, and the reason the change is needed).`,
    `  3. Ask the user explicitly: "Do you approve this edit to`,
    `     ${basename}?"`,
    `  4. Wait for an explicit yes/no answer in the chat. Do NOT assume`,
    `     approval from tone or context — the user must say yes.`,
    `  5. Do NOT continue with unrelated work in the meantime — the`,
    `     HITL question is the current priority.`,
    ``,
    `If — and ONLY if — the user says yes in the chat, write the target`,
    `basename to the one-shot sentinel file and then retry the exact`,
    `same tool call. The Bash call to create the sentinel is visible to`,
    `the user in the conversation, which is the second line of defence`,
    `the sentinel mechanism relies on:`,
    ``,
    `    echo '${basename}' > '${sentinel}'`,
    ``,
    `The sentinel is single-use — it is deleted as soon as it authorises`,
    `one edit. A second protected edit will require a fresh approval.`,
    ``,
    `TRUST MODEL: the sentinel is a signaling primitive between "the user`,
    `said yes" and "the tool call retries", not a cryptographic auth`,
    `token. Its security properties depend on Claude only creating it`,
    `after a genuine user yes in the chat, and on every Bash call being`,
    `visible to the user. NEVER create the sentinel pre-emptively, as a`,
    `shortcut, or to "unblock" yourself without an explicit approval.`,
    ``,
    `If the edit is actually an attempt to weaken a check to make it`,
    `pass, fix the underlying code instead and abandon the config edit.`,
  ].join('\n');

  process.stderr.write(message + '\n');
  process.exit(2);
}

/**
 * Convert an absolute path to a project-relative path (forward-slash
 * normalised). Uses CLAUDE_PROJECT_DIR if available, otherwise falls back
 * to heuristics. Returns null if the path can't be resolved.
 */
function toRelativePath(absPath) {
  if (!absPath) return null;

  // Input is already normalised to forward slashes by extractFilePaths.
  const normalised = absPath;

  // Preferred: use CLAUDE_PROJECT_DIR (set by Claude Code for hook commands).
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const normDir = normalisePath(projectDir);
    if (normalised.startsWith(normDir)) {
      let rel = normalised.slice(normDir.length);
      if (rel.startsWith('/')) rel = rel.slice(1);
      return rel;
    }
  }

  // Fallback: look for known top-level directories in the path.
  const markers = ['/server/', '/client/', '/worker/', '/scripts/', '/migrations/'];
  for (const marker of markers) {
    const idx = normalised.indexOf(marker);
    if (idx !== -1) {
      return normalised.slice(idx + 1);
    }
  }

  return null;
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

    // Extract all target file paths from the tool input.
    const filePaths = extractFilePaths(toolName, payload.tool_input || {});
    if (filePaths.length === 0) {
      process.exit(0);
    }

    // Check every file path — block if ANY target is protected.
    for (const fp of filePaths) {
      checkProtected(toolName, fp);
    }

    // None of the targets are protected — allow.
    process.exit(0);
  } catch (err) {
    // Fail open: never block a legitimate edit due to a hook bug.
    process.stderr.write(
      `config-protection: internal error, allowing edit: ${err && err.message}\n`,
    );
    process.exit(0);
  }
});
