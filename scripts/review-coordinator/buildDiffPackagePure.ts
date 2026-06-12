/**
 * buildDiffPackagePure.ts
 *
 * Pure helper -- no I/O, no fs, no child_process, no path module.
 *
 * Implements the §3c diff truncation strategy: given a list of changed files
 * (with their contents and sizes), classifies each into the
 * always-included / summarised / omitted priority buckets and emits a
 * focused diff package with a manifest header.
 *
 * The caller (buildDiffPackage.ts) performs all I/O; this module receives
 * the file list and contents as plain data and returns the package text.
 */

/** Architecture declarations injected by the coordinator per §3c. */
export interface ArchitectureExcerpt {
  /** Glob-style path patterns for migration files (e.g. ["migrations/**", "*.sql"]) */
  migrationPatterns: string[];
  /** Glob-style path patterns for schema/data-model files */
  schemaPatterns: string[];
  /** Glob-style path patterns for server route files */
  routePatterns: string[];
  /** Glob-style path patterns for worker/job files */
  workerPatterns: string[];
  /** Glob-style path patterns for permission/auth files */
  permissionPatterns: string[];
  /** Glob-style path patterns for gate scripts */
  gatePatterns: string[];
  /**
   * Paths that are in the PR's spec and plan (always-included when changed).
   * Derived from PR_CONTEXT.spec_path and PR_CONTEXT.plan_path.
   */
  specAndPlanPaths: string[];
  /**
   * Per-file byte budget for always-included files.
   * Defaults to 60_000 bytes if not specified.
   */
  perFileBudgetBytes?: number;
  /**
   * Total byte budget for the focused diff package.
   * Defaults to 200_000 bytes if not specified.
   */
  totalBudgetBytes?: number;
  /**
   * Whether the PR is primarily a UI change.
   * When true, client component files are always-included (not summarised).
   * When false (default), client component files are summarised.
   */
  prIsPrimarilyUI?: boolean;
}

export interface ChangedFile {
  /** Relative file path from repo root */
  path: string;
  /** Full diff content for this file (as returned by git diff) */
  diffContent: string;
  /** Size of diffContent in bytes */
  sizeBytes: number;
  /**
   * Paths of test files that pair with this source file.
   * When a test file is paired with a changed source file, it is always-included;
   * otherwise it is summarised.
   */
  pairedTestPaths?: string[];
}

export type FileClass = 'always_included' | 'summarised' | 'omitted';

export interface ClassifiedFile {
  path: string;
  class: FileClass;
  /** Reason for classification (for manifest output) */
  reason: string;
  diffContent: string;
  sizeBytes: number;
}

export interface DiffPackage {
  /** The manifest + focused diff text to prepend to reviewer input */
  manifest: string;
  /** The concatenated diff content for always-included files */
  diff: string;
  /**
   * Paths of always-included files that were omitted due to budget pressure.
   * Non-empty means the coordinator should surface NEEDS_DISCUSSION.
   */
  omittedAlwaysIncluded: string[];
}

const DEFAULT_PER_FILE_BUDGET = 60_000;
const DEFAULT_TOTAL_BUDGET = 200_000;

/**
 * Simple glob-style pattern matching.
 * Supports ** (any path segments), * (any chars within a segment),
 * and literal path characters. Case-sensitive.
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  const normalised = filePath.replace(/\\/g, '/');
  const normPattern = pattern.replace(/\\/g, '/');
  // Build regex by splitting on ** first, then * within each segment
  const specialChars = /[.+^${}()|[\]\\]/g;
  const regexStr = normPattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((seg) => seg.replace(specialChars, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  const regex = new RegExp('^' + regexStr + '$');
  return regex.test(normalised);
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(filePath, p));
}

/** Determine if a file is a test file (conventional naming). */
function isTestFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return (
    p.includes('__tests__/') ||
    p.includes('.test.ts') ||
    p.includes('.test.tsx') ||
    p.includes('.spec.ts') ||
    p.includes('.spec.tsx')
  );
}

/** Determine if a file is generated / a lockfile / build artefact. */
function isGeneratedFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return (
    p === 'package-lock.json' ||
    p === 'yarn.lock' ||
    p === 'pnpm-lock.yaml' ||
    p.endsWith('.lock') ||
    p.startsWith('dist/') ||
    p.startsWith('build/') ||
    p.endsWith('.map')
  );
}

