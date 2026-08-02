#!/usr/bin/env node
// Factory-invocation gate (generalised from the consumer-repo audit-prevention
// gate `verify-middleware-factory-invocation.mjs`, 2026-07-24; ported into
// this library unchanged in mechanics, generalised in configuration).
//
// Bug class: FACTORY functions (functions that RETURN a handler, e.g.
// `requireOrgPermission(key)`, `validateBody(schema)`) registered WITHOUT
// invocation. `router.post('/x', requireOrgPermission, handler)` type-checks
// cleanly under common Express-shaped typings (the stock overloads absorb the
// bare factory via the handler-union shape) but at runtime the framework
// calls the factory itself as the handler, its returned handler is discarded,
// `next()` is never reached, and whatever the factory would have built
// (permission check, validation, etc.) silently never runs. No compiler or
// test naturally catches this — hence a dedicated structural gate.
//
// Mechanics (AST via the TypeScript compiler API — not a substring scan):
//   1. Derive the factory set from source: every exported const / function in
//      GATE_SOURCE_DIR whose top-level body returns a function literal is a
//      factory. Nothing is hand-maintained, so the set cannot rot as new
//      factories are added (a plain handler that returns void is never
//      tracked).
//   2. Scan GATE_SCAN_DIR (plus, when the default scan dir is in effect, the
//      library's known extra entry file `server/index.ts`) for registration
//      calls (method names in GATE_METHOD_SET) whose direct arguments — or
//      direct array-literal elements — are BARE references to a derived
//      factory name. Each hit is a violation.
//
// Known blind spots (deliberate — precision over recall, do not "tighten"):
//   - factories aliased to another name before registration;
//   - factories passed through wrappers or conditional expressions;
//   - factories defined outside GATE_SOURCE_DIR.
//
// Configuration (env vars, all optional):
//   GATE_SOURCE_DIR   Dir to derive factories from. Default: server/middleware
//                     (resolved against the process cwd). A missing dir
//                     (default or override) is a misconfiguration — fail
//                     closed, exit 1.
//   GATE_SCAN_DIR     Dir to scan for bare-factory registrations. Default:
//                     server/routes, plus server/index.ts (ported from the
//                     origin gate) when the default is in effect. An
//                     explicit override scans only that dir, recursively, no
//                     extra file. Missing dir (default or override) is a
//                     misconfiguration — fail closed, exit 1.
//   GATE_METHOD_SET   Comma-separated registration method names. Default:
//                     get,post,put,patch,delete,all,use,options,head.
//   VERIFY_FACTORY_INVOCATION_EXIT=1   Promotes findings from warning
//                     (exit 2, default) to blocking (exit 1). Warning-first
//                     is the soak mechanism; flipping this is a per-gate
//                     operator decision made after the soak window, not a
//                     new mechanism.
//
// Suppression (house grammar, guard-id: factory-invocation):
//   same-line:  // guard-ignore: factory-invocation reason="..."
//   next-line:  // guard-ignore-next-line: factory-invocation reason="..."
//   file-wide:  // guard-ignore-file: factory-invocation reason="..." (first line)
//
// `typescript` is resolved dynamically (not a static top-level import) from
// the CONSUMING repo's node_modules at runtime — this is the first
// TS-dependent gate in an otherwise plain-shell library, so an unresolvable
// dependency must produce a legible one-line message naming it, not a raw
// module-not-found stack trace.
//
// Exit codes: 0 clean; 2 violations (warning-first, see
// VERIFY_FACTORY_INVOCATION_EXIT above); 1 on internal/tool error,
// misconfiguration, or an unresolvable `typescript` (fail-closed — never
// exit 0 on an error path).
//
// Fixture self-test: scripts/gates/fixtures/verify-factory-invocation/
//   GATE_SOURCE_DIR / GATE_SCAN_DIR point the gate at the fixture tree.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GATE_ID = 'factory-invocation';
const SOURCE_REL_DIR_DEFAULT = 'server/middleware';
const SCAN_REL_DIR_DEFAULT = 'server/routes';
const SCAN_EXTRA_FILES_DEFAULT = ['server/index.ts'];
const METHOD_SET_DEFAULT = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'options', 'head'];
const VIOLATION_EXIT = process.env.VERIFY_FACTORY_INVOCATION_EXIT === '1' ? 1 : 2;
const REGISTRATION_METHODS = new Set(
  (process.env.GATE_METHOD_SET ? process.env.GATE_METHOD_SET.split(',') : METHOD_SET_DEFAULT)
    .map((m) => m.trim())
    .filter(Boolean)
);
// An empty or whitespace-only GATE_METHOD_SET survives the filter as an empty
// Set, after which no call site can ever match and the gate reports a
// confident pass having inspected nothing. Fail closed at construction, where
// the message can name the actual cause, rather than relying on the
// downstream zero-registrations tripwire to infer it.
if (REGISTRATION_METHODS.size === 0) {
  console.error(`[FAIL] ${GATE_ID}: GATE_METHOD_SET resolved to an empty method set — misconfiguration, fail closed`);
  process.exit(1);
}
// A NARROWED method set is the sibling of a narrowed corpus, and the root guard
// below did not cover it: with canonical roots and `GATE_METHOD_SET: options`,
// one clean `.options()` registration satisfies the zero-match tripwire while
// every `.get()` violation goes unexamined — a green that inspected the right
// files with the wrong lens (external review round 2). Under CI, the method set
// must be exactly the canonical default unless fixture mode is declared.
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
  const kind = relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind);
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

