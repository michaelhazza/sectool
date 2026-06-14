import { useState, useEffect, useCallback } from 'react';
import type { ConfigHistoryEntry } from '../types.js';
import { fetchConfigHistory, revertConfig } from '../api.js';
import { StepUpModal } from './StepUpModal.js';

interface ConfigHistoryProps {
  /** Increment to trigger a re-fetch after a successful write. */
  refreshKey: number;
}

/**
 * History panel listing recent config changes with a Revert button.
 * Backed by GET /api/config/history. Revert is 2FA-gated and re-prompts
 * the step-up modal if the session has expired.
 */
export function ConfigHistory({ refreshKey }: ConfigHistoryProps) {
  const [entries, setEntries] = useState<ConfigHistoryEntry[]>([]);
  const [integrityOk, setIntegrityOk] = useState(true);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [revertTarget, setRevertTarget] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [showStepUp, setShowStepUp] = useState(false);
  const [pendingRevert, setPendingRevert] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setFetchError(null);
    fetchConfigHistory(20)
      .then((data) => {
        setEntries(data.entries);
        setIntegrityOk(data.integrityOk);
      })
      .catch((e: unknown) => {
        setFetchError(e instanceof Error ? e.message : 'Failed to load history');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function doRevert(sha: string) {
    setReverting(true);
    setRevertError(null);
    setRevertTarget(sha);
    try {
      await revertConfig(sha);
      load();
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 403) {
        setPendingRevert(sha);
        setShowStepUp(true);
      } else {
        setRevertError(e.message ?? 'Revert failed');
      }
    } finally {
      setReverting(false);
      setRevertTarget(null);
    }
  }

  function handleRevertClick(sha: string) {
    void doRevert(sha);
  }

  function handleStepUpSuccess() {
    setShowStepUp(false);
    if (pendingRevert !== null) {
      const sha = pendingRevert;
      setPendingRevert(null);
      void doRevert(sha);
    }
  }

  function handleStepUpCancel() {
    setShowStepUp(false);
    setPendingRevert(null);
  }

  return (
    <div>
      {showStepUp && (
        <StepUpModal onSuccess={handleStepUpSuccess} onCancel={handleStepUpCancel} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="section-heading" style={{ margin: 0 }}>Change history</div>
        {!loading && (
          <button
            className="btn"
            onClick={load}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              minHeight: 32,
              background: 'var(--bg-inset)',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
            }}
          >
            Refresh
          </button>
        )}
      </div>

      {!integrityOk && (
        <div
          role="alert"
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            background: 'rgba(234,179,8,0.1)',
            border: '1px solid rgba(234,179,8,0.5)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 12,
          }}
        >
          Audit cache integrity warning — history shown from git records.
        </div>
      )}

      {revertError && (
        <div
          role="alert"
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            background: 'rgba(var(--sev-critical-rgb,220,38,38),0.08)',
            border: '1px solid var(--sev-critical)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--sev-critical)',
            fontSize: 13,
          }}
        >
          {revertError}
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>Loading history…</div>
      ) : fetchError ? (
        <div style={{ color: 'var(--sev-critical)', fontSize: 13 }}>{fetchError}</div>
      ) : entries.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No config changes recorded yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map((entry) => (
            <div
              key={entry.commitSha}
              style={{
                background: 'var(--bg-inset)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
                  {entry.action}
                  {entry.target ? <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> — {entry.target}</span> : null}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <span>{new Date(entry.at).toLocaleString()}</span>
                  <span style={{ fontFamily: 'var(--mono)' }}>{entry.commitSha.slice(0, 8)}</span>
                </div>
              </div>
              <button
                className="btn"
                onClick={() => handleRevertClick(entry.commitSha)}
                disabled={reverting && revertTarget === entry.commitSha}
                aria-label={`Revert change ${entry.commitSha.slice(0, 8)}`}
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  minHeight: 44,
                  background: 'var(--bg-inset)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  flexShrink: 0,
                }}
              >
                {reverting && revertTarget === entry.commitSha ? 'Reverting…' : 'Revert'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