/** Determine if a file is a client-side UI component file. */
function isClientComponent(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return (
    p.startsWith('client/') ||
    p.includes('/components/') ||
    p.endsWith('.tsx') ||
    p.endsWith('.jsx')
  );
}

/**
 * Classify a single file per §3c priority rules.
 */
function classifyFile(
  file: ChangedFile,
  arch: ArchitectureExcerpt,
  allChangedPaths: Set<string>,
): { class: FileClass; reason: string } {
  const p = file.path;

  // Always-omitted: generated files and lockfiles
  if (isGeneratedFile(p)) {
    return { class: 'omitted', reason: 'generated/lockfile' };
  }

  // Always-included: spec and plan files if they appear in this PR
  if (arch.specAndPlanPaths.length > 0 && arch.specAndPlanPaths.includes(p)) {
    return { class: 'always_included', reason: 'spec/plan file' };
  }

  // Always-included: migration files
  const migrationPatternsWithDefaults = [
    'migrations/**',
    '*.sql',
    'prisma/migrations/**',
    ...arch.migrationPatterns,
  ];
  if (matchesAnyPattern(p, migrationPatternsWithDefaults)) {
    return { class: 'always_included', reason: 'migration file' };
  }

  // Always-included: schema/data-model files
  const schemaPatternsWithDefaults = [
    '**/schema/**',
    '**/db/schema/**',
    ...arch.schemaPatterns,
  ];
  if (matchesAnyPattern(p, schemaPatternsWithDefaults)) {
    return { class: 'always_included', reason: 'schema/data-model file' };
  }

  // Always-included: server route files
  const routePatternsWithDefaults = ['server/routes/**', ...arch.routePatterns];
  if (matchesAnyPattern(p, routePatternsWithDefaults)) {
    return { class: 'always_included', reason: 'server route file' };
  }

  // Always-included: worker/job files
  const workerPatternsWithDefaults = [
    'server/workers/**',
    '**/jobs/**',
    ...arch.workerPatterns,
  ];
  if (matchesAnyPattern(p, workerPatternsWithDefaults)) {
    return { class: 'always_included', reason: 'worker/job file' };
  }

  // Always-included: permission/auth files
  const permissionPatternsWithDefaults = [
    'server/services/permissionService.ts',
    'server/middleware/auth*',
    ...arch.permissionPatterns,
  ];
  if (matchesAnyPattern(p, permissionPatternsWithDefaults)) {
    return { class: 'always_included', reason: 'permission/auth file' };
  }

  // Always-included: gate scripts
  const gatePatternsWithDefaults = [
    'scripts/verify-*.sh',
    'scripts/gates/**',
    ...arch.gatePatterns,
  ];
  if (matchesAnyPattern(p, gatePatternsWithDefaults)) {
    return { class: 'always_included', reason: 'gate script' };
  }

  // Test files: always-included when paired, summarised when not paired
  if (isTestFile(p)) {
    const isPairedViaField =
      file.pairedTestPaths !== undefined && file.pairedTestPaths.length > 0;
    if (isPairedViaField) {
      return { class: 'always_included', reason: 'paired test file' };
    }
    // Check if there is a changed source file that would pair with this test
    const baseName = p
      .replace(/\.test\.(ts|tsx)$/, '')
      .replace(/\.spec\.(ts|tsx)$/, '');
    const hasPairedSource = Array.from(allChangedPaths).some(
      (other) =>
        other !== p &&
        !isTestFile(other) &&
        (other.replace(/\.(ts|tsx)$/, '') === baseName ||
          other === baseName + '.ts' ||
          other === baseName + '.tsx'),
    );
    if (hasPairedSource) {
      return { class: 'always_included', reason: 'paired test file' };
    }
    return { class: 'summarised', reason: 'unpaired test file' };
  }

  // Client component files: always-included when PR is primarily UI, else summarised
  if (isClientComponent(p)) {
    if (arch.prIsPrimarilyUI) {
      return { class: 'always_included', reason: 'UI component (primarily-UI PR)' };
    }
    return { class: 'summarised', reason: 'client component (non-UI PR)' };
  }

  // Pure documentation files when PR is primarily code
  if (p.endsWith('.md') || p.endsWith('.mdx') || p.endsWith('.rst')) {
    return { class: 'summarised', reason: 'documentation file' };
  }

  // Default: always-included for any other server/shared code
  return { class: 'always_included', reason: 'server/shared source file' };
}

