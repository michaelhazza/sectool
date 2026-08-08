#!/usr/bin/env node
/**
 * PreToolUse hook: path-portability-guard
 *
 * Blocks `Write` calls whose target path cannot be checked out on Windows.
 * A single bad filename breaks `git pull` for every Windows clone of the
 * repo — this happened on 2026-08-01 when a review log was written from a
 * Linux session with colons in its ISO timestamp
 * (dual-review-log-...-2026-08-01T21:14:58Z.md), blocking all Windows pulls
 * until the file was renamed via index plumbing.
 *
 * Enforced per path component (after stripping the OS-specific absolute
 * prefix — drive letter or UNC root — and normalising separators):
 *   1. invalid characters:  < > : " | ? * backslash, control chars
 *   2. trailing dot or space
 *   3. reserved device names: CON PRN AUX NUL COM1-9 LPT1-9 (any extension)
 *
 * Timestamps in filenames use hyphens between time fields
 * (2026-08-01T21-14-58Z), never colons.
 *
 * CI backstop for paths created outside Write (e.g. bash redirects):
 * scripts/gates/verify-portable-paths.sh
 *
 * Fails OPEN on parse or logic errors — a bug in this hook must never
 * block a legitimate write.
 *
 * Exit codes (per Claude Code hook contract):
 *   0 — allow the tool call
 *   2 — block the tool call; stderr is fed back to Claude as feedback
 */

const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Backslashes are normalised to "/" before this runs, and the drive prefix
// ("C:") is stripped — so any remaining colon is a genuine violation.
// eslint-disable-next-line no-control-regex -- control chars are the Windows-invalid filename range being detected
const INVALID_CHARS_RE = /[<>:"|?*\\\u0000-\u001f]/;

function violations(rawPath) {
  let p = String(rawPath).replace(/\\/g, '/');
  p = p.replace(/^\/\/[?.]\//, ''); // \\?\ and \\.\ long-path prefixes
  p = p.replace(/^[A-Za-z]:(?=\/|$)/, ''); // drive letter
  p = p.replace(/^\/\/[^/]+\/[^/]+/, ''); // UNC \\server\share root

  const found = [];
  for (const component of p.split('/')) {
    if (component === '' || component === '.' || component === '..') continue;
    if (INVALID_CHARS_RE.test(component)) {
      found.push(`"${component}" contains a character invalid on Windows (< > : " | ? * \\ or control chars)`);
    }
    if (/[. ]$/.test(component)) {
      found.push(`"${component}" ends with a dot or space (invalid on Windows)`);
    }
    if (RESERVED_RE.test(component)) {
      found.push(`"${component}" is a reserved Windows device name`);
    }
  }
  return found;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw);
    if (payload.tool_name !== 'Write') process.exit(0);
    const filePath = payload.tool_input && payload.tool_input.file_path;
    if (!filePath) process.exit(0);

    const found = violations(filePath);
    if (found.length === 0) process.exit(0);

    process.stderr.write(
      `path-portability-guard: BLOCKED — "${filePath}" cannot be checked out on Windows.\n` +
        found.map((v) => `  - ${v}`).join('\n') +
        '\nFix the filename before writing. Timestamps in filenames use hyphens between time fields ' +
        '(e.g. 2026-08-01T21-14-58Z, shell: date -u +%Y-%m-%dT%H-%M-%SZ), never colons.\n',
    );
    process.exit(2);
  } catch {
    process.exit(0); // fail open
  }
});
