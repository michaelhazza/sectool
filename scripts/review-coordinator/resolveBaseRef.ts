/**
 * resolveBaseRef.ts
 *
 * I/O helper — resolves the repo's default base ref per F9 R1.
 *
 * Resolution order:
 *   1. git symbolic-ref --short refs/remotes/origin/HEAD
 *   2. git rev-parse --abbrev-ref --symbolic-full-name @{upstream}
 *   3. Fallback to 'origin/main' (logs a stderr warning)
 *
 * Logs to stderr which level was used so the operator can see when
 * the heuristic kicks in.
 */

import { execSync } from 'node:child_process';

/**
 * Run a git command and return stdout trimmed, or null on failure.
 */
function tryGit(args: string): string | null {
  try {
    return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the repo's default base ref.
 *
 * @returns The resolved base ref string (e.g. 'origin/main', 'origin/master')
 */
export function resolveBaseRef(): string {
  // Level 1: symbolic-ref for origin/HEAD
  const symbolicRef = tryGit('symbolic-ref --short refs/remotes/origin/HEAD');
  if (symbolicRef && symbolicRef.length > 0) {
    process.stderr.write(`[resolveBaseRef] resolved via origin/HEAD: ${symbolicRef}\n`);
    return symbolicRef;
  }

  // Level 2: upstream branch of current HEAD
  const upstream = tryGit('rev-parse --abbrev-ref --symbolic-full-name @{upstream}');
  if (upstream && upstream.length > 0) {
    process.stderr.write(`[resolveBaseRef] resolved via @{upstream}: ${upstream}\n`);
    return upstream;
  }

  // Level 3: fallback
  process.stderr.write(
    '[resolveBaseRef] WARNING: could not determine base ref via origin/HEAD or @{upstream}; falling back to origin/main\n',
  );
  return 'origin/main';
}
