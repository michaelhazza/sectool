/**
 * src/ui/env.ts — resolved environment layer for the UI server (C5).
 *
 * resolveEnv() is a pure function over an injected EnvReader so tests can
 * drive it without process.env mutation. Production enforcement (fail-closed
 * startup check) is added in C2.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvReader } from '../fix/github.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');

export interface ResolvedEnv {
  dataDir: string;
  bindHost: string;
  allowedOrigin: string;
  isProduction: boolean;
  reportsDir: string;
  historyDir: string;
  configDir: string;
  /** Root of the working config clone: REPO_ROOT locally, /data/repo on fly.io.
   *  Config files live at configRepoDir/config/. */
  configRepoDir: string;
  /** Undefined when AUDIT_BASIC_AUTH_USER is not set. */
  authUser: string | undefined;
  /** Undefined when AUDIT_BASIC_AUTH_PASS is not set. */
  authPass: string | undefined;
}

/**
 * Thrown by assertProductionConfig when required production env vars are missing.
 * Lists every missing var in the message so operators can fix all at once.
 */
export class StartupConfigError extends Error {
  readonly kind = 'StartupConfigError' as const;
  constructor(missing: string[]) {
    super(
      `Production startup check failed. Missing required env vars: ${missing.join(', ')}. ` +
      'Set all required vars before starting in production.',
    );
    this.name = 'StartupConfigError';
  }
}

/**
 * Assert that all production-required env vars are set when isProduction is true.
 * Throws StartupConfigError listing EVERY missing var (not just the first).
 *
 * Inspects raw env values so that defaulted fields in resolvedEnv (e.g.
 * BIND_HOST defaults to 127.0.0.1) do not mask an unset production var.
 *
 * Required in production: AUDIT_BASIC_AUTH_USER, AUDIT_BASIC_AUTH_PASS,
 * ALLOWED_ORIGIN, BIND_HOST.
 */
export function assertProductionConfig(resolvedEnv: ResolvedEnv, env: EnvReader): void {
  if (!resolvedEnv.isProduction) return;

  const missing: string[] = [];

  if (!env('AUDIT_BASIC_AUTH_USER')) missing.push('AUDIT_BASIC_AUTH_USER');
  if (!env('AUDIT_BASIC_AUTH_PASS')) missing.push('AUDIT_BASIC_AUTH_PASS');
  if (!env('ALLOWED_ORIGIN')) missing.push('ALLOWED_ORIGIN');
  if (!env('BIND_HOST')) missing.push('BIND_HOST');

  if (missing.length > 0) {
    throw new StartupConfigError(missing);
  }
}

/**
 * Resolve the runtime environment for the UI server.
 *
 * Local defaults (no env vars set):
 *   dataDir       = REPO_ROOT
 *   bindHost      = 127.0.0.1
 *   allowedOrigin = http://127.0.0.1:<port>
 *
 * isProduction = true when FLY_APP_NAME is set OR REQUIRE_AUTH === 'true'.
 * Production required vars (BIND_HOST, ALLOWED_ORIGIN) are NOT enforced
 * here — that is C2's assertProductionConfig.
 */
export function resolveEnv(env: EnvReader, port: number): ResolvedEnv {
  const flyAppName = env('FLY_APP_NAME');
  const requireAuth = env('REQUIRE_AUTH');
  const isProduction = !!flyAppName || requireAuth === 'true';

  const dataDir = env('DATA_DIR') ?? REPO_ROOT;
  const bindHost = env('BIND_HOST') ?? '127.0.0.1';
  const allowedOrigin = env('ALLOWED_ORIGIN') ?? `http://127.0.0.1:${port}`;
  const authUser = env('AUDIT_BASIC_AUTH_USER') ?? undefined;
  const authPass = env('AUDIT_BASIC_AUTH_PASS') ?? undefined;

  // configRepoDir: root of the working config clone.
  // Explicit CONFIG_REPO_DIR wins; else /data/repo in production (FLY_APP_NAME set),
  // else REPO_ROOT locally — mirrors how DATA_DIR/dataDir is resolved.
  const configRepoDir = env('CONFIG_REPO_DIR') ?? (flyAppName ? '/data/repo' : REPO_ROOT);

  return {
    dataDir,
    bindHost,
    allowedOrigin,
    isProduction,
    reportsDir: resolve(dataDir, 'reports'),
    historyDir: resolve(dataDir, 'history'),
    configDir: resolve(configRepoDir, 'config'),
    configRepoDir,
    authUser,
    authPass,
  };
}

export type { EnvReader };
