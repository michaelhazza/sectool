import { z } from 'zod';

const StackTagSchema = z.enum([
  'express',
  'drizzle-rls',
  'jwt',
  'react',
  'socket.io',
  'multer',
  's3',
  'pg-boss',
  'zod',
]);

const RepoSchema = z.object({
  name: z.string().min(1),
  gitUrl: z.string().url(),
  localPath: z.string().nullable(),
  stackTags: z.array(StackTagSchema),
  publicRoutes: z.array(z.string()),
  enabled: z.boolean(),
});

const TestUserSchema = z.object({
  userEnv: z.string().min(1),
  passEnv: z.string().min(1),
});

const SuccessCheckSchema = z.object({
  statusIn: z.array(z.number().int().min(100).max(599)).min(1),
  jsonHasKey: z.string().optional(),
});

const AuthFormSchema = z.object({
  kind: z.literal('form'),
  loginPath: z.string().min(1),
  method: z.string().min(1).default('POST'),
  userField: z.string().min(1),
  passField: z.string().min(1),
  bodyType: z.enum(['json', 'form-urlencoded']),
  sessionCarrier: z.enum(['cookie', 'bearer']),
  successCheck: SuccessCheckSchema,
  testUsers: z.array(TestUserSchema).min(1),
});

const StagingTargetSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    repo: z.string().min(1),
    activeScan: z.boolean().default(false),
    auth: AuthFormSchema.optional(),
    rateLimitRps: z.number().int().min(1).max(25).default(10),
    enabled: z.boolean(),
  })
  .superRefine((val, ctx) => {
    if (val.activeScan) {
      if (!val.auth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'auth is required when activeScan is true',
        });
        return;
      }
      if (val.auth.testUsers.length !== 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'testUsers must have exactly 2 entries when activeScan is true',
        });
      }
    } else if (val.auth) {
      if (val.auth.testUsers.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'testUsers must have at least 1 entry when auth is present',
        });
      }
    }

    if (val.auth) {
      const { sessionCarrier, successCheck } = val.auth;
      if (sessionCarrier === 'bearer' && !successCheck.jsonHasKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'successCheck.jsonHasKey is required when sessionCarrier is "bearer"',
        });
      }
    }
  });

export const TargetRegistrySchema = z.object({
  repos: z.array(RepoSchema),
  stagingTargets: z.array(StagingTargetSchema),
});

export type TargetRegistry = z.infer<typeof TargetRegistrySchema>;
export type StagingTarget = z.infer<typeof StagingTargetSchema>;
export type RepoTarget = z.infer<typeof RepoSchema>;
export type AuthForm = z.infer<typeof AuthFormSchema>;
export type TestUser = z.infer<typeof TestUserSchema>;
