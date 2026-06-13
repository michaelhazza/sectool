import { z } from 'zod';
import { VulnClassSchema } from './finding.js';

const BaselineTargetSchema = z.union([
  z.object({ kind: z.literal('repo'), name: z.string().min(1) }),
  z.object({ kind: z.literal('staging'), host: z.string().min(1) }),
]);

const BaselineEntrySchema = z
  .object({
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'fingerprint must be a 64-hex sha256'),
    findingId: z
      .string()
      .regex(/^f-[0-9a-f]{16}$/, 'findingId must be "f-" + 16 hex chars')
      .optional(),
    ruleId: z.string().min(1),
    target: BaselineTargetSchema,
    locationKey: z.string().optional(),
    justification: z.string().min(1),
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry must be an ISO date (YYYY-MM-DD)'),
    approvedBy: z.string().min(1),
    vulnClass: VulnClassSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.findingId !== undefined) {
      const expected = `f-${val.fingerprint.slice(0, 16)}`;
      if (val.findingId !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `findingId must equal "f-" + fingerprint.slice(0, 16) — expected "${expected}", got "${val.findingId}"`,
        });
      }
    }
  });

export const BaselineSchema = z.object({
  entries: z.array(BaselineEntrySchema),
});

export type Baseline = z.infer<typeof BaselineSchema>;
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>;
