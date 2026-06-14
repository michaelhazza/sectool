import { useState, useEffect } from 'react';
import type { RunReport, TrendPoint } from '../types.js';
import { fetchReport, fetchReportList, fetchTrend } from '../api.js';
import { PARTIAL_RUN_LABEL, SEVERITY_LABELS, SURFACE_LABELS } from '../vocabulary.js';
import { SeverityChip, RunStatusChip } from '../components/Chips.js';
import { targetLabel, findingSurface, formatFailures } from '../findingHelpers.js';

interface PortfolioOverviewProps {
  onNavigateToRunReport: () => void;
}

export function PortfolioOverview({ onNavigateToRunReport }: PortfolioOverviewProps) {
  const [report, setReport] = useState<RunReport | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const list = await fetchReportList();
        const latest = list[0];
        if (latest) {
          const r = await fetchReport(latest.runId);
          setReport(r);
        }
        const t = await fetchTrend();
        setTrend(t);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  if (loading) {
    return <div className="page-body" style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  }

  if (error) {
    return <div className="page-body" style={{ color: 'var(--sev-critical)' }}>Error: {error}</div>;
  }

  if (!report) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Security Overview</h1>
          <p className="page-subtitle">Latest scan results across all your projects</p>
        </div>
        <div className="page-body">
          <div className="card" style={{ textAlign: 'center', padding: '48px 32px' }}>
            <div style={{ fontSize: '32px', marginBottom: '16px' }}>
              <svg viewBox="0 0 20 20" fill="var(--text-muted)" width="40" height="40">
                <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            </div>
            <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>No scan results yet</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
              Run <code className="tag">audit run</code> to generate your first security report.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { meta, findings } = report;
  const criticalCount = findings.filter(f => f.severity === 'critical' && !f.suppressed).length;
  const highCount = findings.filter(f => f.severity === 'high' && !f.suppressed).length;
  const mediumCount = findings.filter(f => f.severity === 'medium' && !f.suppressed).length;
  const lowCount = findings.filter(f => f.severity === 'low' && !f.suppressed).length;

  // Group findings by target. Key on the readable target label (host for live,
  // name for static) so live findings — which have no `target.name` — don't all
  // collapse into a single "undefined" bucket.
  const byTarget = new Map<string, typeof findings>();
  for (const f of findings) {
    const key = `${findingSurface(f)}:${targetLabel(f.target)}`;
    const arr = byTarget.get(key) ?? [];
    arr.push(f);
    byTarget.set(key, arr);
  }

  // Compute new/fixed/persisting from trend
  const latestTrend = trend[trend.length - 1];
  const prevTrend = trend[trend.length - 2];
  const newCount = latestTrend?.totals.new ?? 0;
  const fixedCount = latestTrend?.totals.fixed ?? 0;
  const persistingCount = latestTrend?.totals.persisting ?? 0;

  const isPartial = meta.status === 'partial';
  const isFailed = meta.status === 'failed';

  const startedDate = new Date(meta.startedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Security Overview</h1>
        <p className="page-subtitle">Latest scan results across all your projects</p>
      </div>
      <div className="page-body">

        {/* Run status banner */}
        {isPartial && (
          <div className="run-banner run-banner-partial" role="alert">
            <div className="run-banner-icon">
              <svg viewBox="0 0 20 20" fill="var(--status-partial)" width="22" height="22">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="run-banner-body">
              <div className="run-banner-title" style={{ color: 'var(--status-partial)' }}>
                {PARTIAL_RUN_LABEL}
              </div>
              <div className="run-banner-sub" style={{ color: 'var(--status-partial)' }}>
                {meta.failures && meta.failures.length > 0
                  ? `Failed checks: ${formatFailures(meta.failures)}. Re-run to get a full picture.`
                  : 'Some scanner families did not complete. Re-run to get a full picture.'}
              </div>
            </div>
            <div className="run-banner-meta">
              {startedDate}<br />
              <span className="pill pill-partial" style={{ marginTop: 4, display: 'inline-block' }}>Incomplete run</span>
            </div>
          </div>
        )}

        {isFailed && (
          <div className="run-banner run-banner-failed" role="alert">
            <div className="run-banner-icon">
              <svg viewBox="0 0 20 20" fill="var(--status-failed)" width="22" height="22">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="run-banner-body">
              <div className="run-banner-title" style={{ color: 'var(--status-failed)' }}>Run failed</div>
              <div className="run-banner-sub" style={{ color: 'var(--status-failed)' }}>
                {meta.failures && meta.failures.length > 0
                  ? formatFailures(meta.failures)
                  : 'An error occurred during the scan.'}
              </div>
            </div>
            <div className="run-banner-meta">{startedDate}</div>
          </div>
        )}

        {/* Severity totals */}
        <div style={{ display: 'flex', gap: 0, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 24 }}>
          {(
            [
              { sev: 'critical', count: criticalCount },
              { sev: 'high', count: highCount },
              { sev: 'medium', count: mediumCount },
              { sev: 'low', count: lowCount },
            ] as const
          ).map(({ sev, count }, i) => (
            <div
              key={sev}
              style={{
                flex: 1,
                padding: '16px 20px',
                borderRight: i < 3 ? '1px solid var(--border-subtle)' : 'none',
                cursor: 'pointer',
              }}
              onClick={onNavigateToRunReport}
            >
              <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, marginBottom: 4, color: `var(--sev-${sev})` }}>{count}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{SEVERITY_LABELS[sev]}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{sev.charAt(0).toUpperCase() + sev.slice(1)}</div>
            </div>
          ))}
        </div>

        {/* Delta row */}
        <div className="flex-between mb-16">
          <div className="section-heading">Project Status</div>
          <div className="info-row" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {typeof newCount === 'number' && <span className="delta delta-new">+{newCount} new</span>}
            {typeof fixedCount === 'number' && <span className="delta delta-fixed">{fixedCount} fixed</span>}
            {typeof persistingCount === 'number' && <span className="delta delta-persisting">{persistingCount} carried over</span>}
          </div>
        </div>

        {/* Target cards */}
        <div className="grid-2 mb-24">
          {Array.from(byTarget.entries()).map(([key, tFindings]) => {
            const firstF = tFindings[0];
            if (!firstF) return null;
            const surface = findingSurface(firstF);
            const isLive = surface === 'live';
            const name = targetLabel(firstF.target);
            const tCritical = tFindings.filter(f => f.severity === 'critical' && !f.suppressed).length;
            const tHigh = tFindings.filter(f => f.severity === 'high' && !f.suppressed).length;
            const tMedium = tFindings.filter(f => f.severity === 'medium' && !f.suppressed).length;
            const tLow = tFindings.filter(f => f.severity === 'low' && !f.suppressed).length;

            // Determine target-level status from scannerStatus
            const targetFamilyStatuses = meta.scannerStatus?.filter(s => s.target === name) ?? [];
            const hasPartialTarget = targetFamilyStatuses.some(s => s.state === 'failed' || s.state === 'skipped');
            const allComplete = targetFamilyStatuses.length > 0 && targetFamilyStatuses.every(s => s.state === 'complete');

            const targetTrend = trend[trend.length - 1]?.targets?.find(t => t.name === name);
            const prevTargetTrend = prevTrend?.targets?.find(t => t.name === name);
            const tNew = targetTrend ? ((targetTrend.critical ?? 0) + (targetTrend.high ?? 0) + (targetTrend.medium ?? 0) + (targetTrend.low ?? 0)) : null;
            const tPrev = prevTargetTrend ? ((prevTargetTrend.critical ?? 0) + (prevTargetTrend.high ?? 0) + (prevTargetTrend.medium ?? 0) + (prevTargetTrend.low ?? 0)) : null;

            return (
              <div
                key={key}
                style={{
                  background: 'var(--bg-card)',
                  border: `1px solid ${hasPartialTarget ? 'var(--status-partial-border)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: '18px 20px',
                  cursor: 'pointer',
                }}
                onClick={onNavigateToRunReport}
              >
                <div className="flex-between" style={{ marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{name}</div>
                    {isLive && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
                        {SURFACE_LABELS.live}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    {hasPartialTarget ? (
                      <>
                        <span className="pill pill-partial">Check incomplete</span>
                      </>
                    ) : allComplete ? (
                      <span className="pill pill-success">All checks complete</span>
                    ) : (
                      <RunStatusChip status={meta.status} />
                    )}
                    {isLive && <span className="pill pill-live" style={{ fontSize: 10 }}>{SURFACE_LABELS.live}</span>}
                  </div>
                </div>

                {/* Severity counts */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {(
                    [
                      { sev: 'critical', count: tCritical },
                      { sev: 'high', count: tHigh },
                      { sev: 'medium', count: tMedium },
                      { sev: 'low', count: tLow },
                    ] as const
                  ).map(({ sev, count }) => (
                    <div key={sev} style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      background: 'var(--bg-inset)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)', padding: '8px 14px', minWidth: 56,
                    }}>
                      <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1, marginBottom: 3, color: `var(--sev-${sev})` }}>{count}</div>
                      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: `var(--sev-${sev})`, opacity: 0.7 }}>
                        {SEVERITY_LABELS[sev]}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Delta */}
                {tNew !== null && tPrev !== null && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span className="delta delta-persisting">{tNew} total</span>
                    {tNew < tPrev && <span className="delta delta-fixed">{tPrev - tNew} fixed</span>}
                    {tNew > tPrev && <span className="delta delta-new">+{tNew - tPrev} new</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}
