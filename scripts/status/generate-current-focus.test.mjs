/**
 * generate-current-focus.test.mjs
 *
 * Vitest self-test for scripts/status/generate-current-focus.mjs. Spawns the
 * real generator as a child process against isolated temp-dir fixtures — no
 * committed fixture tree (spec §14: "Fixtures are constructed in temp dirs
 * at test time"). Also validates the spec §8.1 example instance against
 * schemas/build-status.schema.json with ajv.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.join(HERE, 'generate-current-focus.mjs');
const SCHEMA_PATH = path.resolve(HERE, '..', '..', 'schemas', 'build-status.schema.json');
const BEGIN_MARKER = '<!-- STATUS:GENERATED:BEGIN -->';
const END_MARKER = '<!-- STATUS:GENERATED:END -->';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `generate-current-focus-${crypto.randomUUID()}-`));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Baseline valid, active status.json record. Callers override fields. */
function baseRecord(slug, overrides = {}) {
  return {
    contract_version: 'build-status.v2',
    slug,
    title: `Title for ${slug}`,
    classification: 'Standard',
    phase: 'build',
    status: 'BUILDING',
    branch: `branch-${slug}`,
    pr: null,
    gates: { s0: 'pass' },
    gate_evidence: {},
    blockers: [],
    summary: `Summary for ${slug}`,
    updated_at: '2026-07-28T00:00:00Z',
    updated_by: 'builder',
    ...overrides,
  };
}

/** Writes tasks/builds/<slug>/status.json with raw text (already-serialised
 *  string, so invalid-JSON fixtures can be authored directly). */
function writeStatusRaw(root, slug, rawText) {
  const dir = path.join(root, 'tasks', 'builds', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), rawText, 'utf8');
}

function writeStatus(root, slug, overrides = {}) {
  writeStatusRaw(root, slug, JSON.stringify(baseRecord(slug, overrides), null, 2));
}

function writeCurrentFocus(root, content) {
  const dir = path.join(root, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'current-focus.md'), content, 'utf8');
}

function readCurrentFocus(root) {
  return fs.readFileSync(path.join(root, 'tasks', 'current-focus.md'), 'utf8');
}

