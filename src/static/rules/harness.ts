/**
 * Shared ts-morph harness for the custom AST rule pack.
 *
 * Exports a factory that creates a ts-morph Project from a repo directory,
 * plus traversal utilities used by individual rules.
 */

import { Project, type SourceFile, type Node } from 'ts-morph';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Create a ts-morph Project for the given repo directory. */
export function createProject(repoDir: string): Project {
  const hasTsConfig = existsSync(join(repoDir, 'tsconfig.json'));
  return new Project({
    ...(hasTsConfig
      ? { tsConfigFilePath: join(repoDir, 'tsconfig.json') }
      // When no local tsconfig exists, supply explicit compilerOptions so
      // TypeScript does NOT walk up the directory tree and discover the
      // parent project's tsconfig (e.g. /app/tsconfig.json when scanning a
      // corpus fixture dir inside /app). Without this guard, ts-morph loads
      // ALL source files from the ancestor tsconfig and produces false
      // positives on corpus clean-fixture scans.
      : { compilerOptions: { strict: false, skipLibCheck: true } }),
    skipAddingFilesFromTsConfig: !hasTsConfig,
    skipFileDependencyResolution: true,
    useInMemoryFileSystem: false,
  });
}

/**
 * Add all TypeScript source files from `repoDir` to the project.
 * Skips `node_modules`, `dist`, `.git` directories.
 */
export function addSourceFiles(project: Project, repoDir: string): SourceFile[] {
  if (!existsSync(repoDir) || !existsSync(join(repoDir))) {
    return [];
  }
  project.addSourceFilesAtPaths([
    join(repoDir, '**/*.ts'),
    `!${join(repoDir, 'node_modules/**')}`,
    `!${join(repoDir, 'dist/**')}`,
    `!${join(repoDir, '.git/**')}`,
  ]);
  // Explicitly remove any source files that ended up outside repoDir.
  // This can happen when ts-morph discovers an ancestor tsconfig.json (e.g.
  // /app/tsconfig.json when scanning a corpus fixture subdir) and auto-adds
  // all files from that project. Removing out-of-scope files guarantees the
  // rule only analyses the target repo, preventing false positives on corpus
  // clean-fixture scans.
  const repoDirNorm = repoDir.endsWith('/') ? repoDir : `${repoDir}/`;
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (!fp.startsWith(repoDirNorm)) {
      project.removeSourceFile(sf);
    }
  }
  return project.getSourceFiles();
}

/**
 * Read all `.sql` migration files from a migrations directory.
 * Returns `{ filename, content }` pairs sorted by filename.
 */
export function readMigrationFiles(
  repoDir: string,
  migrationsDirs: string[] = ['migrations', 'drizzle', 'db/migrations'],
): Array<{ filename: string; content: string }> {
  const results: Array<{ filename: string; content: string }> = [];

  for (const relDir of migrationsDirs) {
    const absDir = join(repoDir, relDir);
    if (!existsSync(absDir)) continue;
    const entries = readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.sql')) {
        const content = readFileSync(join(absDir, entry.name), 'utf-8');
        results.push({ filename: entry.name, content });
      }
    }
  }

  results.sort((a, b) => a.filename.localeCompare(b.filename));
  return results;
}

/** Walk all descendant nodes of `node`, calling `visitor` on each. */
export function walkDescendants(node: Node, visitor: (n: Node) => void): void {
  node.forEachDescendant((n) => {
    visitor(n);
  });
}
