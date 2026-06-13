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
  return new Project({
    tsConfigFilePath: existsSync(join(repoDir, 'tsconfig.json'))
      ? join(repoDir, 'tsconfig.json')
      : undefined,
    addFilesFromTsConfig: existsSync(join(repoDir, 'tsconfig.json')),
    skipAddingFilesFromTsConfig: !existsSync(join(repoDir, 'tsconfig.json')),
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
