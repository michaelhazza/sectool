import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AllowlistSchema } from '../schemas/allowlist.js';
import { TargetRegistrySchema } from '../schemas/targets.js';
import { BaselineSchema } from '../schemas/baseline.js';
import type { Baseline } from '../schemas/baseline.js';
import type { TargetRegistry } from '../schemas/targets.js';

const _moduleDir = dirname(fileURLToPath(import.meta.url));
const _repoRoot = join(_moduleDir, '..', '..');

const ALLOWLIST_PATH = join(_repoRoot, 'config', 'allowed-staging-hosts.json');
const TARGETS_PATH = join(_repoRoot, 'config', 'targets.json');
const BASELINE_PATH = join(_repoRoot, 'config', 'baseline.json');
const BENCHMARK_ALLOWLIST_PATH = join(_repoRoot, 'benchmark', 'allowlist.benchmark.json');

// Brand tag — not exported; LoadedAllowlist is only mintable inside this module.
// Using a type-only brand (no runtime overhead): we cast via `unknown` so the
// extra property never exists at runtime, preserving the structural subtype
// while making the type nominally distinct.
type Brand = { readonly __loadedAllowlist: true };

export type LoadedAllowlist = Brand & {
  readonly hosts: ReadonlyArray<{ host: string; owner: string; addedAt: string; note?: string | undefined }>;
};

function mintAllowlist(hosts: LoadedAllowlist['hosts']): LoadedAllowlist {
  return { hosts } as unknown as LoadedAllowlist;
}

// Structural-only schema for the benchmark allowlist: allows any string as host
// (the loopback restriction is enforced separately in loadBenchmarkAllowlist).
const BenchmarkAllowlistSchema = z.object({
  hosts: z.array(
    z.object({
      host: z.string().min(1),
      owner: z.string().min(1),
      addedAt: z.string().min(1),
      note: z.string().optional(),
    }),
  ),
});

function parseAllowlistFile(path: string): ReturnType<typeof AllowlistSchema.parse> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new ConfigError(`Failed to read allowlist at ${path}: ${String(err)}`);
  }
  const result = AllowlistSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid allowlist at ${path}: ${result.error.message}`);
  }
  return result.data;
}

function parseBenchmarkAllowlistFile(
  path: string,
): z.infer<typeof BenchmarkAllowlistSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new ConfigError(`Failed to read benchmark allowlist at ${path}: ${String(err)}`);
  }
  const result = BenchmarkAllowlistSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid benchmark allowlist at ${path}: ${result.error.message}`);
  }
  return result.data;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Loopback-only regex: exactly 127.0.0.1, localhost, or *.localhost
function isLoopbackHost(host: string): boolean {
  if (host === '127.0.0.1' || host === 'localhost') return true;
  if (host.endsWith('.localhost')) return true;
  return false;
}

/**
 * Production allowlist loader. Fixed path — no override.
 * Returns a branded LoadedAllowlist mintable only here.
 */
export function loadAllowlist(): LoadedAllowlist {
  const data = parseAllowlistFile(ALLOWLIST_PATH);
  return mintAllowlist(data.hosts);
}

/**
 * Benchmark allowlist loader. Fixed path — no override.
 * Schema-restricted: every host must be 127.0.0.1, localhost, or *.localhost.
 */
export function loadBenchmarkAllowlist(): LoadedAllowlist {
  const data = parseBenchmarkAllowlistFile(BENCHMARK_ALLOWLIST_PATH);
  for (const entry of data.hosts) {
    if (!isLoopbackHost(entry.host)) {
      throw new ConfigError(
        `Benchmark allowlist may only contain loopback hosts (127.0.0.1 / localhost / *.localhost); ` +
          `got: ${entry.host}`,
      );
    }
  }
  return mintAllowlist(data.hosts);
}

/**
 * Load and validate config/targets.json. Runs the enabled-target cross-check:
 * every enabled staging target's URL host must appear in the allowlist — this
 * is a config error, not a scan-time skip (§6.2).
 */
export function loadTargets(allowlist: LoadedAllowlist): TargetRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(TARGETS_PATH, 'utf-8'));
  } catch (err) {
    throw new ConfigError(`Failed to read targets at ${TARGETS_PATH}: ${String(err)}`);
  }
  const result = TargetRegistrySchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid targets config: ${result.error.message}`);
  }
  const registry = result.data;

  const allowedHosts = new Set(allowlist.hosts.map((e) => e.host));
  for (const target of registry.stagingTargets) {
    if (!target.enabled) continue;
    const host = new URL(target.url).hostname;
    if (!allowedHosts.has(host)) {
      throw new ConfigError(
        `Enabled staging target "${target.name}" has host "${host}" which is not on the allowlist. ` +
          `Add it to config/allowed-staging-hosts.json (PR-reviewed) before enabling.`,
      );
    }
  }

  return registry;
}

/**
 * Load and validate config/baseline.json.
 */
export function loadBaseline(): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (err) {
    throw new ConfigError(`Failed to read baseline at ${BASELINE_PATH}: ${String(err)}`);
  }
  const result = BaselineSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid baseline config: ${result.error.message}`);
  }
  return result.data;
}
