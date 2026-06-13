import { z } from 'zod';

export const VulnClassSchema = z.enum([
  'injection',
  'auth-access-control',
  'tenant-isolation',
  'secrets',
  'dependency-cve',
  'misconfiguration',
  'xss',
  'csrf',
  'open-redirect',
  'info-disclosure',
  'tls',
  'session-management',
]);

export type VulnClass = z.infer<typeof VulnClassSchema>;

export const ScannerFamilySchema = z.enum([
  'ast',
  'semgrep',
  'gitleaks',
  'osv',
  'zap',
  'nuclei',
  'probe',
]);

export type ScannerFamily = z.infer<typeof ScannerFamilySchema>;

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

export type Severity = z.infer<typeof SeveritySchema>;

export const ConfidenceSchema = z.enum(['confirmed', 'probable', 'tentative']);

export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ReachabilitySchema = z.enum([
  'unauthenticated',
  'authenticated',
  'admin',
  'unknown',
]);

export type Reachability = z.infer<typeof ReachabilitySchema>;

const StaticTargetSchema = z.object({
  kind: z.literal('repo'),
  name: z.string().min(1),
  commit: z.string().optional(),
});

const LiveTargetSchema = z.object({
  kind: z.literal('staging'),
  host: z.string().min(1),
});

const TargetSchema = z.discriminatedUnion('kind', [
  StaticTargetSchema,
  LiveTargetSchema,
]);

const StaticLocationSchema = z.object({
  path: z.string().min(1),
  symbol: z.string().min(1),
  startLine: z.number().int().nonnegative().optional(),
});

const LiveLocationSchema = z.object({
  url: z.string().url(),
  parameter: z.string().optional(),
  method: z.string().min(1),
});

const SuppressionSchema = z.object({
  justification: z.string().min(1),
  approvedBy: z.string().min(1),
  expiry: z.string().min(1),
});

const EvidenceSchema = z.object({
  snippet: z.string().optional(),
  cvss: z.number().nullable(),
  raw: z.record(z.unknown()),
});

const FindingBaseSchema = z.object({
  id: z.string().regex(/^f-[0-9a-f]{16}$/, 'id must be "f-" + first 16 hex of fingerprint'),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'fingerprint must be a 64-hex sha256'),
  ruleId: z.string().min(1),
  source: ScannerFamilySchema,
  surface: z.enum(['static', 'live']),
  vulnClass: VulnClassSchema,
  severity: SeveritySchema,
  baseSeverity: SeveritySchema,
  confidence: ConfidenceSchema,
  evidence: EvidenceSchema,
  reachability: ReachabilitySchema,
  correlatedWith: z.array(z.string()),
  docs: z.string().optional(),
  externalRefs: z.array(z.string().url()),
  firstSeen: z.string().datetime(),
  suppressed: z.boolean(),
  suppression: SuppressionSchema.nullable(),
  note: z.string().nullable(),
});

const StaticFindingSchema = FindingBaseSchema.extend({
  target: StaticTargetSchema,
  location: StaticLocationSchema,
});

const LiveFindingSchema = FindingBaseSchema.extend({
  target: LiveTargetSchema,
  location: LiveLocationSchema,
});

export const FindingSchema = z.discriminatedUnion('surface', [
  StaticFindingSchema.extend({ surface: z.literal('static') }),
  LiveFindingSchema.extend({ surface: z.literal('live') }),
]).superRefine((val, ctx) => {
  if (val.id !== `f-${val.fingerprint.slice(0, 16)}`) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'id must equal "f-" + fingerprint.slice(0, 16)',
    });
  }
});

export type Finding = z.infer<typeof FindingSchema>;
export type StaticFinding = z.infer<typeof StaticFindingSchema>;
export type LiveFinding = z.infer<typeof LiveFindingSchema>;
