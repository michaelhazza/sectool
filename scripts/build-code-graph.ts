/**
 * build-code-graph.ts
 *
 * Framework-canonical builder for the code-intelligence import graph
 * ("Phase 0 cache"). Walks the project's TypeScript scan roots and produces:
 *   references/.code-graph-cache.json        — incremental SHA256 cache
 *   references/import-graph/<dir>.json       — per-scan-root import graph shard
 *   references/import-graph/.skipped.txt     — extraction failures
 *   references/project-map.md                — human-readable digest
 *   references/.watcher.pid                  — live-watcher marker (fast path
 *                                              for .claude/hooks/code-graph-freshness-check.js)
 *
 * Contract with the SessionStart hook (.claude/hooks/code-graph-freshness-check.js):
 *   - Hook spawns `npx tsx scripts/build-code-graph.ts` (no args) when
 *     references/.watcher.pid is absent or dead.
 *   - Default mode must: refresh shards incrementally, exit 0 on success
 *     (non-zero only on genuine build failure), and leave a live watcher
 *     behind where the platform supports one so subsequent session starts
 *     take the fast path.
 *
 * Configuration (all optional):
 *   CODE_GRAPH_ROOT            — project root. Default: process.cwd()
 *                                (the hook and npm scripts both run from root).
 *   CODE_GRAPH_SCAN_DIRS       — comma-separated scan roots relative to root.
 *   CODE_GRAPH_REFERENCES_DIR  — output directory override (parallel-safe
 *                                testing). Default: <root>/references.
 *
 * Scan-root derivation order (first non-empty wins):
 *   1. CODE_GRAPH_SCAN_DIRS env var
 *   2. package.json "workspaces" (simple `<dir>/*` globs expanded one level)
 *   3. Defaults: server/, client/, shared/, scripts/
 * In every case, only directories that actually exist are scanned; missing
 * ones are skipped silently.
 *
 * Dependencies: Node stdlib only (executed via tsx, which the freshness hook
 * already requires). The original consumer implementation used ts-morph
 * (AST import resolution), chokidar (watcher), and proper-lockfile
 * (singleton lock). Those are replaced here with:
 *   - regex-based import/export extraction + tsconfig-paths-aware resolution
 *     (best-effort; the cache is an advisory hint layer, and unresolvable or
 *     external specifiers are dropped exactly as the AST version dropped them)
 *   - fs.watch({ recursive: true }) (supported on Windows/macOS, and Linux on
 *     Node 20+; where unsupported the watcher degrades to "rebuild on next
 *     session start", which the hook already handles)
 *   - a PID-file liveness check as the watcher singleton guard
 *
 * Usage:
 *   npx tsx scripts/build-code-graph.ts               # incremental build + spawn watcher
 *   npx tsx scripts/build-code-graph.ts --rebuild     # drop cache, kill watcher, cold build
 *   npx tsx scripts/build-code-graph.ts --no-watch    # build only (CI-friendly)
 *   npx tsx scripts/build-code-graph.ts --watch-only  # skip build, spawn watcher
 */

import { createHash } from 'node:crypto';
import { promises as fs, existsSync, openSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Paths + configuration
// ---------------------------------------------------------------------------

const ROOT = process.env.CODE_GRAPH_ROOT
  ? path.resolve(process.env.CODE_GRAPH_ROOT)
  : process.cwd();

const REFERENCES_DIR = process.env.CODE_GRAPH_REFERENCES_DIR
  ? path.resolve(process.env.CODE_GRAPH_REFERENCES_DIR)
  : path.join(ROOT, 'references');

const CACHE_PATH = path.join(REFERENCES_DIR, '.code-graph-cache.json');
const SHARD_DIR = path.join(REFERENCES_DIR, 'import-graph');
const SKIPPED_PATH = path.join(SHARD_DIR, '.skipped.txt');
const DIGEST_PATH = path.join(REFERENCES_DIR, 'project-map.md');
const WATCHER_LOG_PATH = path.join(REFERENCES_DIR, '.code-graph-watcher.log');
const WATCHER_PID_PATH = path.join(REFERENCES_DIR, '.watcher.pid');

const DEFAULT_SCAN_DIRS = ['server', 'client', 'shared', 'scripts'];

/** Bump when the FileEntry shape or a normalisation rule changes. */
const CACHE_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  sha256: string;
  imports: string[];
  exports: string[];
  importedBy: string[];
}

