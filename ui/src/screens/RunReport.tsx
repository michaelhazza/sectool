import { useState, useEffect } from 'react';
import type { Finding, RunReport as RunReportType, Severity, Surface } from '../types.js';
import { fetchReport, fetchReportList } from '../api.js';
import { SEVERITY_LABELS, SURFACE_LABELS } from '../vocabulary.js';
import { SeverityChip, SurfaceChip } from '../components/Chips.js';
import { targetLabel, findingSurface, formatFailures } from '../findingHelpers.js';

interface RunReportProps {
  onNavigateToFinding: (fingerprint: string) => void;
}

export function RunReport({ onNavigateToFinding }: RunReportProps) {
  const [report, setReport] = useState<RunReportType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterSeverity, setFilterSeverity] = useState<Severity | 'all'>('all');
  const [filterSurface, setFilterSurface] = useState<Surface | 'all'>('all');
  const [filterTarget, setFilterTarget] = useState<string>('all');
  const [filterSuppressed, setFilterSuppressed] = useState<'visible' | 'suppressed' | 'all'>('visible');

  useEffect(() => {
    async function load() {
      try {
        const list = await fetchReportList();
        const latest = list[0];
        if (latest) {
          const r = await fetchReport(latest.runId);
          setReport(r);
        }
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
  if (!report) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">What Needs Fixing</h1>
          <p className="page-subtitle">All findings in priority order</p>
        </div>
        <div className="page-body">
          <div className="card" style={{ textAlign: 'center', padding: '48px 32px', color: 'var(--text-muted)' }}>
            No scan results. Run <code className="tag">audit run</code> first.
          </div>
        </div>
      </div>
    );
  }

  const { meta, findings, runId } = report;
  const targets = [...new Set(findings.map(f => targetLabel(f.target)))];

  let filtered = findings;
  if (filterSeverity !== 'all') filtered = filtered.filter(f => f.severity === filterSeverity);
  if (filterSurface !== 'all') filtered = filtered.filter(f => findingSurface(f) === filterSurface);
  if (filterTarget !== 'all') filtered = filtered.filter(f => targetLabel(f.target) === filterTarget);
  if (filterSuppressed === 'visible') filtered = filtered.filter(f => !f.suppressed);
  else if (filterSuppressed === 'suppressed') filtered = filtered.filter(f => f.suppressed);

  // Distribution counts (active, non-suppressed)
  const active = findings.filter(f => !f.suppressed);
  const bySev = (['critical', 'high', 'medium', 'low'] as const).map(s => ({
    sev: s,
    count: active.filter(f => f.severity === s).length,
  }));

  const isPartial = meta.status === 'partial';

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">What Needs Fixing</h1>
        <p className="page-subtitle">All findings in priority order · {active.length} open issues</p>
      </div>
      <div className="page-body">

        {isPartial && (
          <div className="run-banner run-banner-partial" role="alert" style={{ marginBottom: 20 }}>
            <div className="run-banner-body">
              <div className="run-banner-title" style={{ color: 'var(--status-partial)' }}>Some checks did not finish</div>
              <div className="run-banner-sub" style={{ color: 'var(--status-partial)', fontSize: 12 }}>
                These results may be incomplete. {formatFailures(meta.failures)}
              </div>
            </div>
          </div>
        )}

        {/* Distribution charts row */}
        <div className="grid-3 mb-24">
          <div className="card">
            <div className="card-title" style={{ marginBottom: 14 }}>By Severity</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {bySev.map(({ sev, count }) => {
                const max = Math.max(...bySev.map(b => b.count), 1);
                return (
                  <div key={sev} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', width: 60, textAlign: 'right', flexShrink: 0 }}>
                      {SEVERITY_LABELS[sev]}
                    </div>
                    <div style={{ flex: 1, height: 10, background: 'var(--bg-inset)', borderRadius: 20, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${(count / max) * 100}%`,
                        background: `var(--sev-${sev})`,
                        borderRadius: 20,
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 22, textAlign: 'right' }}>{count}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 14 }}>By Surface</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(['static', 'live'] as const).map(kind => {
                const count = active.filter(f => findingSurface(f) === kind).length;
                const max = active.length || 1;
                return (
                  <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', width: 100, textAlign: 'right', flexShrink: 0 }}>
                      {SURFACE_LABELS[kind]}
                    </div>
                    <div style={{ flex: 1, height: 10, background: 'var(--bg-inset)', borderRadius: 20, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${(count / max) * 100}%`,
                        background: kind === 'static' ? 'var(--surface-static)' : 'var(--surface-live)',
                        borderRadius: 20,
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', width: 22, textAlign: 'right' }}>{count}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 14 }}>Run Info</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
              <div>
                <div className="info-row-label">Run ID</div>
                <div className="tag" style={{ marginTop: 2 }}>{runId.slice(0, 16)}…</div>
              </div>
              <div>
                <div className="info-row-label">Started</div>
                <div style={{ color: 'var(--text-primary)' }}>{new Date(meta.startedAt).toLocaleString()}</div>
              </div>
              <div>
                <div className="info-row-label">Status</div>
                <span className={`pill pill-${meta.status}`}>{meta.status}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="filters-row">
          <select className="filter-select" value={filterSeverity} onChange={e => setFilterSeverity(e.target.value as typeof filterSeverity)}>
            <option value="all">All severities</option>
            {(['critical', 'high', 'medium', 'low'] as const).map(s => (
              <option key={s} value={s}>{SEVERITY_LABELS[s]} ({s})</option>
            ))}
          </select>
          <select className="filter-select" value={filterSurface} onChange={e => setFilterSurface(e.target.value as typeof filterSurface)}>
            <option value="all">All surfaces</option>
            <option value="static">{SURFACE_LABELS.static}</option>
            <option value="live">{SURFACE_LABELS.live}</option>
          </select>
          <select className="filter-select" value={filterTarget} onChange={e => setFilterTarget(e.target.value)}>
            <option value="all">All targets</option>
            {targets.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="filter-select" value={filterSuppressed} onChange={e => setFilterSuppressed(e.target.value as typeof filterSuppressed)}>
            <option value="visible">Open issues</option>
            <option value="suppressed">Acknowledged risks</option>
            <option value="all">All findings</option>
          </select>
        </div>

        {/* Findings table */}
        <div className="table-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th>Risk</th>
                <th>Issue</th>
                <th>Surface</th>
                <th>Target</th>
                <th>Fix Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '32px 14px' }}>
                    No findings match the current filters.
                  </td>
                </tr>
              ) : (
                filtered.map(f => (
                  <FindingRow key={f.fingerprint} finding={f} onClick={() => onNavigateToFinding(f.fingerprint)} />
                ))
              )}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}

function FindingRow({ finding: f, onClick }: { finding: Finding; onClick: () => void }) {
  const hasFixReq = (f.externalRefs?.length ?? 0) > 0;
  return (
    <tr onClick={onClick}>
      <td data-label="Risk"><SeverityChip severity={f.severity} /></td>
      <td data-label="Issue" className="row-title">
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
          {f.title ?? f.ruleId}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>
          {f.ruleId}
        </div>
        {f.suppressed && (
          <span className="pill pill-unknown" style={{ marginTop: 4, display: 'inline-block' }}>Acknowledged risk</span>
        )}
      </td>
      <td data-label="Surface"><SurfaceChip kind={findingSurface(f)} /></td>
      <td data-label="Target">
        <span style={{ fontSize: 12 }}>{targetLabel(f.target)}</span>
      </td>
      <td data-label="Fix Status">
        {hasFixReq && f.externalRefs?.[0] ? (
          <span className={`pill pill-fix-${f.externalRefs[0].status.replace(/-/g, '')}`}>
            {f.externalRefs[0].status}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
        )}
      </td>
    </tr>
  );
}
