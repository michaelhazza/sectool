#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-no-orphan-react-component.sh
#
# Detects React component files that have zero ingress — not reachable via
# static or dynamic (lazy) imports from the app's routing entry file. A
# component that exists, compiles, and is tested but is never imported from a
# routed page is dead UI.
#
# Configuration (env vars, all optional):
#   ORPHAN_ENTRY_FILE      Routing entry file, repo-relative.
#                          Default: client/src/App.tsx, falling back to
#                          src/App.tsx. If neither default exists the gate
#                          prints a skip note and exits 0; if you SET this
#                          env var and the file is missing, the gate exits 1
#                          (fail closed on explicit misconfiguration).
#   ORPHAN_SOURCE_ROOT     Root walked for import resolution.
#                          Default: the entry file's directory.
#   ORPHAN_COMPONENT_DIRS  Space-separated dirs (repo-relative) whose files
#                          must be reachable. Default:
#                          "<source-root>/pages <source-root>/components".
#   ORPHAN_ALLOWLIST       JSON allowlist, shape:
#                          { "files": [{ "path": "<repo-relative>", "reason": "..." }] }
#                          Default: client/.orphan-allowlist.json (optional).
#
# Resolution covers: relative imports, dynamic `import('...')` (React.lazy),
# and tsconfig `compilerOptions.paths` aliases (root tsconfig.json plus the
# source root's tsconfig.json). Node stdlib only — no ts-morph.
#
# Exit codes: 0 = pass (or not applicable), 1 = orphans found / misconfigured
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="${ORPHAN_ROOT:-$(pwd)}"

ENTRY_EXPLICIT="${ORPHAN_ENTRY_FILE:-}"
if [ -n "$ENTRY_EXPLICIT" ]; then
  ENTRY_FILE="$ROOT_DIR/$ENTRY_EXPLICIT"
  if [ ! -f "$ENTRY_FILE" ]; then
    echo "[GATE] no-orphan-react-component: ORPHAN_ENTRY_FILE set to '$ENTRY_EXPLICIT' but the file does not exist — misconfigured gate" >&2
    exit 1
  fi
else
  if [ -f "$ROOT_DIR/client/src/App.tsx" ]; then
    ENTRY_FILE="$ROOT_DIR/client/src/App.tsx"
  elif [ -f "$ROOT_DIR/src/App.tsx" ]; then
    ENTRY_FILE="$ROOT_DIR/src/App.tsx"
  else
    echo "[GATE] no-orphan-react-component: no React routing entry found (client/src/App.tsx or src/App.tsx) — not applicable, skipping"
    exit 0
  fi
fi

SOURCE_ROOT="${ORPHAN_SOURCE_ROOT:-}"
if [ -z "$SOURCE_ROOT" ]; then
  SOURCE_ROOT_ABS="$(dirname "$ENTRY_FILE")"
else
  SOURCE_ROOT_ABS="$ROOT_DIR/$SOURCE_ROOT"
fi

COMPONENT_DIRS="${ORPHAN_COMPONENT_DIRS:-}"
ALLOWLIST_FILE="${ORPHAN_ALLOWLIST:-$ROOT_DIR/client/.orphan-allowlist.json}"

echo "--- verify-no-orphan-react-component ---"

RESULT=$(
  ROOT_DIR="$ROOT_DIR" \
  ENTRY_FILE="$ENTRY_FILE" \
  SOURCE_ROOT="$SOURCE_ROOT_ABS" \
  COMPONENT_DIRS="$COMPONENT_DIRS" \
  ALLOWLIST_FILE="$ALLOWLIST_FILE" \
  node --input-type=module <<'NODEEOF'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.ROOT_DIR);
const ENTRY = path.resolve(process.env.ENTRY_FILE);
const SOURCE_ROOT = path.resolve(process.env.SOURCE_ROOT);
const COMPONENT_DIRS = (process.env.COMPONENT_DIRS || '')
  .split(/\s+/).filter(Boolean).map((d) => path.resolve(ROOT, d));
if (COMPONENT_DIRS.length === 0) {
  COMPONENT_DIRS.push(path.join(SOURCE_ROOT, 'pages'), path.join(SOURCE_ROOT, 'components'));
}

const rel = (abs) => {
  let r = path.relative(ROOT, abs).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const isTest = (p) => /\/__tests__\//.test(p) || /\.(test|spec)\.tsx?$/.test(p);

// ---- walk source root ----
const knownFiles = new Set();
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) knownFiles.add(rel(full));
  }
}
walk(SOURCE_ROOT);

