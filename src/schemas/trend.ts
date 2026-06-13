import { z } from 'zod';
import { SeveritySchema } from './finding.js';

const TargetTrendSchema = z.object({
  status: z.enum(['complete', 'unknown']),
  new: z.number().int().nonnegative(),
  fixed: z.number().int().nonnegative(),
  persisting: z.number().int().nonnegative(),
  bySeverity: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
  }),
});

export const TrendLineSchema = z.object({
  runId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  targets: z.record(z.string(), TargetTrendSchema),
});

export const TrendHistorySchema = z.array(TrendLineSchema);

export type TrendLine = z.infer<typeof TrendLineSchema>;
export type TrendHistory = z.infer<typeof TrendHistorySchema>;
export type TargetTrend = z.infer<typeof TargetTrendSchema>;

// Re-export for convenience — severity enum is used by trend readers
export { SeveritySchema };
