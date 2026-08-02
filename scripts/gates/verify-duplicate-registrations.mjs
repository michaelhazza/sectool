#!/usr/bin/env node
// Duplicate registration gate (generalised from the consumer-repo audit-
// prevention gate `verify-duplicate-route-registrations.mjs`, 2026-07-28;
// ported into this library unchanged in mechanics, generalised in
// configuration).
//
// Bug class: a downstream registry keyed by method+path (an Express-shaped
// router is the common case) accepts duplicate registrations silently — the
// first mounted match serves the request and every later one becomes dead
// code that still looks live in source. Mount ORDER is a separate,
// already-tested concern; duplicate CLAIMS on the same key have no detector
// without this gate.
//
// Mechanics (AST via the TypeScript compiler API — not a substring scan):
//   1. Collect every `<recv>.<method>('<literal>')` call in GATE_SCAN_DIR
//      (plus, when the default scan dir is in effect, the library's known
//      extra entry file `server/index.ts`) whose first argument is a string
//      literal starting with '/'. GATE_METHOD_SET controls which method
//      names are tracked.
//   2. Normalize paths (`:anyParamName` -> `:param`, trailing slash
//      stripped) and group by method + normalized path.
//   3. Flag a group as duplicate when it has >1 member AND either
//        - the path starts with '/api/' (flat-mount convention: full paths,
//          comparable across files), or
//        - all members are in the SAME file (unambiguous whatever the mount).
//      Relative paths across DIFFERENT files are excluded by design: routers
//      mounted under different prefixes legitimately reuse relative paths.
//
// Known blind spots (deliberate — precision over recall, do not "tighten"):
//   - paths built from template literals or variables;
//   - a `.all()` registration shadowing a sibling `.get()` (cross-method);
//   - relative-path duplicates across files under the SAME mount prefix;
//   - `.use()`-level shadowing.
//
// Configuration (env vars, all optional):
//   GATE_SCAN_DIR     Dir to scan for registrations. Default: server/routes,
//                     plus server/index.ts (ported from the origin gate)
//                     when the default is in effect. An explicit override
//                     scans only that dir, recursively, no extra file.
//                     Missing dir (default or override) is a
//                     misconfiguration — fail closed, exit 1.
//   GATE_METHOD_SET   Comma-separated registration method names. Default:
//                     get,post,put,patch,delete,all.
//   VERIFY_DUPLICATE_REGISTRATIONS_EXIT=1   Promotes findings from warning
//                     (exit 2, default) to blocking (exit 1). Warning-first
//                     is the soak mechanism; flipping this is a per-gate
//                     operator decision made after the soak window, not a
//                     new mechanism.
//
// Suppression (house grammar, guard-id: duplicate-registrations):
//   same-line:  // guard-ignore: duplicate-registrations reason="..."
//   next-line:  // guard-ignore-next-line: duplicate-registrations reason="..."
//   file-wide:  // guard-ignore-file: duplicate-registrations reason="..." (first line)
//
// `typescript` is resolved dynamically (not a static top-level import) from
// the CONSUMING repo's node_modules at runtime — same loadTypeScript() shape
// as verify-factory-invocation.mjs: an unresolvable dependency must produce
// a legible one-line message naming it, not a raw module-not-found stack
// trace.
//
// Exit codes: 0 clean; 2 violations (warning-first, see
// VERIFY_DUPLICATE_REGISTRATIONS_EXIT above); 1 on internal/tool error,
// misconfiguration, or an unresolvable `typescript` (fail-closed — never
// exit 0 on an error path).
//
// Fixture self-test: scripts/gates/fixtures/verify-duplicate-registrations/
//   GATE_SCAN_DIR points the gate at the fixture tree.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GATE_ID = 'duplicate-registrations';
const SCAN_REL_DIR_DEFAULT = 'server/routes';
const SCAN_EXTRA_FILES_DEFAULT = ['server/index.ts'];
const METHOD_SET_DEFAULT = ['get', 'post', 'put', 'patch', 'delete', 'all'];
const VIOLATION_EXIT = process.env.VERIFY_DUPLICATE_REGISTRATIONS_EXIT === '1' ? 1 : 2;
const REGISTRATION_METHODS = new Set(
  (process.env.GATE_METHOD_SET ? process.env.GATE_METHOD_SET.split(',') : METHOD_SET_DEFAULT)
    .map((m) => m.trim())
    .filter(Boolean)
);
// See the sibling gate: an empty method set makes every AST walk match
// nothing. This gate survives it only incidentally, via the unrelated
// zero-registrations tripwire; make the real cause explicit and fail closed.
if (REGISTRATION_METHODS.size === 0) {
  console.error(`[FAIL] ${GATE_ID}: GATE_METHOD_SET resolved to an empty method set — misconfiguration, fail closed`);
  process.exit(1);
}
// See the sibling gate: a narrowed method set passes the zero-match tripwire
// while ignoring violations under the omitted methods. Under CI the set must be
// exactly canonical unless fixture mode is declared (external review round 2).
if (process.env.CI === 'true' && process.env.GATE_METHOD_SET && process.env.GATE_FIXTURE_MODE !== '1') {
  const requested = [...REGISTRATION_METHODS].sort().join(',');
  const canonical = [...METHOD_SET_DEFAULT].sort().join(',');
  if (requested !== canonical) {
    console.error(
      `[FAIL] ${GATE_ID}: GATE_METHOD_SET narrowed to {${requested}} in CI without GATE_FIXTURE_MODE=1. ` +
      `A subset that happens to be clean passes while violations under the omitted methods are never examined. ` +
      `Canonical set is {${canonical}}. Fail closed.`
    );
    process.exit(1);
  }
}