// ---- tsconfig aliases (JSONC-tolerant, best-effort) ----
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
}
const aliases = [];
for (const tc of [path.join(ROOT, 'tsconfig.json'), path.join(SOURCE_ROOT, 'tsconfig.json'), path.join(SOURCE_ROOT, '..', 'tsconfig.json')]) {
  if (!existsSync(tc)) continue;
  try {
    const parsed = JSON.parse(stripComments(readFileSync(tc, 'utf8')));
    const co = parsed?.compilerOptions ?? {};
    const baseUrl = path.resolve(path.dirname(tc), co.baseUrl ?? '.');
    for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const wildcard = pattern.endsWith('*');
      aliases.push({
        prefix: wildcard ? pattern.slice(0, -1) : pattern,
        wildcard,
        targets: targets.map((t) => path.resolve(baseUrl, wildcard && t.endsWith('*') ? t.slice(0, -1) : t)),
      });
    }
  } catch { /* skip unparseable tsconfig */ }
}

// ---- specifier resolution against the known-file set ----
function resolveSpec(spec, fileDir) {
  const bases = [];
  if (spec.startsWith('.')) bases.push(path.resolve(fileDir, spec));
  else {
    for (const a of aliases) {
      if (a.wildcard && spec.startsWith(a.prefix)) {
        for (const t of a.targets) bases.push(path.join(t, spec.slice(a.prefix.length)));
      } else if (!a.wildcard && spec === a.prefix) bases.push(...a.targets);
    }
  }
  for (const base of bases) {
    const swapped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx'), `${swapped}.ts`, `${swapped}.tsx`]) {
      const r = rel(c);
      if (knownFiles.has(r)) return r;
    }
  }
  return null;
}

const STATIC_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(relPath) {
  const abs = path.join(ROOT, relPath);
  let content;
  try { content = readFileSync(abs, 'utf8'); } catch { return []; }
  const out = new Set();
  let m;
  STATIC_RE.lastIndex = 0;
  while ((m = STATIC_RE.exec(content)) !== null) {
    const r = resolveSpec(m[1] ?? m[2], path.dirname(abs));
    if (r) out.add(r);
  }
  DYNAMIC_RE.lastIndex = 0;
  while ((m = DYNAMIC_RE.exec(content)) !== null) {
    const r = resolveSpec(m[1], path.dirname(abs));
    if (r) out.add(r);
  }
  return [...out];
}

// ---- BFS from entry ----
const reachable = new Set([rel(ENTRY)]);
const queue = [rel(ENTRY)];
while (queue.length > 0) {
  const current = queue.shift();
  for (const imp of importsOf(current)) {
    if (!reachable.has(imp)) { reachable.add(imp); queue.push(imp); }
  }
}

// ---- allowlist ----
const allowed = new Set();
const allowlistPath = process.env.ALLOWLIST_FILE;
if (allowlistPath && existsSync(allowlistPath)) {
  try {
    const j = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    for (const f of j?.files ?? []) {
      if (f?.path) allowed.add(process.platform === 'win32' ? String(f.path).toLowerCase() : String(f.path));
    }
  } catch (e) {
    process.stderr.write(`allowlist unparseable (${e.message}) — treating as empty\n`);
  }
}

// ---- flag unreachable component files ----
const violations = [];
let scanned = 0;
for (const compDir of COMPONENT_DIRS) {
  if (!existsSync(compDir) || !statSync(compDir).isDirectory()) continue;
  const compRelPrefix = rel(compDir) + '/';
  for (const f of knownFiles) {
    if (!f.startsWith(compRelPrefix)) continue;
    if (isTest(f)) continue;
    scanned++;
    if (reachable.has(f)) continue;
    // Reachable from any other reachable file counts too (already covered by
    // the BFS). Unreachable => orphan candidate.
    if (allowed.has(f)) continue;
    violations.push(f);
  }
}
violations.sort();
process.stdout.write(JSON.stringify({ scanned, violations }) + '\n');
NODEEOF
) || {
  echo "[GATE] no-orphan-react-component: analyser failed" >&2
  exit 1
}

SCANNED=$(echo "$RESULT" | sed -E 's/.*"scanned":([0-9]+).*/\1/')
VIOLATION_LIST=$(echo "$RESULT" | node -e '
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const j = JSON.parse(input);
  for (const v of j.violations) process.stdout.write(v + "\n");
});
')

VIOLATIONS=0
if [ -n "$VIOLATION_LIST" ]; then
  while IFS= read -r vfile; do
    [ -z "$vfile" ] && continue
    echo "  [FAIL] $vfile: no import path from the routing entry (orphan component)"
    echo "         Import it from a routed page, add it to the allowlist ($ALLOWLIST_FILE) with a reason, or delete it."
    VIOLATIONS=$((VIOLATIONS + 1))
  done <<< "$VIOLATION_LIST"
fi

echo "[GATE] no-orphan-react-component: scanned=$SCANNED violations=$VIOLATIONS"

if [ "$VIOLATIONS" -gt 0 ]; then
  exit 1
fi
exit 0