function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** A function body "returns a function literal" iff its concise body is a
 *  function, or its block body contains a TOP-LEVEL `return <function>`.
 *  Plain handlers (`return next()`, `return;`) never match. */
function returnsFunctionLiteral(fn) {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return isFunctionLike(unwrap(fn.body));
  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      if (isFunctionLike(unwrap(statement.expression))) return true;
    }
  }
  return false;
}

// Recurses, matching the scan side (collectTsFiles). It previously read only
// the top level of GATE_SOURCE_DIR, so a repo organising middleware as
// server/middleware/auth/requireX.ts lost every factory in that subtree while
// the gate still printed a confident "N factories tracked" pass. The
// zero-count tripwire below catches total derivation failure but is blind to
// this partial narrowing. Test files are excluded for the same reason they are
// on the scan side: a factory defined only in a test is not a real registration
// target, and including them would inflate the tracked set with names that can
// never be violated in production code.
async function deriveFactories(sourceDirAbs) {
  const factories = new Set();
  const entries = await readdir(sourceDirAbs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      const nested = await deriveFactories(path.resolve(sourceDirAbs, entry.name));
      for (const name of nested) factories.add(name);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const abs = path.resolve(sourceDirAbs, entry.name);
    const sourceFile = parseSource(entry.name, await readFile(abs, 'utf8'));
    for (const statement of sourceFile.statements) {
      const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported) continue;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          const initializer = unwrap(declaration.initializer);
          if (isFunctionLike(initializer) && returnsFunctionLiteral(initializer)) {
            factories.add(declaration.name.text);
          }
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        if (returnsFunctionLiteral(statement)) factories.add(statement.name.text);
      }
    }
  }
  return factories;
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