function runGenerator(root) {
  const res = spawnSync(process.execPath, [GENERATOR, '--root', root], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** Every `build_slug: <slug>` line in file order — the exact line format the
 *  phase-lock hook (C9) reads from inside the marker region. */
function buildSlugLines(text) {
  return [...text.matchAll(/^build_slug: (.+)$/gm)].map((m) => m[1]);
}

describe('build-status.schema.json', () => {
  it('spec §8.1 example instance validates', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const exampleInstance = {
      contract_version: 'build-status.v2',
      slug: 'dev-pipeline-v2',
      title: 'Development Pipeline v2',
      classification: 'Major',
      phase: 'spec',
      status: 'PLANNING',
      branch: 'claude/personal-ai-agent-system-1mqzyh',
      pr: null,
      gates: { s0: 'pass', duplication_check: 'proceed', g5: null, verify: null, merge_gate: null },
      gate_evidence: {
        s0: { sha: 'ee629f849', run_ids: [], url: null, completed_at: '2026-07-26T00:00:00Z' },
      },
      blockers: [],
      summary: 'Phase 1 in flight; spec under review tiers.',
      updated_at: '2026-07-26T00:00:00Z',
      updated_by: 'spec-coordinator',
    };

    const valid = validate(exampleInstance);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('generate-current-focus.mjs', () => {
  it('absent markers + legacy mission-control comment: markers inserted below it, legacy block byte-preserved', () => {
    const root = makeTempRoot();
    try {
      const legacyBlock =
        '<!-- mission-control\n' +
        'build_slug: legacy-slug\n' +
        'status: PLANNING\n' +
        '-->\n';
      const prose = '\n# Current Focus\n\nSome prose stays here.\n';
      writeCurrentFocus(root, legacyBlock + prose);
      writeStatus(root, 'active-one', { status: 'BUILDING' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out.startsWith(legacyBlock)).toBe(true);
      const beginIdx = out.indexOf(BEGIN_MARKER);
      const endIdx = out.indexOf(END_MARKER);
      expect(beginIdx).toBeGreaterThan(legacyBlock.length - 1);
      expect(endIdx).toBeGreaterThan(beginIdx);
      // Everything after the generated block is byte-identical to the original prose.
      expect(out.slice(out.indexOf(END_MARKER) + END_MARKER.length + 1)).toBe(prose);
      expect(out).toContain('build_slug: legacy-slug');
      expect(out).toContain('build_slug: active-one');
    } finally {
      rmrf(root);
    }
  });

  it('duplicate markers: non-zero exit, file unchanged', () => {
    const root = makeTempRoot();
    try {
      const original =
        `${BEGIN_MARKER}\nold content 1\n${END_MARKER}\n` +
        `${BEGIN_MARKER}\nold content 2\n${END_MARKER}\n`;
      writeCurrentFocus(root, original);
      writeStatus(root, 'active-one');

      const r = runGenerator(root);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/markers/i);
      expect(readCurrentFocus(root)).toBe(original);
    } finally {
      rmrf(root);
    }
  });

  it('invalid JSON status.json: INVALID line inside the block, exit 0, other builds still listed', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'good-build');
      writeStatusRaw(root, 'bad-build', '{ not valid json');

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).toMatch(/INVALID: bad-build — invalid JSON:/);
      expect(out).toContain('build_slug: good-build');
    } finally {
      rmrf(root);
    }
  });

  it('slug !== directory: exact INVALID wording', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'dir-a', { slug: 'different-slug' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).toContain('INVALID: dir-a — slug different-slug does not match directory dir-a');
    } finally {
      rmrf(root);
    }
  });

  it('ordering: status priority, then updated_at desc, then slug asc; terminal builds excluded', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'a-planning', { status: 'PLANNING', updated_at: '2026-07-20T00:00:00Z' });
      writeStatus(root, 'b-building', { status: 'BUILDING', updated_at: '2026-07-25T00:00:00Z' });
      writeStatus(root, 'c-building', { status: 'BUILDING', updated_at: '2026-07-25T00:00:00Z' });
      writeStatus(root, 'd-reviewing', { status: 'REVIEWING', updated_at: '2026-07-22T00:00:00Z' });
      writeStatus(root, 'e-mergeready', { status: 'MERGE_READY', updated_at: '2026-07-21T00:00:00Z' });
      writeStatus(root, 'f-merged', { status: 'MERGED', updated_at: '2026-07-27T00:00:00Z' });
      writeStatus(root, 'g-abandoned', { status: 'ABANDONED', updated_at: '2026-07-27T00:00:00Z' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).not.toContain('f-merged');
      expect(out).not.toContain('g-abandoned');

      const slugs = buildSlugLines(out);
      expect(slugs).toEqual(['e-mergeready', 'd-reviewing', 'b-building', 'c-building', 'a-planning']);
    } finally {
      rmrf(root);
    }
  });

  it('idempotence: second run over its own output is byte-identical', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'active-one', { status: 'BUILDING' });
      writeStatus(root, 'active-two', { status: 'REVIEWING' });

      const first = runGenerator(root);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const afterFirst = readCurrentFocus(root);

      const second = runGenerator(root);
      expect(second.status, second.stdout + second.stderr).toBe(0);
      const afterSecond = readCurrentFocus(root);

      expect(afterSecond).toBe(afterFirst);
    } finally {
      rmrf(root);
    }
  });

  it('atomicity smoke: no *.tmp residue after a failing (duplicate-markers) run', () => {
    const root = makeTempRoot();
    try {
      const original = `${BEGIN_MARKER}\nold\n${END_MARKER}\n${BEGIN_MARKER}\nold2\n${END_MARKER}\n`;
      writeCurrentFocus(root, original);
      writeStatus(root, 'active-one');

      const r = runGenerator(root);
      expect(r.status).not.toBe(0);

      const tasksDirEntries = fs.readdirSync(path.join(root, 'tasks'));
      const tmpResidue = tasksDirEntries.filter((name) => name.includes('.tmp'));
      expect(tmpResidue).toEqual([]);
    } finally {
      rmrf(root);
    }
  });

  // Regression: pr-reviewer PR-001, 2026-07-28 (reproduced destructive bug).
  // The replace branch re-derived both boundaries with unchecked indexOf
  // calls. With the marker pair on ONE line, indexOf('\n', begin) + 1 was 0,
  // `before` collapsed to '', and every byte above the block was deleted --
  // while the script printed success and exited 0. The pre-existing
  // idempotence test could not catch it because it only ever re-ran over the
  // generator's OWN output, where BEGIN always sits alone on its line.
  it('marker pair sharing one line: content above AND below is byte-preserved', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'alpha');
      writeCurrentFocus(
        root,
        `# Current Focus\n\nOperator preamble that must survive.\n\n${BEGIN_MARKER}${END_MARKER}\n\n## Operator notes\n\nkeep me\n`
      );

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const after = readCurrentFocus(root);
      expect(after).toContain('# Current Focus');
      expect(after).toContain('Operator preamble that must survive.');
      expect(after).toContain('## Operator notes');
      expect(after).toContain('keep me');
      expect(after).toContain('alpha');
      // Exactly one marker pair survives — no duplication of the block.
      expect(after.split(BEGIN_MARKER).length - 1).toBe(1);
      expect(after.split(END_MARKER).length - 1).toBe(1);
    } finally {
      rmrf(root);
    }
  });

  // Regression: pr-reviewer PR-002, 2026-07-28. main() ran at module scope
  // with --root defaulting to cwd, so importing the module rewrote
  // tasks/current-focus.md in whatever repo the importer happened to be in.
  // That already fired once against the framework's own file during a probe.
  it('importing the module does not write anything (entry-point guard)', () => {
    const root = makeTempRoot();
    try {
      const seeded = `# Current Focus\n\nuntouched by import\n`;
      writeCurrentFocus(root, seeded);
      writeStatus(root, 'alpha');

      const importUrl = new URL(`file://${GENERATOR.split(path.sep).join('/')}`).href;
      const res = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(importUrl)})`], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60000,
      });
      expect(res.status, res.stdout + res.stderr).toBe(0);
      expect(readCurrentFocus(root)).toBe(seeded);
    } finally {
      rmrf(root);
    }
  });

  // Added 2026-07-28 (dual-reviewer). Only the file being READ was marker-
  // validated; the text being WRITTEN never was. buildBody() emits operator-
  // authored free text plus the whole raw record, so a status.json field
  // holding the literal marker string wrote a file with a duplicated marker,
  // exited 0, and then made every LATER run hit the malformed-marker refusal —
  // a permanent, hand-repair-only brick of the file the phase-lock hook and
  // the coordinators read.
  describe('generated content cannot brick the file it writes', () => {
    it('refuses when a status field carries the END marker, instead of writing it', () => {
      const root = makeTempRoot();
      try {
        writeCurrentFocus(root, `# Current Focus\n\noperator prose\n`);
        writeStatus(root, 'alpha', { summary: `sneaky ${END_MARKER} text` });

        const res = runGenerator(root);
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/marker text/);
        // Untouched: the refusal happens before the write, not after.
        expect(readCurrentFocus(root)).toBe(`# Current Focus\n\noperator prose\n`);
      } finally {
        rmrf(root);
      }
    });

    it('refuses on the BEGIN marker too, and leaves an existing generated block intact', () => {
      const root = makeTempRoot();
      try {
        const seeded = `# Current Focus\n\n${BEGIN_MARKER}\nprior generated body\n${END_MARKER}\n\ntail prose\n`;
        writeCurrentFocus(root, seeded);
        writeStatus(root, 'alpha', { title: `Title with ${BEGIN_MARKER} in it` });

        const res = runGenerator(root);
        expect(res.status).not.toBe(0);
        expect(readCurrentFocus(root)).toBe(seeded);
      } finally {
        rmrf(root);
      }
    });

    it('still writes normally when no field carries marker text', () => {
      const root = makeTempRoot();
      try {
        writeCurrentFocus(root, `# Current Focus\n\noperator prose\n`);
        writeStatus(root, 'alpha', { summary: 'an ordinary summary' });

        const res = runGenerator(root);
        expect(res.status, res.stdout + res.stderr).toBe(0);
        expect(buildSlugLines(readCurrentFocus(root))).toEqual(['alpha']);
      } finally {
        rmrf(root);
      }
    });
  });
});