type Cache = Record<string, FileEntry>;

interface CacheFile {
  version: number;
  entries: Cache;
}

interface Shard {
  files: Record<string, Omit<FileEntry, 'sha256'>>;
}

interface AliasRule {
  /** e.g. "@/" for pattern "@/*" — or the full specifier for exact aliases */
  prefix: string;
  /** true when the tsconfig pattern ended in "*" */
  wildcard: boolean;
  /** absolute target base paths, in priority order */
  targets: string[];
}

// ---------------------------------------------------------------------------
// Scan-root derivation
// ---------------------------------------------------------------------------

function deriveScanDirs(): string[] {
  let candidates: string[] = [];

  const envDirs = (process.env.CODE_GRAPH_SCAN_DIRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (envDirs.length > 0) {
    candidates = envDirs;
  } else {
    // package.json workspaces, if declared
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      const ws: unknown = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(ws) && ws.length > 0) {
        for (const entry of ws) {
          if (typeof entry !== 'string') continue;
          if (entry.endsWith('/*')) {
            // Expand one level: packages/* → packages/a, packages/b, …
            const base = path.join(ROOT, entry.slice(0, -2));
            try {
              for (const d of readdirSyncSafe(base)) {
                candidates.push(path.posix.join(entry.slice(0, -2), d));
              }
            } catch { /* base missing — skip */ }
          } else {
            candidates.push(entry);
          }
        }
      }
    } catch { /* no package.json or unparseable — fall through */ }

    if (candidates.length === 0) candidates = [...DEFAULT_SCAN_DIRS];
  }

  // Existing directories only; skip silently otherwise.
  return candidates.filter((d) => {
    try {
      return existsSync(path.join(ROOT, d));
    } catch {
      return false;
    }
  });
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const SCAN_DIRS: string[] = deriveScanDirs();

/** Shard file name for a scan root: nested roots flatten "/" to "-". */
function shardNameFor(scanDir: string): string {
  return scanDir.replace(/[\\/]+/g, '-');
}

// ---------------------------------------------------------------------------
// Path normalisation
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to a repo-root-relative POSIX path.
 * On Windows, lowercase for case normalisation. Never strips extensions.
 */
