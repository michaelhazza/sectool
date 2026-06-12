#!/usr/bin/env node
/**
 * PreToolUse hook: long-doc-guard
 *
 * Blocks `Write` calls to documentation files whose content exceeds
 * LONG_DOC_THRESHOLD characters. Large single-shot writes to long
 * documents can freeze Claude Code; this hook forces the
 * "skeleton first, append sections via Edit" workflow and requires
 * a TodoWrite task list so the user sees visible progress.
 *
 * Fails OPEN on parse or logic errors — a bug in this hook must
 * never block a legitimate write.
 *
 * Exit codes (per Claude Code hook contract):
 *   0 — allow the tool call
 *   2 — block the tool call; stderr is fed back to Claude as feedback
 */

const LONG_DOC_THRESHOLD = 10000;

// Files treated as "documentation" by extension.
const DOC_EXT_RE = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i;

// Extensionless doc filenames (README, LICENSE, etc.).
const DOC_BASENAME_RE =
  /^(README|CHANGELOG|CONTRIBUTING|LICENSE|NOTICE|NOTES|TODO|HISTORY|AUTHORS)$/i;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};

    if (payload.tool_name !== 'Write') {
      process.exit(0);
    }

    const filePath = (payload.tool_input && payload.tool_input.file_path) || '';
    const content = (payload.tool_input && payload.tool_input.content) || '';

    if (!isDocFile(filePath)) {
      process.exit(0);
    }

    if (content.length <= LONG_DOC_THRESHOLD) {
      process.exit(0);
    }

    const basename = filePath.split('/').pop() || filePath;
    const chars = content.length;
    const lines = content.split('\n').length;
    // Rough chunk sizing: aim for ~4KB per chunk, minimum 3 chunks.
    const suggestedChunks = Math.max(3, Math.ceil(chars / 4000));

    const message = [
      `BLOCKED by long-doc-guard: Write to "${basename}" is ${chars} chars / ${lines} lines,`,
      `over the ${LONG_DOC_THRESHOLD}-char long-document threshold.`,
      ``,
      `Large single-shot writes to documentation can freeze the session.`,
      `Use the chunked workflow instead:`,
      ``,
      `  1. Create a TodoWrite task list FIRST with one todo per chunk`,
      `     (roughly ${suggestedChunks} chunks for this doc). The user`,
      `     needs to SEE the phases move through, so the task list is`,
      `     MANDATORY — not optional.`,
      ``,
      `  2. Use Write ONCE to create the file with only the header,`,
      `     TOC, and section headings (skeleton only, well under the`,
      `     ${LONG_DOC_THRESHOLD}-char threshold).`,
      ``,
      `  3. For each chunk: mark its todo in_progress, use Edit to`,
      `     append that section's content, mark the todo completed,`,
      `     give the user a one-line summary, then move to the next.`,
      ``,
      `  4. Do NOT batch completions — update the task list one chunk`,
      `     at a time so the user sees live progress through the phases.`,
      ``,
      `See CLAUDE.md > "Long Document Writing" for the full workflow.`,
    ].join('\n');

    process.stderr.write(message + '\n');
    process.exit(2);
  } catch (err) {
    // Fail open: never block a legitimate write due to a hook bug.
    process.stderr.write(
      `long-doc-guard: internal error, allowing write: ${err && err.message}\n`,
    );
    process.exit(0);
  }
});

function isDocFile(filePath) {
  if (!filePath) return false;
  if (DOC_EXT_RE.test(filePath)) return true;
  const basename = filePath.split('/').pop() || '';
  return DOC_BASENAME_RE.test(basename);
}
