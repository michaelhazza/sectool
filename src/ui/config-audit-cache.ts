import * as fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { resolve, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Path — single constant (plan gap 6: "resolve(historyDir, 'config-audit.jsonl')")
// ---------------------------------------------------------------------------

export function CONFIG_AUDIT_PATH(historyDir: string): string {
  return resolve(historyDir, 'config-audit.jsonl');
}

// ---------------------------------------------------------------------------
// Genesis constant — prevHash for the very first entry in a chain
// ---------------------------------------------------------------------------

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// AuditEntry type
// ---------------------------------------------------------------------------

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target: string;
  commitSha: string;
  prevHash: string;
  hash: string;
}

// Fields used as input to hashing — all fields except `hash` itself
type AuditEntryWithoutHash = Omit<AuditEntry, 'hash'>;

// ---------------------------------------------------------------------------
// canonical — stable, key-order-independent serialization (sort keys)
// ---------------------------------------------------------------------------

function canonical(entry: AuditEntryWithoutHash): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(entry).sort()) {
    sorted[key] = (entry as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------
// chainDigest — hex digest of a chain link.
//
// Git remains the authoritative record (spec §8); this JSONL chain is a
// best-effort tamper-EVIDENCE accelerator. Plain sha256 is forgeable: anyone who
// can write the file can recompute a fully valid chain from genesis. When
// AUDIT_CACHE_HMAC_SECRET is configured, the chain is keyed with HMAC-SHA256 over
// that server-held secret, so a valid chain can only be produced by a holder of
// the secret — the cache becomes genuinely tamper-evident, not merely
// integrity-checkable. Absent the secret it falls back to the original unkeyed
// sha256 so existing deployments and chains keep working unchanged.
//
// The secret is read at call time (not cached) so append and verify observe the
// same value within a process. A chain written under a secret will (correctly)
// fail verification if the secret is later removed or changed — that is the
// tamper-evidence property, not a regression.
// ---------------------------------------------------------------------------

function chainDigest(input: string): string {
  const secret = process.env['AUDIT_CACHE_HMAC_SECRET'];
  if (secret && secret.length > 0) {
    return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
  }
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// appendAuditEntry — append one hash-chained JSON line.
// Throws on IO failure (caller C4 turns this into auditWarning).
// ---------------------------------------------------------------------------

export function appendAuditEntry(
  entry: Omit<AuditEntry, 'prevHash' | 'hash'>,
  path: string,
): void {
  const dir = dirname(path);
  fs.mkdirSync(dir, { recursive: true });

  // Determine prevHash: read the last line of the existing file, if present
  let prevHash = GENESIS_HASH;
  if (fs.existsSync(path)) {
    const content = fs.readFileSync(path, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1]!;
      try {
        const parsed = JSON.parse(lastLine) as Partial<AuditEntry>;
        if (typeof parsed.hash === 'string' && parsed.hash.length > 0) {
          prevHash = parsed.hash;
        }
      } catch {
        // Last line is malformed — chain from genesis; read will detect the break
        prevHash = GENESIS_HASH;
      }
    }
  }

  const entryWithoutHash: AuditEntryWithoutHash = { ...entry, prevHash };
  const hash = chainDigest(prevHash + canonical(entryWithoutHash));
  const fullEntry: AuditEntry = { ...entryWithoutHash, hash };

  fs.appendFileSync(path, JSON.stringify(fullEntry) + '\n', { flag: 'a' });
}

// ---------------------------------------------------------------------------
// readAuditChain — verify every link; never throws into the request path.
//
// M5: missing file → { entries: [], integrityOk: true, present: false } (benign)
// Corrupt / broken link → { entries: [...partial], integrityOk: false, present: true }
// ---------------------------------------------------------------------------

export function readAuditChain(path: string): {
  entries: AuditEntry[];
  integrityOk: boolean;
  present: boolean;
} {
  if (!fs.existsSync(path)) {
    return { entries: [], integrityOk: true, present: false };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return { entries: [], integrityOk: false, present: true };
  }

  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  if (lines.length === 0) {
    // Empty file present — treat as valid empty chain
    return { entries: [], integrityOk: true, present: true };
  }

  const entries: AuditEntry[] = [];
  let expectedPrevHash = GENESIS_HASH;
  let integrityOk = true;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      integrityOk = false;
      break;
    }

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as Record<string, unknown>)['hash'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['prevHash'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['at'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['actor'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['action'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['target'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['commitSha'] !== 'string'
    ) {
      integrityOk = false;
      break;
    }

    const entry = parsed as AuditEntry;

    // Check prevHash link
    if (entry.prevHash !== expectedPrevHash) {
      integrityOk = false;
      entries.push(entry);
      break;
    }

    // Recompute the hash and verify
    const entryWithoutHash: AuditEntryWithoutHash = {
      at: entry.at,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      commitSha: entry.commitSha,
      prevHash: entry.prevHash,
    };
    const expectedHash = chainDigest(entry.prevHash + canonical(entryWithoutHash));

    if (entry.hash !== expectedHash) {
      integrityOk = false;
      entries.push(entry);
      break;
    }

    entries.push(entry);
    expectedPrevHash = entry.hash;
  }

  return { entries, integrityOk, present: true };
}