function toRepoRelPosix(absPath: string): string {
  let rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
  if (process.platform === 'win32') rel = rel.toLowerCase();
  if (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

/**
 * Test files are discovered by the test runner — zero inbound imports does
 * not make them entry points or dead code. Excluded from digest sections;
 * still present in shards.
 */
function isTestFile(relPath: string): boolean {
  return /\/__tests__\//.test(relPath) || /\.(test|spec)\.tsx?$/.test(relPath);
}

function isExcludedTsFile(name: string): boolean {
  return name.endsWith('.d.ts') || name.endsWith('.generated.ts');
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

async function walkTs(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function recurse(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === '.git') continue;
        await recurse(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !isExcludedTsFile(entry.name)) {
        results.push(full);
      }
    }
  }
  await recurse(dir);
  return results;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

async function loadCache(): Promise<Cache> {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (parsed.version !== CACHE_VERSION) {
      console.warn(`[code-graph] cache version mismatch (got ${parsed.version}, expected ${CACHE_VERSION}) — discarding and rebuilding`);
      return {};
    }
    return parsed.entries ?? {};
  } catch {
    return {};
  }
}

async function saveCache(cache: Cache): Promise<void> {
  const out: CacheFile = { version: CACHE_VERSION, entries: cache };
  await writeAtomic(CACHE_PATH, JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------
// tsconfig path-alias loading (JSONC-tolerant, best-effort)
// ---------------------------------------------------------------------------

function stripJsonComments(input: string): string {
  // Remove /* … */ and // … outside of strings — a light pass sufficient for
  // real-world tsconfig files. Trailing commas are also normalised.
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function loadAliasRules(): AliasRule[] {
  const rules: AliasRule[] = [];
  // Check root tsconfig plus one per scan root (mirrors multi-tsconfig repos).
  const tsconfigCandidates = [
    path.join(ROOT, 'tsconfig.json'),
    ...SCAN_DIRS.map((d) => path.join(ROOT, d, 'tsconfig.json')),
  ];
  for (const tsconfigPath of tsconfigCandidates) {
    if (!existsSync(tsconfigPath)) continue;
    try {
      const parsed = JSON.parse(stripJsonComments(readFileSync(tsconfigPath, 'utf8')));
      const co = parsed?.compilerOptions ?? {};
      const baseUrl = path.resolve(path.dirname(tsconfigPath), co.baseUrl ?? '.');
      const paths: Record<string, string[]> = co.paths ?? {};
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const wildcard = pattern.endsWith('*');
        const prefix = wildcard ? pattern.slice(0, -1) : pattern;
        rules.push({
          prefix,
          wildcard,
          targets: targets.map((t) =>
            path.resolve(baseUrl, wildcard && t.endsWith('*') ? t.slice(0, -1) : t),
          ),
        });
      }
    } catch { /* unparseable tsconfig — aliases unavailable from this file */ }
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Import / export extraction (regex, advisory-grade)
// ---------------------------------------------------------------------------

const IMPORT_SPEC_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

const EXPORT_DECL_RE =
  /(?:^|\n)\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|const|let|var|type|interface|enum|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

const EXPORT_BRACE_RE = /(?:^|\n)\s*export\s*\{([^}]*)\}/g;

const EXPORT_DEFAULT_RE = /(?:^|\n)\s*export\s+default\b/;

function extractSpecifiers(content: string): string[] {
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_SPEC_RE.lastIndex = 0;
  while ((m = IMPORT_SPEC_RE.exec(content)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

function extractExports(content: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  EXPORT_DECL_RE.lastIndex = 0;
  while ((m = EXPORT_DECL_RE.exec(content)) !== null) {
    names.add(m[2]);
  }
  EXPORT_BRACE_RE.lastIndex = 0;
  while ((m = EXPORT_BRACE_RE.exec(content)) !== null) {
    for (const part of m[1].split(',')) {
      const token = part.trim();
      if (!token) continue;
      // "a as b" exports b; "type a" exports a
      const asMatch = token.match(/^(?:type\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
      const plain = token.match(/^(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (asMatch) names.add(asMatch[1]);
      else if (plain) names.add(plain[1]);
    }
  }
  if (EXPORT_DEFAULT_RE.test(content)) names.add('default');
  return Array.from(names);
}

/**
 * Resolve a specifier to a known project file (repo-relative POSIX path), or
 * null when external / unresolvable. `knownFiles` is the set of every walked
 * source file — resolution never touches the filesystem.
 */
function resolveSpecifier(
  spec: string,
  fileDir: string,
  aliases: AliasRule[],
  knownFiles: Set<string>,
): string | null {
  const bases: string[] = [];
  if (spec.startsWith('.')) {
    bases.push(path.resolve(fileDir, spec));
  } else {
    for (const rule of aliases) {
      if (rule.wildcard) {
        if (spec.startsWith(rule.prefix)) {
          const rest = spec.slice(rule.prefix.length);
          for (const t of rule.targets) bases.push(path.join(t, rest));
        }
      } else if (spec === rule.prefix) {
        bases.push(...rule.targets);
      }
    }
  }
  if (bases.length === 0) return null; // bare / external specifier — dropped

  for (const base of bases) {
    // TypeScript-ESM idiom: `./foo.js` on disk is `./foo.ts`.
    const swapped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
      `${swapped}.ts`,
      `${swapped}.tsx`,
    ];
    for (const candidate of candidates) {
      const rel = toRepoRelPosix(candidate);
      if (knownFiles.has(rel)) return rel;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reverse index (importedBy)
// ---------------------------------------------------------------------------

function buildImportedBy(
  allEntries: Map<string, { imports: string[] }>,
): Map<string, string[]> {
  const importedBy = new Map<string, string[]>();
  for (const relPath of allEntries.keys()) importedBy.set(relPath, []);
  for (const [relPath, entry] of allEntries) {
    for (const imp of entry.imports) {
      if (!importedBy.has(imp)) importedBy.set(imp, []);
      importedBy.get(imp)!.push(relPath);
    }
  }
  for (const list of importedBy.values()) list.sort();
  return importedBy;
}

// ---------------------------------------------------------------------------
// Digest (project-map.md)
// ---------------------------------------------------------------------------

async function writeDigest(
  allEntries: Map<string, FileEntry>,
  dirFileCounts: Map<string, number>,
  dirLineCounts: Map<string, number>,
): Promise<void> {
  const lines: string[] = [];

  lines.push('# Project Map');
  lines.push('');
  lines.push(
    'This map covers static imports, named exports, and inverted import edges. ' +
      'It does NOT cover: dynamic imports, runtime dispatch via string keys ' +
      '(registries, plugin systems, handler maps), framework-mediated calls ' +
      '(ORM proxy methods, React hooks, decorators), or config-driven behaviour. ' +
      'For questions about runtime behaviour or config-driven dispatch, fall through to source.',
  );
  lines.push('');

  lines.push('## Top 20 Files by Inbound-Import Count');
  lines.push('');
  lines.push('| File | Inbound imports |');
  lines.push('|------|-----------------|');
  const byInbound = Array.from(allEntries.entries()).map(([p, e]) => ({
    path: p,
    count: e.importedBy.length,
  }));
  byInbound.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  for (const entry of byInbound.slice(0, 20)) {
    lines.push(`| \`${entry.path}\` | ${entry.count} |`);
  }
  lines.push('');

  const ENTRY_POINTS_PER_DIR_CAP = 10;
  lines.push('## Service Entry Points by Directory');
  lines.push('');
  lines.push(
    `_Files with zero inbound imports that have at least one outbound import. Top ${ENTRY_POINTS_PER_DIR_CAP} per directory shown; test files excluded._`,
  );
  lines.push('');
  const entryPoints = Array.from(allEntries.entries())
    .filter(([p, e]) => e.importedBy.length === 0 && e.imports.length > 0 && !isTestFile(p))
    .map(([p]) => p)
    .sort();
  const byDir = new Map<string, string[]>();
  for (const p of entryPoints) {
    const dir = SCAN_DIRS.find((d) => p.startsWith(d.toLowerCase() + '/') || p.startsWith(d + '/')) ?? p.split('/')[0];
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(p);
  }
  for (const dir of SCAN_DIRS) {
    const files = byDir.get(dir) ?? [];
    if (files.length === 0) continue;
    lines.push(`### ${dir}`);
    lines.push('');
    for (const f of files.slice(0, ENTRY_POINTS_PER_DIR_CAP)) {
      lines.push(`- \`${f}\``);
    }
    if (files.length > ENTRY_POINTS_PER_DIR_CAP) {
      lines.push(`- _…and ${files.length - ENTRY_POINTS_PER_DIR_CAP} more (see shard for full list)._`);
    }
    lines.push('');
  }

  const DEAD_CODE_CAP = 20;
  lines.push('## Files with Zero Inbound Imports (Dead-Code Candidates)');
  lines.push('');
  lines.push(
    `_Top ${DEAD_CODE_CAP} alphabetical; test files excluded. Many candidates are not actually dead — they are dispatched dynamically. See non-goals at top._`,
  );
  lines.push('');
  const zeroInbound = Array.from(allEntries.entries())
    .filter(([p, e]) => e.importedBy.length === 0 && !isTestFile(p))
    .map(([p]) => p)
    .sort();
  if (zeroInbound.length === 0) {
    lines.push('_None._');
  } else {
    for (const p of zeroInbound.slice(0, DEAD_CODE_CAP)) {
      lines.push(`- \`${p}\``);
    }
    if (zeroInbound.length > DEAD_CODE_CAP) {
      lines.push(`- _…and ${zeroInbound.length - DEAD_CODE_CAP} more (see shards for full list)._`);
    }
  }
  lines.push('');

  lines.push('## Per-Directory Totals');
  lines.push('');
  lines.push('| Directory | Files | Lines |');
  lines.push('|-----------|-------|-------|');
  for (const dir of SCAN_DIRS) {
    const files = dirFileCounts.get(dir) ?? 0;
    const linesCount = dirLineCounts.get(dir) ?? 0;
    lines.push(`| \`${dir}\` | ${files} | ${linesCount.toLocaleString()} |`);
  }
  lines.push('');

  await writeAtomic(DIGEST_PATH, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Extraction pass (shared by cold build and watcher)
// ---------------------------------------------------------------------------

interface Extracted {
  imports: string[];
  exports: string[];
  hash: string;
  lineCount: number;
}

async function extractFile(
  absPath: string,
  aliases: AliasRule[],
  knownFiles: Set<string>,
  cache: Cache,
): Promise<Extracted | null> {
  const relPath = toRepoRelPosix(absPath);
  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch {
    return null;
  }
  const hash = sha256(content);
  const lineCount = content.split('\n').length;

  const cached = cache[relPath];
  if (cached && cached.sha256 === hash) {
    return { imports: cached.imports, exports: cached.exports, hash, lineCount };
  }

  const imports: string[] = [];
  for (const spec of extractSpecifiers(content)) {
    const resolved = resolveSpecifier(spec, path.dirname(absPath), aliases, knownFiles);
    if (resolved && resolved !== relPath && !imports.includes(resolved)) {
      imports.push(resolved);
    }
  }
  return { imports, exports: extractExports(content), hash, lineCount };
}

// ---------------------------------------------------------------------------
// Cold / incremental build
// ---------------------------------------------------------------------------

async function coldBuild(): Promise<void> {
  console.log(`[code-graph] building (scan roots: ${SCAN_DIRS.join(', ') || 'none'})…`);
  if (SCAN_DIRS.length === 0) {
    console.log('[code-graph] no scan roots exist — nothing to do.');
    return;
  }

  await ensureDir(SHARD_DIR);
  const cache = await loadCache();
  const aliases = loadAliasRules();

  // Walk all scan roots first so resolution can consult the full file set.
  const dirFiles = new Map<string, string[]>();
  const knownFiles = new Set<string>();
  for (const dir of SCAN_DIRS) {
    const files = await walkTs(path.join(ROOT, dir));
    dirFiles.set(dir, files);
    for (const f of files) knownFiles.add(toRepoRelPosix(f));
  }

  const skipped = new Map<string, string>();
  const allExtracted = new Map<string, Extracted>();
  const dirLineCounts = new Map<string, number>();

  for (const dir of SCAN_DIRS) {
    const files = dirFiles.get(dir)!;
    console.log(`[code-graph] extracting ${dir} (${files.length} files)…`);
    let lineTotal = 0;
    for (const absPath of files) {
      const relPath = toRepoRelPosix(absPath);
      const result = await extractFile(absPath, aliases, knownFiles, cache);
      if (result === null) {
        skipped.set(relPath, 'read failure');
        console.warn(`[code-graph] skipped ${relPath}: read failure`);
        continue;
      }
      allExtracted.set(relPath, result);
      lineTotal += result.lineCount;
    }
    dirLineCounts.set(dir, lineTotal);
  }

  const importedBy = buildImportedBy(allExtracted);

  const allEntries = new Map<string, FileEntry>();
  for (const [relPath, { imports, exports, hash }] of allExtracted) {
    allEntries.set(relPath, {
      sha256: hash,
      imports,
      exports,
      importedBy: importedBy.get(relPath) ?? [],
    });
  }

  // Prune cache entries for deleted files, then refresh.
  for (const cachedPath of Object.keys(cache)) {
    if (!allEntries.has(cachedPath)) delete cache[cachedPath];
  }
  for (const [relPath, entry] of allEntries) cache[relPath] = entry;

  // Write shards
  for (const dir of SCAN_DIRS) {
    const files = dirFiles.get(dir)!;
    const shardFiles: Record<string, Omit<FileEntry, 'sha256'>> = {};
    for (const absPath of files) {
      const relPath = toRepoRelPosix(absPath);
      const entry = allEntries.get(relPath);
      if (entry) {
        shardFiles[relPath] = {
          imports: entry.imports,
          exports: entry.exports,
          importedBy: entry.importedBy,
        };
      }
    }
    const shard: Shard = { files: shardFiles };
    await writeAtomic(path.join(SHARD_DIR, `${shardNameFor(dir)}.json`), JSON.stringify(shard, null, 2));
    console.log(`[code-graph] wrote references/import-graph/${shardNameFor(dir)}.json (${Object.keys(shardFiles).length} files)`);
  }

  // Skipped log
  if (skipped.size > 0) {
    const skippedLines = Array.from(skipped.entries()).map(([p, r]) => `${p}\t${r}`);
    await writeAtomic(SKIPPED_PATH, skippedLines.join('\n') + '\n');
  } else {
    await writeAtomic(SKIPPED_PATH, '');
  }

  // 5% skip-rate check per scan root — a systematic extraction failure must
  // surface as a build failure, not silently ship a hollow cache.
  let skipCheckFailed = false;
  for (const dir of SCAN_DIRS) {
    const total = dirFiles.get(dir)!.length;
    if (total === 0) continue;
    const dirKey = process.platform === 'win32' ? dir.toLowerCase() : dir;
    const dirSkipped = Array.from(skipped.keys()).filter((p) => p.startsWith(dirKey + '/')).length;
    if (dirSkipped / total > 0.05) {
      console.error(
        `[code-graph] ERROR: skip rate for ${dir} is ${((dirSkipped / total) * 100).toFixed(1)}% (${dirSkipped}/${total}), exceeds 5% threshold`,
      );
      skipCheckFailed = true;
    }
  }
  if (skipCheckFailed) process.exit(1);

  await saveCache(cache);

  const dirFileCounts = new Map<string, number>();
  for (const dir of SCAN_DIRS) dirFileCounts.set(dir, dirFiles.get(dir)!.length);
  await writeDigest(allEntries, dirFileCounts, dirLineCounts);
  console.log('[code-graph] wrote references/project-map.md');

  const totalFiles = Array.from(dirFiles.values()).reduce((s, a) => s + a.length, 0);
  console.log(`[code-graph] build complete. ${totalFiles} files processed, ${skipped.size} skipped.`);
}

// ---------------------------------------------------------------------------
// Watcher — spawn helper (called from main process)
// ---------------------------------------------------------------------------

async function spawnWatcher(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');

  // Resolve the tsx entry point so the detached child runs this TypeScript
  // file directly via `node --import` (the main `tsx` entry registers both
  // the ESM and CJS hooks, so it works regardless of the nearest
  // package.json's "type"). Spawning `npx tsx` instead is unreliable for a
  // detached child: npx may hit the network when tsx is not resolvable from
  // the child's cwd, and .cmd-shim quoting on Windows is fragile.
  // Resolution order: project root, invoking cwd, this script's own
  // location (covers the framework-submodule layout).
  let tsxEsm: string | null = null;
  for (const base of [
    path.join(ROOT, 'package.json'),
    path.join(process.cwd(), 'package.json'),
    process.argv[1],
  ]) {
    try {
      tsxEsm = createRequire(base).resolve('tsx');
      break;
    } catch { /* try next base */ }
  }
  if (!tsxEsm) {
    console.warn(
      '[code-graph] tsx not resolvable from project root — watcher not started; ' +
        'cache will refresh at each session start instead.',
    );
    return;
  }

  // Route watcher stdio to a log file rather than inheriting the parent's
  // pipes — inherited pipes keep npm/hook parents alive until the detached
  // child exits. The log file is tail-able and searchable across sessions.
  await ensureDir(path.dirname(WATCHER_LOG_PATH));
  const logFd = openSync(WATCHER_LOG_PATH, 'a');

  const scriptPath = process.argv[1];
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(tsxEsm).href, scriptPath, '--watcher-subprocess'],
    { detached: true, stdio: ['ignore', logFd, logFd], cwd: ROOT, env: process.env },
  );
  child.unref();
  const logRel = path.relative(ROOT, WATCHER_LOG_PATH).replace(/\\/g, '/');
  console.log(`[code-graph] watcher spawned in background (pid ${child.pid}). Tail logs with: tail -f ${logRel}`);
}

// ---------------------------------------------------------------------------
// Watcher — subprocess entry point
// ---------------------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

async function runWatcher(): Promise<void> {
  await ensureDir(REFERENCES_DIR);

  // Singleton guard: PID-file liveness check. (The consumer original used
  // proper-lockfile; a PID check is sufficient for an advisory cache — the
  // worst case of a lost race is two watchers writing identical shards.)
  try {
    const existing = Number.parseInt((await fs.readFile(WATCHER_PID_PATH, 'utf8')).trim(), 10);
    if (Number.isFinite(existing) && existing > 0 && existing !== process.pid && isPidAlive(existing)) {
      console.log(`[code-graph] watcher: pid ${existing} already live — exiting`);
      process.exit(0);
    }
  } catch { /* no PID file — proceed */ }
  await fs.writeFile(WATCHER_PID_PATH, String(process.pid), 'utf8');

  // Truncate the log past 5 MB — bounded without a rotation system.
  try {
    const stats = await fs.stat(WATCHER_LOG_PATH);
    if (stats.size > 5 * 1024 * 1024) await fs.truncate(WATCHER_LOG_PATH, 0);
  } catch { /* best-effort */ }

  async function cleanup(): Promise<void> {
    try { await fs.unlink(WATCHER_PID_PATH); } catch { /* best-effort */ }
    process.exit(0);
  }
  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());

  const aliases = loadAliasRules();
  const cache = await loadCache();

  // Rebuild in-memory state from the cache (shards mirror it).
  const knownFiles = new Set<string>(Object.keys(cache));

  const pending = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isProcessing = false;

  async function drain(): Promise<void> {
    if (isProcessing) return;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    const batch = Array.from(pending);
    pending.clear();
    if (batch.length === 0) return;
    isProcessing = true;
    try {
      let changed = false;
      for (const relPath of batch) {
        const absPath = path.join(ROOT, relPath);
        let exists = false;
        try { await fs.access(absPath); exists = true; } catch { /* deleted */ }
        if (!exists) {
          if (cache[relPath]) {
            delete cache[relPath];
            knownFiles.delete(relPath);
            changed = true;
            console.log(`[code-graph] unlink: removed ${relPath}`);
          }
          continue;
        }
        knownFiles.add(relPath);
        const result = await extractFile(absPath, aliases, knownFiles, cache);
        if (result === null) {
          console.warn(`[code-graph] skipped ${relPath}: read failure`);
          continue;
        }
        const prior = cache[relPath];
        if (prior && prior.sha256 === result.hash) continue; // mtime-only touch
        cache[relPath] = {
          sha256: result.hash,
          imports: result.imports,
          exports: result.exports,
          importedBy: prior?.importedBy ?? [],
        };
        changed = true;
        console.log(`[code-graph] updated ${relPath} (${result.imports.length} imports)`);
      }

      if (changed) {
        // Recompute the reverse index over the full cache — O(edges), cheap at
        // typical repo scale, and immune to the bidirectional-patch bug class.
        const forEdge = new Map<string, { imports: string[] }>();
        for (const [p, e] of Object.entries(cache)) forEdge.set(p, { imports: e.imports });
        const importedBy = buildImportedBy(forEdge);
        for (const [p, e] of Object.entries(cache)) {
          e.importedBy = importedBy.get(p) ?? [];
        }
        // Flush shards + cache + digest.
        const dirFileCounts = new Map<string, number>();
        const dirLineCounts = new Map<string, number>();
        const allEntries = new Map<string, FileEntry>(Object.entries(cache));
        for (const dir of SCAN_DIRS) {
          const dirKey = process.platform === 'win32' ? dir.toLowerCase() : dir;
          const shardFiles: Record<string, Omit<FileEntry, 'sha256'>> = {};
          let count = 0;
          for (const [p, e] of Object.entries(cache)) {
            if (p.startsWith(dirKey.replace(/\\/g, '/') + '/')) {
              shardFiles[p] = { imports: e.imports, exports: e.exports, importedBy: e.importedBy };
              count++;
            }
          }
          await writeAtomic(path.join(SHARD_DIR, `${shardNameFor(dir)}.json`), JSON.stringify({ files: shardFiles } satisfies Shard, null, 2));
          dirFileCounts.set(dir, count);
          dirLineCounts.set(dir, 0); // line counts recomputed only on cold build
        }
        await saveCache(cache);
        await writeDigest(allEntries, dirFileCounts, dirLineCounts);
      }
    } finally {
      isProcessing = false;
      if (pending.size > 0) debounceTimer = setTimeout(() => void drain(), 200);
    }
  }

  function schedule(relPath: string): void {
    pending.add(relPath);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void drain(), 200);
  }

  const { watch } = await import('node:fs');
  let anyWatcher = false;
  for (const dir of SCAN_DIRS) {
    const absDir = path.join(ROOT, dir);
    try {
      const watcher = watch(absDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const abs = path.join(absDir, filename.toString());
        const name = path.basename(abs);
        if (!/\.tsx?$/.test(name) || isExcludedTsFile(name)) return;
        const rel = toRepoRelPosix(abs);
        if (rel.split('/').some((seg) => seg === 'node_modules' || seg === 'dist' || seg === 'build' || seg === '.git')) return;
        schedule(rel);
      });
      watcher.on('error', (err) => {
        console.warn(`[code-graph] watcher error on ${dir}: ${err}`);
      });
      anyWatcher = true;
    } catch (err) {
      console.warn(`[code-graph] recursive watch unsupported for ${dir}: ${err}`);
    }
  }

  if (!anyWatcher) {
    // Platform without recursive fs.watch (Linux < Node 20): degrade to
    // rebuild-on-session-start, which the freshness hook already provides.
    console.warn('[code-graph] no watcher could start — falling back to per-session rebuilds');
    await cleanup();
    return;
  }

  console.log(`[code-graph] watcher ready — monitoring ${SCAN_DIRS.join(', ')}`);
}

// ---------------------------------------------------------------------------
// --rebuild support
// ---------------------------------------------------------------------------

async function terminateExistingWatcher(): Promise<void> {
  let pid: number | null = null;
  try {
    const parsed = Number.parseInt((await fs.readFile(WATCHER_PID_PATH, 'utf8')).trim(), 10);
    if (Number.isFinite(parsed)) pid = parsed;
  } catch { /* no PID file */ }

  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[code-graph] --rebuild: sent SIGTERM to watcher (pid ${pid})`);
    } catch {
      pid = null; // already gone
    }
  }

  // Poll for exit before clearing artifacts.
  if (pid !== null) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try { await fs.unlink(WATCHER_PID_PATH); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--watcher-subprocess')) {
    await runWatcher();
    return;
  }

  if (args.includes('--watch-only')) {
    console.log('[code-graph] watch-only mode — spawning watcher');
    await spawnWatcher();
    return;
  }

  if (args.includes('--rebuild')) {
    console.log('[code-graph] --rebuild: terminating any existing watcher…');
    await terminateExistingWatcher();
    console.log('[code-graph] --rebuild: dropping cache…');
    try { await fs.unlink(CACHE_PATH); } catch { /* best-effort */ }
  }

  await coldBuild();

  if (!args.includes('--no-watch') && SCAN_DIRS.length > 0) {
    await spawnWatcher();
  }
}

main().catch((err) => {
  console.error('[code-graph] fatal:', err);
  process.exit(1);
});
