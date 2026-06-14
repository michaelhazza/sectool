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

  return {
    dataDir,
    bindHost,
    allowedOrigin,
    isProduction,
    reportsDir: resolve(dataDir, 'reports'),
    historyDir: resolve(dataDir, 'history'),
    configDir: resolve(REPO_ROOT, 'config'),
  };
}

export type { EnvReader };
