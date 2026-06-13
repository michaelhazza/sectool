import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

// Run directly when invoked as a script
generateSchemas();
