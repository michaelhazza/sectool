import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';
import { FindingSchema } from './finding.js';
import { TargetRegistrySchema } from './targets.js';
import { AllowlistSchema } from './allowlist.js';
import { BaselineSchema } from './baseline.js';
import { TrendLineSchema } from './trend.js';
import { RunReportSchema } from './report.js';
import { FixesFileSchema } from './fix.js';

const schemas: Record<string, object> = {
  finding: z.toJSONSchema(FindingSchema),
  targets: z.toJSONSchema(TargetRegistrySchema),
  allowlist: z.toJSONSchema(AllowlistSchema),
  baseline: z.toJSONSchema(BaselineSchema),
  trend: z.toJSONSchema(TrendLineSchema),
  report: z.toJSONSchema(RunReportSchema),
  fix: z.toJSONSchema(FixesFileSchema),
};

export function generateSchemas(outDir: string = 'schemas'): void {
  mkdirSync(outDir, { recursive: true });
  for (const [name, schema] of Object.entries(schemas)) {
    const outPath = join(outDir, `${name}.schema.json`);
    writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n', 'utf-8');
  }
}

// Run only when invoked directly as a CLI script (e.g. `npm run schemas`),
// not when imported. Without this guard, any import of this module — including
// a test that imports `generateSchemas` — would write the default `schemas/*`
// files into the process cwd, dirtying the checkout and breaking test isolation.
if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  generateSchemas();
}