function scanFile(relativePath, sourceText, factories) {
  const sourceFile = parseSource(relativePath, sourceText);
  const suppression = buildSuppressionIndex(sourceText);
  // A file-wide suppression is reported, not silent: main() surfaces the count
  // so a reviewer sees the number move in the gate's own output rather than
  // having to spot a one-line comment in a large diff.
  if (suppression.all) return { findings: [], registrationCallSites: 0, fileSuppressed: true };
  const findings = [];
  let registrationCallSites = 0;

  function flagIfBareFactory(argumentNode, methodName) {
    const value = unwrap(argumentNode);
    if (!ts.isIdentifier(value) || !factories.has(value.text)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(value.getStart(sourceFile));
    const lineNumber = line + 1;
    if (suppression.suppressed.has(lineNumber)) return;
    findings.push({
      file: relativePath,
      line: lineNumber,
      rule: 'uninvoked-factory',
      detail:
        `\`${value.text}\` is a FACTORY passed bare to \`.${methodName}()\` — ` +
        `the check it builds never runs. Replace with \`${value.text}(...)\`.`,
    });
  }

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      REGISTRATION_METHODS.has(node.expression.name.text)
    ) {
      // Counted so main() can fail closed when the whole scan matches nothing.
      // Without this the gate is silenceable: point GATE_METHOD_SET at a method
      // the repo never calls and every walk matches zero nodes, yielding a
      // clean green that inspected nothing.
      registrationCallSites += 1;
      const methodName = node.expression.name.text;
      for (const argument of node.arguments) {
        const value = unwrap(argument);
        if (ts.isArrayLiteralExpression(value)) {
          for (const element of value.elements) flagIfBareFactory(element, methodName);
        } else {
          flagIfBareFactory(argument, methodName);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { findings, registrationCallSites };
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

// Corpus-narrowing guard. The zero-match tripwires catch a scan that finds
// NOTHING, but a branch-controlled workflow could point GATE_SCAN_DIR /
// GATE_SOURCE_DIR at one small clean file (the committed fixtures are ideal
// ammunition) and the gate would pass having inspected none of the production
// corpus — "at least one relevant node" is not "the intended corpus".
// Contract (external review, 2026-07-29):
//   - a root under scripts/gates/fixtures is ALWAYS refused without
//     GATE_FIXTURE_MODE=1 — there is no production reason to scan fixtures;
//   - under CI=true, ANY non-default root requires GATE_FIXTURE_MODE=1, so a
//     production CI invocation runs against the canonical roots or dies. The
//     gate's own test suite sets GATE_FIXTURE_MODE=1 when it spawns us against
//     temp dirs, which keeps tests green in CI while a workflow quietly adding
//     that variable to a production job is a visible, greppable diff (and the
//     branch-can-edit-its-own-workflow class is tracked separately).
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

  const sourceDirOverride = process.env.GATE_SOURCE_DIR;
  const scanDirOverride = process.env.GATE_SCAN_DIR;

  const sourceDirAbs = sourceDirOverride
    ? path.resolve(sourceDirOverride)
    : path.resolve(ROOT, SOURCE_REL_DIR_DEFAULT);
  assertRootAllowed('GATE_SOURCE_DIR', sourceDirAbs, !sourceDirOverride);

  if (!existsSync(sourceDirAbs)) {
    console.error(`[FAIL] ${GATE_ID}: GATE_SOURCE_DIR ${sourceDirAbs} does not exist — misconfiguration, fail closed`);
    process.exit(1);
  }

  const factories = await deriveFactories(sourceDirAbs);
  if (factories.size === 0) {
    // Fail closed: an empty derived set means the derivation itself broke
    // (the source dir moved or the parser regressed), not that the repo has
    // no factories. A silently empty set would make this gate permanently green.
    console.error(`[FAIL] ${GATE_ID}: derived 0 factories from ${sourceDirAbs} — derivation broken or dir moved`);
    process.exit(1);
  }

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
  const relFromRoot = (abs) => path.relative(ROOT, abs).split(path.sep).join('/') || '.';

  const findings = [];
  let registrationCallSites = 0;
  let suppressedFiles = 0;
  for (const relativePath of scanTargets) {
    const source = await readFile(path.resolve(ROOT, relativePath), 'utf8');
    const result = scanFile(relativePath, source, factories);
    findings.push(...result.findings);
    registrationCallSites += result.registrationCallSites;
    if (result.fileSuppressed) suppressedFiles += 1;
  }

  // Fail closed on a scan that matched nothing, mirroring the derivation-side
  // guard above and the sibling gate (verify-duplicate-registrations.mjs).
  // Without it the gate is silenceable from a branch-controlled `env:` block:
  // GATE_METHOD_SET set to a method the repo never calls makes every AST walk
  // match zero nodes, and the pass line still reads like a real inspection.
  if (registrationCallSites === 0) {
    console.error(
      `[FAIL] ${GATE_ID}: matched 0 registration call sites across ${scanTargets.length} file(s) ` +
      `using method set {${[...REGISTRATION_METHODS].sort().join(', ')}} — ` +
      `scan broken, wrong GATE_METHOD_SET/GATE_SCAN_DIR, or every file suppressed (${suppressedFiles} file-wide suppression(s)). ` +
      `Refusing to report a pass that inspected nothing.`
    );
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(`Factory invocation check failed (${factories.size} factories tracked):`);
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line}: [${finding.rule}] ${finding.detail}`);
    }
    console.error(`[GATE] ${GATE_ID}: violations=${findings.length}`);
    process.exit(VIOLATION_EXIT);
  }

  console.log(
    `Factory invocation check passed: ${scanTargets.length} file(s) scanned, ` +
    `${registrationCallSites} registration call site(s) matched, ` +
    `${factories.size} factories tracked (${[...factories].sort().join(', ')}).`
  );
  // Effective configuration is echoed so a neutered run is visible as a log
  // diff. A pass line that never names its inputs looks identical whether the
  // gate inspected the whole repo or nothing at all. All THREE knobs are named:
  // echoing only the method set left the two that most directly control what
  // gets inspected invisible, and the zero-registrations tripwire does not
  // catch narrowing — pointing GATE_SCAN_DIR at one clean route file still
  // matches registration call sites and still prints a confident pass.
  console.log(
    `[GATE] ${GATE_ID}: violations=0 registrations=${registrationCallSites} ` +
    `suppressed_files=${suppressedFiles} method_set={${[...REGISTRATION_METHODS].sort().join(',')}} ` +
    `source_dir=${relFromRoot(sourceDirAbs)} scan_dir=${relFromRoot(scanDirAbs)} files=${scanTargets.length}`
  );
}

main().catch((error) => {
  console.error(`[FAIL] ${GATE_ID}: ${error.message}`);
  process.exit(1);
});
