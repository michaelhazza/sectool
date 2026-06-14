import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolve } from 'node:path';
import {
  CONFIG_AUDIT_PATH,
  appendAuditEntry,
  readAuditChain,
  type AuditEntry,
} from './config-audit-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(resolve(os.tmpdir(), 'audit-cache-test-'));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const BASE_TIME = '2026-06-14T10:00:00.000Z';

function makeEntry(
  overrides?: Partial<Omit<AuditEntry, 'prevHash' | 'hash'>>,
): Omit<AuditEntry, 'prevHash' | 'hash'> {
  return {
    at: BASE_TIME,
    actor: 'config-admin',
    action: 'add-host',
    target: 'staging.example.com',
    commitSha: 'abc123',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CONFIG_AUDIT_PATH
// ---------------------------------------------------------------------------

describe('CONFIG_AUDIT_PATH', () => {
  it('returns <historyDir>/config-audit.jsonl', () => {
    const dir = '/some/history';
    expect(CONFIG_AUDIT_PATH(dir)).toBe(resolve(dir, 'config-audit.jsonl'));
  });
});

// ---------------------------------------------------------------------------
// M5 — missing file is NOT an integrity failure
// ---------------------------------------------------------------------------

describe('readAuditChain — missing file (M5)', () => {
  it('returns { entries: [], integrityOk: true, present: false } for a missing file', () => {
    const dir = tmpDir();
    try {
      const path = CONFIG_AUDIT_PATH(dir);
      // File does not exist
      const result = readAuditChain(path);
      expect(result).toEqual({ entries: [], integrityOk: true, present: false });
    } finally {
      rmDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path — append N entries, chain links correctly
// ---------------------------------------------------------------------------

describe('appendAuditEntry + readAuditChain — happy path', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = tmpDir();
    path = CONFIG_AUDIT_PATH(dir);
  });
  afterEach(() => { rmDir(dir); });

  it('creates the directory if absent', () => {
    const nestedDir = resolve(dir, 'history');
    const nestedPath = CONFIG_AUDIT_PATH(nestedDir);
    appendAuditEntry(makeEntry(), nestedPath);
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it('appends 1 entry: readAuditChain returns it with integrityOk:true, present:true', () => {
    appendAuditEntry(makeEntry(), path);
    const result = readAuditChain(path);
    expect(result.integrityOk).toBe(true);
    expect(result.present).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.action).toBe('add-host');
  });

  it('appends 3 entries: chain links correctly (each prevHash == prior hash)', () => {
    appendAuditEntry(makeEntry({ action: 'add-host', commitSha: 'sha1' }), path);
    appendAuditEntry(makeEntry({ action: 'remove-host', commitSha: 'sha2' }), path);
    appendAuditEntry(makeEntry({ action: 'add-repo', commitSha: 'sha3' }), path);

    const result = readAuditChain(path);
    expect(result.integrityOk).toBe(true);
    expect(result.present).toBe(true);
    expect(result.entries).toHaveLength(3);

    const [e1, e2, e3] = result.entries as [AuditEntry, AuditEntry, AuditEntry];

    // Each entry's prevHash == the prior entry's hash
    expect(e2.prevHash).toBe(e1.hash);
    expect(e3.prevHash).toBe(e2.hash);

    // First entry's prevHash is the genesis constant (64 zeros)
    expect(e1.prevHash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('appends 5 entries and all verify correctly', () => {
    for (let i = 0; i < 5; i++) {
      appendAuditEntry(makeEntry({ commitSha: `sha${i}`, action: `action-${i}` }), path);
    }
    const result = readAuditChain(path);
    expect(result.integrityOk).toBe(true);
    expect(result.entries).toHaveLength(5);

    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i]!.prevHash).toBe(result.entries[i - 1]!.hash);
    }
  });
});

// ---------------------------------------------------------------------------
// Named §13 test — tamper one entry's action/target → integrityOk:false
// ---------------------------------------------------------------------------

describe('readAuditChain — tamper detection (named §13 test)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = tmpDir();
    path = CONFIG_AUDIT_PATH(dir);
  });
  afterEach(() => { rmDir(dir); });

  it('tamper one entry action in place → integrityOk:false', () => {
    appendAuditEntry(makeEntry({ action: 'add-host', commitSha: 'sha1' }), path);
    appendAuditEntry(makeEntry({ action: 'remove-host', commitSha: 'sha2' }), path);
    appendAuditEntry(makeEntry({ action: 'add-repo', commitSha: 'sha3' }), path);

    // Read raw, tamper the first entry's action
    const raw = fs.readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const first = JSON.parse(lines[0]!) as AuditEntry;
    first.action = 'TAMPERED';
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(path, lines.join('\n') + '\n', 'utf8');

    const result = readAuditChain(path);
    expect(result.integrityOk).toBe(false);
    expect(result.present).toBe(true);
  });

  it('tamper one entry target in place → integrityOk:false', () => {
    appendAuditEntry(makeEntry({ target: 'original.example.com', commitSha: 'sha1' }), path);
    appendAuditEntry(makeEntry({ commitSha: 'sha2' }), path);

    const raw = fs.readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const first = JSON.parse(lines[0]!) as AuditEntry;
    first.target = 'evil.example.com';
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(path, lines.join('\n') + '\n', 'utf8');

    const result = readAuditChain(path);
    expect(result.integrityOk).toBe(false);
  });

  it('tamper a middle entry → integrityOk:false', () => {
    appendAuditEntry(makeEntry({ commitSha: 'sha1' }), path);
    appendAuditEntry(makeEntry({ commitSha: 'sha2', action: 'original' }), path);
    appendAuditEntry(makeEntry({ commitSha: 'sha3' }), path);

    const raw = fs.readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const middle = JSON.parse(lines[1]!) as AuditEntry;
    middle.action = 'TAMPERED';
    lines[1] = JSON.stringify(middle);
    fs.writeFileSync(path, lines.join('\n') + '\n', 'utf8');

    const result = readAuditChain(path);
    expect(result.integrityOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Truncated / garbage file → integrityOk:false, present:true, no throw
// ---------------------------------------------------------------------------

describe('readAuditChain — corrupt/garbage file', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = tmpDir();
    path = CONFIG_AUDIT_PATH(dir);
  });
  afterEach(() => { rmDir(dir); });

  it('truncated/garbage file → integrityOk:false, present:true, no throw', () => {
    fs.mkdirSync(resolve(dir), { recursive: true });
    fs.writeFileSync(path, 'NOT_VALID_JSON\n', 'utf8');

    let result: ReturnType<typeof readAuditChain> | undefined;
    expect(() => {
      result = readAuditChain(path);
    }).not.toThrow();
    expect(result!.integrityOk).toBe(false);
    expect(result!.present).toBe(true);
  });

  it('partial / truncated JSON line → integrityOk:false, present:true, no throw', () => {
    appendAuditEntry(makeEntry({ commitSha: 'sha1' }), path);
    // Append a partial/truncated line
    fs.appendFileSync(path, '{"at":"2026-06-14T10:00:00.000Z","actor":"config-admin"', 'utf8');

    let result: ReturnType<typeof readAuditChain> | undefined;
    expect(() => {
      result = readAuditChain(path);
    }).not.toThrow();
    expect(result!.integrityOk).toBe(false);
    expect(result!.present).toBe(true);
  });

  it('empty file (present) → integrityOk:true, present:true, entries:[]', () => {
    fs.writeFileSync(path, '', 'utf8');
    const result = readAuditChain(path);
    expect(result).toEqual({ entries: [], integrityOk: true, present: true });
  });

  it('file with only whitespace lines → integrityOk:true, present:true, entries:[]', () => {
    fs.writeFileSync(path, '\n\n  \n', 'utf8');
    const result = readAuditChain(path);
    expect(result).toEqual({ entries: [], integrityOk: true, present: true });
  });
});

// ---------------------------------------------------------------------------
// Canonical serialization is stable regardless of key insertion order
// ---------------------------------------------------------------------------

describe('canonical serialization — key-order independence', () => {
  let dir: string;
  let path: string;
  let path2: string;

  beforeEach(() => {
    dir = tmpDir();
    path = CONFIG_AUDIT_PATH(dir);
    path2 = CONFIG_AUDIT_PATH(resolve(dir, 'chain2'));
  });
  afterEach(() => { rmDir(dir); });

  it('two entries with identical data but different key insertion order hash identically', () => {
    // Entry A: fields in the "natural" order
    const entryA: Omit<AuditEntry, 'prevHash' | 'hash'> = {
      at: BASE_TIME,
      actor: 'config-admin',
      action: 'add-host',
      target: 'staging.example.com',
      commitSha: 'abc123',
    };

    // Entry B: fields in reverse order (commitSha first, then target, etc.)
    // We build this via Object.assign with a deliberately different insertion order.
    const entryB: Omit<AuditEntry, 'prevHash' | 'hash'> = Object.assign(
      {},
      { commitSha: 'abc123' },
      { target: 'staging.example.com' },
      { action: 'add-host' },
      { actor: 'config-admin' },
      { at: BASE_TIME },
    ) as Omit<AuditEntry, 'prevHash' | 'hash'>;

    appendAuditEntry(entryA, path);
    appendAuditEntry(entryB, path2);

    const resultA = readAuditChain(path);
    const resultB = readAuditChain(path2);

    // Both chains must be valid
    expect(resultA.integrityOk).toBe(true);
    expect(resultB.integrityOk).toBe(true);

    // The resulting hashes must be identical (canonical order makes them equal)
    expect(resultA.entries[0]!.hash).toBe(resultB.entries[0]!.hash);
  });
});