// Set once by loadTypeScript() at the top of main(), before any helper below
// runs. Every reader here executes only after that resolution completes.
let ts;

async function loadTypeScript() {
  try {
    const mod = await import('typescript');
    return mod.default ?? mod;
  } catch (error) {
    console.error(
      `[FAIL] ${GATE_ID}: cannot resolve 'typescript' from this repo's node_modules — ` +
      `add it as a devDependency. (${error.message})`
    );
    process.exit(1);
  }
}

function parseSource(relativePath, source) {
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function normalizePath(rawPath) {
  let normalized = rawPath.replace(/\/:[A-Za-z0-9_]+/g, '/:param');
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function buildSuppressionIndex(sourceText) {
  const lines = sourceText.split('\n');
  const suppressed = new Set();
  const fileWide = new RegExp(`guard-ignore-file:\\s*${GATE_ID}\\b`);
  const sameLine = new RegExp(`guard-ignore:\\s*${GATE_ID}\\b`);
  const nextLine = new RegExp(`guard-ignore-next-line:\\s*${GATE_ID}\\b`);
  if (lines.length > 0 && fileWide.test(lines[0])) return { all: true, suppressed };
  lines.forEach((text, index) => {
    if (sameLine.test(text) && !nextLine.test(text)) suppressed.add(index + 1);
    if (nextLine.test(text)) suppressed.add(index + 2);
  });
  return { all: false, suppressed };
}

function collectRegistrations(relativePath, sourceText) {
  const sourceFile = parseSource(relativePath, sourceText);
  const suppression = buildSuppressionIndex(sourceText);
  if (suppression.all) return [];
  const registrations = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      REGISTRATION_METHODS.has(node.expression.name.text) &&
      node.arguments.length > 0
    ) {
      const firstArg = unwrap(node.arguments[0]);
      if (ts.isStringLiteralLike(firstArg) && firstArg.text.startsWith('/')) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const lineNumber = line + 1;
        if (!suppression.suppressed.has(lineNumber)) {
          registrations.push({
            method: node.expression.name.text.toUpperCase(),
            rawPath: firstArg.text,
            normPath: normalizePath(firstArg.text),
            file: relativePath,
            line: lineNumber,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return registrations;
}

async function collectTsFiles(absoluteDir, relativeRoot) {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const absoluteChild = path.resolve(absoluteDir, entry.name);
    const relativeChild = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(absoluteChild, relativeChild)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(relativeChild);
    }
  }
  return files;
}

// Corpus-narrowing guard — see the sibling gate for the full rationale
// (external review, 2026-07-29). Fixture roots always need GATE_FIXTURE_MODE=1;
// under CI=true any non-default root does too. Otherwise a branch-controlled
// env: block can point the scan at one clean file and collect a green that
// inspected none of server/routes.
const FIXTURE_MODE = process.env.GATE_FIXTURE_MODE === '1';
function assertRootAllowed(label, absPath, isDefault) {
  if (FIXTURE_MODE) return;
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  if (rel === 'scripts/gates/fixtures' || rel.startsWith('scripts/gates/fixtures/')) {
    console.error(`[FAIL] ${GATE_ID}: ${label} points at the committed fixture tree (${rel}) without GATE_FIXTURE_MODE=1 — a fixtures-only "pass" inspects none of the production corpus. Fail closed.`);
    process.exit(1);
  }
  if (process.env.CI === 'true' && !isDefault) {
    console.error(`[FAIL] ${GATE_ID}: ${label} overridden to ${rel} in CI without GATE_FIXTURE_MODE=1 — a narrowed corpus can be arbitrarily clean. Production CI runs use the canonical roots. Fail closed.`);
    process.exit(1);
  }
}

async function main() {
  ts = await loadTypeScript();

  const scanDirOverride = process.env.GATE_SCAN_DIR;
  const scanTargets = [];
  let scanDirAbs;
  if (scanDirOverride) {
    scanDirAbs = path.resolve(scanDirOverride);
    assertRootAllowed('GATE_SCAN_DIR', scanDirAbs, false);
    if (!existsSync(scanDirAbs)) {
      console.error(`[FAIL] ${GATE_ID}: GATE_SCAN_DIR ${scanDirAbs} does not exist — misconfiguration, fail closed`);
      process.exit(1);
    }
    scanTargets.push(...(await collectTsFiles(scanDirAbs, path.relative(ROOT, scanDirAbs).split(path.sep).join('/'))));
  } else {
    scanDirAbs = path.resolve(ROOT, SCAN_REL_DIR_DEFAULT);
    if (!existsSync(scanDirAbs)) {
      console.error(`[FAIL] ${GATE_ID}: GATE_SCAN_DIR (default ${scanDirAbs}) does not exist — misconfiguration, fail closed`);
      process.exit(1);
    }
    scanTargets.push(...(await collectTsFiles(scanDirAbs, SCAN_REL_DIR_DEFAULT)));
    scanTargets.push(...SCAN_EXTRA_FILES_DEFAULT);
  }

  const registrations = [];
  for (const relativePath of scanTargets) {
    const source = await readFile(path.resolve(ROOT, relativePath), 'utf8');
    registrations.push(...collectRegistrations(relativePath, source));
  }

  if (registrations.length === 0) {
    // Fail closed: zero registrations across the scanned tree means the
    // parser or traversal broke, not that the repo has no registrations — a
    // silent zero would make this gate permanently green.
    console.error(`[FAIL] ${GATE_ID}: collected 0 registrations — parser or scan-dir regression`);
    process.exit(1);
  }

  const groups = new Map();
  for (const registration of registrations) {
    const key = `${registration.method} ${registration.normPath}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(registration);
  }

  const duplicates = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const isApiPath = members[0].normPath.startsWith('/api/');
    const sameFile = members.every((m) => m.file === members[0].file);
    if (isApiPath || sameFile) duplicates.push({ key, members });
  }

  if (duplicates.length > 0) {
    console.error('Duplicate registration check failed:');
    for (const { key, members } of duplicates.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  [duplicate-registration] ${key} claimed ${members.length}x — the first mounted match wins; the rest are silently shadowed:`);
      for (const member of members) {
        console.error(`    ${member.file}:${member.line} (${member.rawPath})`);
      }
    }
    console.error(`[GATE] ${GATE_ID}: violations=${duplicates.length}`);
    process.exit(VIOLATION_EXIT);
  }

  console.log(
    `Duplicate registration check passed: ${registrations.length} registration(s) across ${scanTargets.length} file(s), 0 duplicate claims.`
  );
  // Effective configuration is echoed for the same reason the sibling gate
  // echoes it: the zero-registrations tripwire above only catches a scan that
  // matched NOTHING, so a GATE_SCAN_DIR or GATE_METHOD_SET narrowed to one
  // clean file still prints a confident pass. A `[GATE]` line that names no
  // inputs looks identical whether the gate inspected the whole repo or one
  // file, which makes a neutered run invisible in a log diff.
  const scanDirRel = path.relative(ROOT, scanDirAbs).split(path.sep).join('/') || '.';
  console.log(
    `[GATE] ${GATE_ID}: violations=0 registrations=${registrations.length} ` +
    `method_set={${[...REGISTRATION_METHODS].sort().join(',')}} ` +
    `scan_dir=${scanDirRel} files=${scanTargets.length}`
  );
}

main().catch((error) => {
  console.error(`[FAIL] ${GATE_ID}: ${error.message}`);
  process.exit(1);
});
