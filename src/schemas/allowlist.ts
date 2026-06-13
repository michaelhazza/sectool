import { z } from 'zod';

function isDnsName(host: string): boolean {
  if (host.length === 0) return false;

  // Reject IP literals — dotted-decimal IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;

  // Reject Node-accepted numeric/octal/hex IPv4 forms (single integer)
  if (/^(0x[0-9a-fA-F]+|\d+)$/.test(host)) return false;

  // Reject bracketed IPv6
  if (/^\[.*\]$/.test(host)) return false;

  // Reject wildcards (e.g. *.example.com)
  if (host.includes('*')) return false;

  // Reject CIDR (e.g. 192.168.0.0/24)
  if (host.includes('/')) return false;

  // Reject host:port (colon not allowed in a bare hostname)
  if (host.includes(':')) return false;

  // Must be a valid DNS label sequence
  const dnsLabelRe = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const labels = host.split('.');
  if (labels.length === 0) return false;
  for (const label of labels) {
    if (!label || !dnsLabelRe.test(label)) return false;
  }

  return true;
}

const AllowlistEntrySchema = z
  .object({
    host: z.string().min(1),
    owner: z.string().min(1),
    addedAt: z.string().min(1),
    note: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (!isDnsName(val.host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'host must be a DNS name — no wildcards, CIDR, port suffixes, or IP literals',
      });
    }
  });

export const AllowlistSchema = z.object({
  hosts: z.array(AllowlistEntrySchema),
});

export type Allowlist = z.infer<typeof AllowlistSchema>;
export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;
