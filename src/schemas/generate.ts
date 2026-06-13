import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { FindingSchema } from './finding.js';
import { TargetRegistrySchema } from './targets.js';
import { AllowlistSchema } from './allowlist.js';
import { BaselineSchema } from './baseline.js';
import { TrendLineSchema } from './trend.js';
import { RunReportSchema } from './report.js';
import { FixesFileSchema } from './fix.js';

const schemas: Record<string, ReturnType<typeof zodToJsonSchema>> = {
  finding: zodToJsonSchema(FindingSchema, 'Finding'),
  targets: zodToJsonSchema(TargetRegistrySchema, 'TargetRegistry'),
  allowlist: zodToJsonSchema(AllowlistSchema, 'Allowlist'),
  baseline: zodToJsonSchema(BaselineSchema, 'Baseline'),
  trend: zodToJsonSchema(TrendLineSchema, 'TrendLine'),
  report: zodToJsonSchema(RunReportSchema, 'RunReport'),
  fix: zodToJsonSchema(FixesFileSchema, 'FixesFile'),
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
