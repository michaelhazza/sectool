import { useState, useEffect } from 'react';
import type { FixEntry, FixesJson } from '../types.js';
import { fetchFixes } from '../api.js';
import { FIX_STATUS_LABELS } from '../vocabulary.js';
import { FixStatusChip } from '../components/Chips.js';

// Fix-request state pipeline steps in order (§5.3)
const PIPELINE_STEPS = [
  'requested',
  'in-progress',
  'awaiting-review',
  'merged-awaiting-verification',
  'verified-fixed',
] as const;

export function Fixes() {
  const [fixes, setFixes] = useState<FixesJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const f = await fetchFixes();
        setFixes(f);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  if (loading) return <div className="page-body" style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  if (error) return <div className="page-body" style={{ color: 'var(--sev-critical)' }}>Error: {error}</div>;

  const entries = fixes?.entries ?? [];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Fix Progress</h1>
        <p className="page-subtitle">
          {entries.length === 0
            ? 'No fix requests yet'
            : `${entries.length} fix request${entries.length === 1 ? '' : 's'} · ${entries.filter(e => e.status === 'verified-fixed').length} verified fixed`}
        </p>
      </div>
      <div className="page-body">

        {/* P8 affordance notice */}
        <div className="card mb-20" style={{ background: 'rgba(107,140,255,0.05)', borderColor: 'rgba(107,140,255,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <svg viewBox="0 0 20 20" fill="#6b8cff" width="18" height="18" style={{ flexShrink: 0, marginTop: 2 }}>
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#6b8cff', marginBottom: 3 }}>
                Fix-sending will be wired in P8
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                The "Send for fixing" button is available on each finding detail page.
                Fix requests will be filed as GitHub issues when P8 is complete.
                Use "Copy fix instructions" on the finding detail screen to fix manually in the meantime.
              </div>
            </div>
          </div>
        </div>

        {/* Empty state */}
        {entries.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: '48px 32px' }}>
            <div style={{ marginBottom: 16 }}>
              <svg viewBox="0 0 20 20" fill="var(--text-muted)" width="40" height="40">
                <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>No fix requests yet</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Fix requests will appear here once you send findings for fixing from the finding detail page.
            </div>
          </div>
        )}

        {/* Fix cards */}
        {entries.map(entry => (
          <FixCard key={entry.fingerprint} entry={entry} />
        ))}

      </div>
    </div>
  );
}

function FixCard({ entry }: { entry: FixEntry }) {
  const stepIndex = PIPELINE_STEPS.indexOf(entry.status as typeof PIPELINE_STEPS[number]);
  const isReopened = entry.status === 'reopened';

  return (
    <div className="card mb-12">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {entry.title ?? entry.ruleId ?? `Finding ${entry.fingerprint.slice(0, 16)}`}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>
            f-{entry.fingerprint.slice(0, 16)}
          </div>
        </div>
        <FixStatusChip status={entry.status} />
      </div>

      {/* Pipeline progress track */}
      {!isReopened && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, margin: '12px 0 6px', overflowX: 'auto', paddingBottom: 4 }}>
          {PIPELINE_STEPS.map((step, i) => {
            const isActive = i === stepIndex;
            const isDone = i < stepIndex;
            const color = isDone || isActive ? 'var(--status-success)' : 'var(--border)';
            return (
              <div key={step} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  border: `2px solid ${color}`,
                  background: isDone ? 'var(--status-success)' : isActive ? 'rgba(61,214,140,0.15)' : 'var(--bg-inset)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700,
                  color: isDone ? '#0d1a12' : isActive ? 'var(--status-success)' : 'var(--text-muted)',
                }}>
                  {isDone ? '✓' : i + 1}
                </div>
                <div style={{ fontSize: 10, color: isActive ? 'var(--status-success)' : 'var(--text-muted)', marginLeft: 4, marginRight: 4, whiteSpace: 'nowrap' }}>
                  {FIX_STATUS_LABELS[step]}
                </div>
                {i < PIPELINE_STEPS.length - 1 && (
                  <div style={{ width: 16, height: 2, background: isDone ? 'var(--status-success)' : 'var(--border)', flexShrink: 0 }} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {isReopened && (
        <div style={{ background: 'var(--fix-reopened-bg)', border: '1px solid var(--fix-reopened-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 12, color: 'var(--fix-reopened)' }}>
          This issue was re-opened. The fix did not hold — the finding still fires on the last scan. A new fix attempt is needed.
        </div>
      )}

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        {entry.issueUrl && (
          <a href={entry.issueUrl} target="_blank" rel="noreferrer" className="btn btn-ghost" style={{ fontSize: 11 }}>
            View GitHub issue ↗
          </a>
        )}
        {entry.updatedAt && <span>Updated {new Date(entry.updatedAt).toLocaleDateString()}</span>}
      </div>
    </div>
  );
}
