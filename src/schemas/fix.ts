import { z } from 'zod';

export const FixStatusSchema = z.enum([
  'requested',
  'in-progress',
  'awaiting-review',
  'merged-awaiting-verification',
  'verified-fixed',
  'reopened',
]);

export type FixStatus = z.infer<typeof FixStatusSchema>;

const FixEntrySchema = z.object({
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'fingerprint must be a 64-hex sha256'),
  ruleId: z.string().min(1),
  status: FixStatusSchema,
  issueUrl: z.string().url().optional(),
  filedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export const FixesFileSchema = z.record(
  z.string().regex(/^[0-9a-f]{64}$/),
  FixEntrySchema,
);

export type FixEntry = z.infer<typeof FixEntrySchema>;
export type FixesFile = z.infer<typeof FixesFileSchema>;