// Regression: Codex review, 2026-07-28. Terminal and UNRECOGNISED statuses
// shared one bare `continue`, so a typo'd or future-enum status vanished from
// the generated block entirely — despite this module documenting a fail-loud
// INVALID channel for schema problems, and a status outside the schema enum
// being exactly that.
describe('unrecognised vs terminal status', () => {
  it('a typo status surfaces in the INVALID channel instead of vanishing', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'healthy');
      writeStatus(root, 'typo-build', { status: 'REVIEWNG' });   // missing I

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);   // still exit 0 — recorded, not fatal

      const out = readCurrentFocus(root);
      expect(out).toContain('healthy');                 // healthy build unaffected
      expect(out).toMatch(/INVALID: typo-build/);
      expect(out).toMatch(/unrecognised status/);
      expect(out).toContain('REVIEWNG');                // names the offending value
    } finally {
      rmrf(root);
    }
  });

  it('MERGED and ABANDONED are excluded SILENTLY — they are not invalid', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'active-one');
      writeStatus(root, 'done-one', { status: 'MERGED' });
      writeStatus(root, 'dropped-one', { status: 'ABANDONED' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).toContain('active-one');
      expect(out).not.toMatch(/INVALID: done-one/);
      expect(out).not.toMatch(/INVALID: dropped-one/);
    } finally {
      rmrf(root);
    }
  });
});

