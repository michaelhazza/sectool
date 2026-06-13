import { z } from 'zod';
import { FindingSchema, ScannerFamilySchema } from './finding.js';

const ScannerStatusStateSchema = z.enum(['complete', 'failed', 'skipped']);

const ScannerStatusEntrySchema = z.object({
  target: z.string().min(1),
  family: ScannerFamilySchema,
  state: ScannerStatusStateSchema,
});

const FailureEntrySchema = z.object({
  target: z.string().min(1),
  family: ScannerFamilySchema,
  reason: z.string().min(1),
});

const RunStatusSchema = z.enum(['success', 'partial', 'failed']);

const RunTargetSchema = z.object({
  kind: z.enum(['repo', 'staging']),
  name: z.string().min(1),
  commit: z.string().optional(),
  coverageGaps: z.array(z.string()),
});

const RunMetaSchema = z.object({
  status: RunStatusSchema,
  failures: z.array(FailureEntrySchema),
  scannerStatus: z.array(ScannerStatusEntrySchema),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  toolVersion: z.string().min(1),
});

export const RunReportSchema = z.object({
  runId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  findings: z.array(FindingSchema),
  targets: z.array(RunTargetSchema),
  meta: RunMetaSchema,
});

export type RunReport = z.infer<typeof RunReportSchema>;
export type RunTarget = z.infer<typeof RunTargetSchema>;
export type RunMeta = z.infer<typeof RunMetaSchema>;
export type ScannerStatusEntry = z.infer<typeof ScannerStatusEntrySchema>;
export type FailureEntry = z.infer<typeof FailureEntrySchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
