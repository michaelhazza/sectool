#!/usr/bin/env node
'use strict';

/**
 * Discover and run framework migrations.
 *
 * Each migration is a file under `<frameworkRoot>/migrations/v<MAJOR>.<MINOR>.<PATCH>.js`
 * that exports `async migrate(ctx)`. See `migrations/README.md` for the contract.
 *
 * Algorithm:
 *   1. Read consumer's .claude/.framework-state.json (fields: frameworkVersion, appliedMigrations[])
 *   2. Discover migrations/v*.js in framework root, sort by semver ascending
 *   3. Filter to: version > fromVersion && version <= toVersion && !appliedMigrations.includes(version)
 *   4. Run each in order, capturing result
 *   5. On `applied` or `skipped`, append the version ID to appliedMigrations and persist
 *      after EACH migration so a mid-flight failure doesn't re-run already-applied migrations.
 *      On `conflict`, DO NOT record — operator must resolve and the migration re-runs on next pass.
 *   6. On throw, stop and propagate.
 *
 * Invocation:
 *   node scripts/run-migrations.js <consumerRoot> <fromVersion> <toVersion>
 *   node scripts/run-migrations.js --help
 *
 * Output:
 *   Per-migration line to stdout: `MIGRATION v<version> status=<applied|skipped|conflict>`
 *   Per-note line indented: `  note=<text>`
 *   End-of-run summary: `MIGRATIONS: <applied> applied, <skipped> skipped, <conflict> conflict, time=<sec>s`
 *   Exit 0 on full success (or no migrations to run), 1 on any thrown error.
 *   `conflict` status counts as ran-but-incomplete — the migration ran, reported a non-destructive
 *   conflict, and is intentionally NOT recorded so the next /claudeupdate retries it after the
 *   operator resolves the underlying conflict (e.g. merged a .framework-new file).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function parseSemver(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareSemver(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`invalid semver: ${a} or ${b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function discoverMigrations(frameworkRoot) {
  const dir = path.join(frameworkRoot, 'migrations');
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const m = e.match(/^v(\d+\.\d+\.\d+)\.js$/);
    if (!m) continue;
    out.push({ version: m[1], file: path.join(dir, e) });
  }
  out.sort((a, b) => compareSemver(a.version, b.version));
  return out;
}

function readState(consumerRoot) {
  const p = path.join(consumerRoot, '.claude', '.framework-state.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function writeStateAtomic(consumerRoot, state) {
  const dir = path.join(consumerRoot, '.claude');
  const finalPath = path.join(dir, '.framework-state.json');
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fsp.rename(tmpPath, finalPath);
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/run-migrations.js <consumerRoot> <fromVersion> <toVersion>\n' +
    '\n' +
    '  consumerRoot   Absolute path to the consuming repo root\n' +
    '  fromVersion    Semver of the framework BEFORE this update\n' +
    '  toVersion      Semver of the framework AFTER this update\n' +
    '\n' +
    'Runs each migrations/v<X>.js file in semver order, where fromVersion < X <= toVersion\n' +
    'and X has not already been recorded in state.appliedMigrations[].\n'
  );
}

async function run(consumerRoot, fromVersion, toVersion) {
  const frameworkRoot = path.resolve(__dirname, '..');

  if (!parseSemver(fromVersion)) throw new Error(`fromVersion is not valid semver: "${fromVersion}"`);
  if (!parseSemver(toVersion)) throw new Error(`toVersion is not valid semver: "${toVersion}"`);
  if (compareSemver(fromVersion, toVersion) > 0) {
    throw new Error(`fromVersion (${fromVersion}) > toVersion (${toVersion}); downgrades are not supported`);
  }

  let state = readState(consumerRoot);
  if (!state) {
    process.stdout.write(`MIGRATIONS: no .framework-state.json at ${consumerRoot} — skipping migrations (run sync.js --adopt first).\n`);
    return { applied: 0, skipped: 0, conflict: 0 };
  }
  if (!Array.isArray(state.appliedMigrations)) state.appliedMigrations = [];

  const discovered = discoverMigrations(frameworkRoot);
  const pending = discovered.filter(m => {
    if (compareSemver(m.version, fromVersion) <= 0) return false;
    if (compareSemver(m.version, toVersion) > 0) return false;
    if (state.appliedMigrations.includes(m.version)) return false;
    return true;
  });

  if (pending.length === 0) {
    process.stdout.write(`MIGRATIONS: no pending migrations in range (${fromVersion}, ${toVersion}].\n`);
    return { applied: 0, skipped: 0, conflict: 0 };
  }

  const t0 = Date.now();
  let appliedCount = 0, skippedCount = 0, conflictCount = 0;

  for (const m of pending) {
    process.stdout.write(`MIGRATION v${m.version} running...\n`);
    let mod;
    try {
      mod = require(m.file);
    } catch (err) {
      process.stderr.write(`ERROR: failed to load migration v${m.version}: ${err.message}\n`);
      throw err;
    }
    if (typeof mod.migrate !== 'function') {
      throw new Error(`migration v${m.version} does not export migrate(ctx)`);
    }
    const ctx = { consumerRoot, frameworkRoot, fromVersion, toVersion: m.version };
    let result;
    try {
      result = await mod.migrate(ctx);
    } catch (err) {
      process.stderr.write(`ERROR: migration v${m.version} threw: ${err.stack || err.message}\n`);
      throw err;
    }
    if (!result || typeof result !== 'object' || !result.status) {
      throw new Error(`migration v${m.version} returned malformed result (expected { status, notes[] })`);
    }
    if (!['applied', 'skipped', 'conflict'].includes(result.status)) {
      throw new Error(`migration v${m.version} returned invalid status: ${result.status}`);
    }

    process.stdout.write(`MIGRATION v${m.version} status=${result.status}\n`);
    for (const n of (result.notes || [])) {
      process.stdout.write(`  note=${n}\n`);
    }

    if (result.status === 'applied') appliedCount++;
    else if (result.status === 'skipped') skippedCount++;
    else if (result.status === 'conflict') conflictCount++;

    // Only `applied` and `skipped` count as truly done. `conflict` means the migration
    // ran, found local state requiring operator action, and did NOT complete — leaving
    // it unrecorded forces a re-run on the next /claudeupdate after the operator
    // resolves the underlying conflict (e.g. by merging the .framework-new file sync.js
    // produced for the divergent local copy). Persist after each completed migration so
    // a later failure cannot re-run earlier ones.
    if (result.status === 'applied' || result.status === 'skipped') {
      state = readState(consumerRoot) || state;
      if (!Array.isArray(state.appliedMigrations)) state.appliedMigrations = [];
      if (!state.appliedMigrations.includes(m.version)) {
        state.appliedMigrations.push(m.version);
        await writeStateAtomic(consumerRoot, state);
      }
    }
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(
    `MIGRATIONS: ${appliedCount} applied, ${skippedCount} skipped, ${conflictCount} conflict, time=${elapsedSec}s\n`
  );
  return { applied: appliedCount, skipped: skippedCount, conflict: conflictCount };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  if (argv.length !== 3) {
    process.stderr.write(`ERROR: expected 3 args (consumerRoot, fromVersion, toVersion); got ${argv.length}\n`);
    printHelp();
    process.exit(1);
  }
  const [consumerRoot, fromVersion, toVersion] = argv;
  const absRoot = path.resolve(consumerRoot);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    process.stderr.write(`ERROR: consumerRoot does not exist or is not a directory: ${absRoot}\n`);
    process.exit(1);
  }
  await run(absRoot, fromVersion, toVersion);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`ERROR: ${err?.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { run, discoverMigrations, compareSemver, parseSemver };