// Regression: external review, 2026-07-29 (and pr-reviewer PR-012 before it).
// A record with every required KEY but a malformed VALUE passed the presence
// check and crashed buildBody on `record.blockers.length` — the run exited
// non-zero and wrote NOTHING, so one bad build directory silently took every
// healthy build's status down with it. Malformed values now take the
// documented INVALID channel and the run completes.
describe('key-complete but malformed records take the INVALID channel', () => {
  it('blockers: null does not crash the run — the reported bug', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'healthy');
      writeStatus(root, 'bad-blockers', { blockers: null });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);   // completes, never aborts

      const out = readCurrentFocus(root);
      expect(out).toContain('healthy');                 // healthy builds survive
      expect(out).toMatch(/INVALID: bad-blockers/);
    } finally {
      rmrf(root);
    }
  });

  // Regression: external review round 2. The terminal check `continue`d BEFORE
  // validation, so a MERGED/ABANDONED record carrying schema-invalid data
  // vanished silently — neither rendered nor surfaced — purely because its
  // status was terminal. Validation now precedes classification.
  it('a MERGED record with invalid data is INVALID, not silently discarded', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'healthy');
      writeStatus(root, 'bad-merged', { status: 'MERGED', blockers: null, phase: 'not-a-phase' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).toContain('healthy');
      expect(out).toMatch(/INVALID: bad-merged/);
    } finally {
      rmrf(root);
    }
  });

  it('an ABANDONED record with invalid data is INVALID too', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'healthy');
      writeStatus(root, 'bad-abandoned', { status: 'ABANDONED', blockers: null });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readCurrentFocus(root)).toMatch(/INVALID: bad-abandoned/);
    } finally {
      rmrf(root);
    }
  });

  it('a VALID terminal record is still excluded SILENTLY (the distinction holds)', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'healthy');
      writeStatus(root, 'clean-merged', { status: 'MERGED' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).toContain('healthy');
      expect(out).not.toMatch(/INVALID: clean-merged/);
      expect(out).not.toMatch(/clean-merged/);
    } finally {
      rmrf(root);
    }
  });

  it('a non-string summary and a bogus phase are also INVALID, not fatal', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'healthy');
      writeStatus(root, 'bad-summary', { summary: 42 });
      writeStatus(root, 'bad-phase', { phase: 'not-a-real-phase' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).toContain('healthy');
      expect(out).toMatch(/INVALID: bad-summary/);
      // This repo ships ajv, so the schema path is DETERMINISTIC here and the
      // phase enum ("spec"|"plan"|"build"|"review"|"finalise") must catch it.
      // (Without ajv the structural floor guards only crash vectors — that
      // degradation is deliberate and documented in validateRecordShape.)
      expect(out).toMatch(/INVALID: bad-phase/);
    } finally {
      rmrf(root);
    }
  });
});