/**
 * Build the focused diff package per §3c.
 *
 * @param changedFiles - list of changed files with their diff content
 * @param arch - architecture declarations from PROJECT_CONTEXT
 * @param baseRef - the resolved base ref used for the diff (included in manifest metadata)
 * @returns DiffPackage with manifest, focused diff, and omittedAlwaysIncluded list
 */
export function buildFocusedDiffPackage(
  changedFiles: ChangedFile[],
  arch: ArchitectureExcerpt,
  baseRef: string,
): DiffPackage {
  const perFileBudget = arch.perFileBudgetBytes ?? DEFAULT_PER_FILE_BUDGET;
  const totalBudget = arch.totalBudgetBytes ?? DEFAULT_TOTAL_BUDGET;
  const allPaths = new Set(changedFiles.map((f) => f.path));

  // Classify all files
  const classified: ClassifiedFile[] = changedFiles.map((f) => {
    const { class: cls, reason } = classifyFile(f, arch, allPaths);
    return {
      path: f.path,
      class: cls,
      reason,
      diffContent: f.diffContent,
      sizeBytes: f.sizeBytes,
    };
  });

  const alwaysIncluded = classified.filter((f) => f.class === 'always_included');
  const summarised = classified.filter((f) => f.class === 'summarised');
  const omitted = classified.filter((f) => f.class === 'omitted');

  // Apply budget pressure: track always-included files that cannot fit
  const omittedAlwaysIncluded: string[] = [];
  const includedInDiff: ClassifiedFile[] = [];
  let remainingBudget = totalBudget;

  for (const f of alwaysIncluded) {
    const fileSize = Math.min(f.sizeBytes, perFileBudget);
    if (remainingBudget - fileSize < 0) {
      omittedAlwaysIncluded.push(f.path);
    } else {
      includedInDiff.push(f);
      remainingBudget -= fileSize;
    }
  }

  // Build the diff content from always-included files (truncated per per-file budget)
  const diffParts: string[] = [];
  for (const f of includedInDiff) {
    if (f.sizeBytes <= perFileBudget) {
      diffParts.push(f.diffContent);
    } else {
      const truncated = f.diffContent.slice(0, perFileBudget);
      const omittedBytes = f.sizeBytes - perFileBudget;
      diffParts.push(
        truncated +
          '\n\n[TRUNCATED: file diff exceeded ' +
          perFileBudget.toString() +
          ' byte per-file budget; ' +
          omittedBytes.toString() +
          ' bytes omitted]',
      );
    }
  }

  const diff = diffParts.join('\n');

  // Build the manifest text
  const lines: string[] = [
    '## Diff Truncation Manifest',
    'Base ref: ' + baseRef,
    'Total files changed: ' + changedFiles.length.toString(),
    '',
    '### Always-included (' + includedInDiff.length.toString() + ' files)',
  ];

  for (const f of includedInDiff) {
    lines.push('- ' + f.path + '  [' + f.reason + ']  (' + f.sizeBytes.toString() + ' bytes)');
  }

  if (omittedAlwaysIncluded.length > 0) {
    lines.push('');
    lines.push(
      '### Always-included but OMITTED due to budget pressure (' +
        omittedAlwaysIncluded.length.toString() +
        ' files)',
    );
    lines.push(
      '> WARNING: coordinator must surface NEEDS_DISCUSSION -- reviewer did not see these files.',
    );
    for (const path of omittedAlwaysIncluded) {
      const f = alwaysIncluded.find((x) => x.path === path)!;
      lines.push('- ' + path + '  [' + f.reason + ']  (' + f.sizeBytes.toString() + ' bytes)');
    }
  }

  if (summarised.length > 0) {
    lines.push('');
    lines.push(
      '### Summarised (' +
        summarised.length.toString() +
        ' files -- file-level summary only, no hunks)',
    );
    for (const f of summarised) {
      lines.push('- ' + f.path + '  [' + f.reason + ']  (' + f.sizeBytes.toString() + ' bytes)');
    }
  }

  if (omitted.length > 0) {
    lines.push('');
    lines.push('### Omitted (' + omitted.length.toString() + ' files)');
    for (const f of omitted) {
      lines.push('- ' + f.path + '  [' + f.reason + ']  (' + f.sizeBytes.toString() + ' bytes)');
    }
  }

  const manifest = lines.join('\n');

  return { manifest, diff, omittedAlwaysIncluded };
}
