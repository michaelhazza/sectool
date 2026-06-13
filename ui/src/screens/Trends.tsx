import { useState, useEffect } from 'react';
import type { TrendPoint } from '../types.js';
import { fetchTrend } from '../api.js';
import { SEVERITY_LABELS } from '../vocabulary.js';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

export function Trends() {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string>('all');

  useEffect(() => {
    async function load() {
      try {
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

  if (loading) return <div className="page-body" style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  if (error) return <div className="page-body" style={{ color: 'var(--sev-critical)' }}>Error: {error}</div>;

  if (trend.length === 0) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Progress Over Time</h1>
          <p className="page-subtitle">Trend history across all scans</p>
        </div>
        <div className="page-body">
          <div className="card" style={{ textAlign: 'center', padding: '48px 32px', color: 'var(--text-muted)' }}>
            No trend history yet. Run multiple scans to see progress over time.
          </div>
        </div>
      </div>
    );
  }

  // Collect all known targets
  const allTargets = [...new Set(trend.flatMap(t => (t.targets ?? []).map(tt => tt.name)))];

  // Build chart data
  const chartData = trend.map(point => {
    const date = new Date(point.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isUnknown = point.status === 'unknown' || point.status === 'partial';
    if (selectedTarget === 'all') {
      return {
        date,
        runId: point.runId,
        status: point.status,
        unknown: isUnknown,
        critical: isUnknown ? null : (point.totals.critical ?? 0),
        high: isUnknown ? null : (point.totals.high ?? 0),
        medium: isUnknown ? null : (point.totals.medium ?? 0),
        low: isUnknown ? null : (point.totals.low ?? 0),
        new: point.totals.new ?? 0,
        fixed: point.totals.fixed ?? 0,
      };
    }
    const tgt = point.targets?.find(t => t.name === selectedTarget);
    const tgtUnknown = !tgt || tgt.status === 'unknown' || tgt.status === 'partial';
    return {
      date,
      runId: point.runId,
      status: tgt?.status ?? 'unknown',
      unknown: tgtUnknown,
      critical: tgtUnknown ? null : (tgt?.critical ?? 0),
      high: tgtUnknown ? null : (tgt?.high ?? 0),
      medium: tgtUnknown ? null : (tgt?.medium ?? 0),
      low: tgtUnknown ? null : (tgt?.low ?? 0),
      new: 0,
      fixed: 0,
    };
  });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Progress Over Time</h1>
        <p className="page-subtitle">Trend history across all scans · {trend.length} run{trend.length === 1 ? '' : 's'}</p>
      </div>
      <div className="page-body">

        {/* Target selector tabs */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 16, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 0 }}>
          <TargetTab label="All targets" active={selectedTarget === 'all'} onClick={() => setSelectedTarget('all')} />
          {allTargets.map(t => (
            <TargetTab key={t} label={t} active={selectedTarget === t} onClick={() => setSelectedTarget(t)} />
          ))}
        </div>

        {/* Main time-series chart */}
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: '20px 20px 12px', marginBottom: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Open issues by severity
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, alignItems: 'center' }}>
              {(['critical', 'high', 'medium', 'low'] as const).map(s => (
                <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-secondary)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--sev-${s})`, display: 'inline-block' }} />
                  {SEVERITY_LABELS[s]}
                </span>
              ))}
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-muted)', display: 'inline-block' }} />
                unknown (incomplete run)
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--text-primary)' }}
                formatter={(value: unknown, name: string) => {
                  if (value === null) return ['unknown' as React.ReactNode, name];
                  return [String(value) as React.ReactNode, name];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="critical" stroke="var(--sev-critical)" strokeWidth={2} dot={false} connectNulls={false} name={SEVERITY_LABELS.critical} />
              <Line type="monotone" dataKey="high" stroke="var(--sev-high)" strokeWidth={2} dot={false} connectNulls={false} name={SEVERITY_LABELS.high} />
              <Line type="monotone" dataKey="medium" stroke="var(--sev-medium)" strokeWidth={2} dot={false} connectNulls={false} name={SEVERITY_LABELS.medium} />
              <Line type="monotone" dataKey="low" stroke="var(--sev-low)" strokeWidth={2} dot={false} connectNulls={false} name={SEVERITY_LABELS.low} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Run history table */}
        <div className="section-heading">Run History</div>
        <div style={{ overflowX: 'auto', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Run ID</th>
                <th>Status</th>
                <th>{SEVERITY_LABELS.critical}</th>
                <th>{SEVERITY_LABELS.high}</th>
                <th>{SEVERITY_LABELS.medium}</th>
                <th>{SEVERITY_LABELS.low}</th>
                <th>New</th>
                <th>Fixed</th>
              </tr>
            </thead>
            <tbody>
              {chartData.map(row => (
                <tr key={row.runId}>
                  <td>{row.date}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>{row.runId.slice(0, 16)}…</td>
                  <td>
                    {row.status === 'unknown' || row.status === 'partial' ? (
                      <span className="pill pill-partial">{row.status}</span>
                    ) : row.status === 'failed' ? (
                      <span className="pill pill-failed">Failed</span>
                    ) : (
                      <span className="pill pill-success">Complete</span>
                    )}
                  </td>
                  <td>
                    {row.unknown ? (
                      <UnknownCell />
                    ) : (
                      <span style={{ color: 'var(--sev-critical)', fontWeight: 700 }}>{row.critical}</span>
                    )}
                  </td>
                  <td>{row.unknown ? <UnknownCell /> : <span style={{ color: 'var(--sev-high)' }}>{row.high}</span>}</td>
                  <td>{row.unknown ? <UnknownCell /> : <span style={{ color: 'var(--sev-medium)' }}>{row.medium}</span>}</td>
                  <td>{row.unknown ? <UnknownCell /> : <span style={{ color: 'var(--sev-low)' }}>{row.low}</span>}</td>
                  <td>
                    {row.new > 0
                      ? <span className="delta delta-new">+{row.new}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>0</span>}
                  </td>
                  <td>
                    {row.fixed > 0
                      ? <span className="delta delta-fixed">{row.fixed}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}

function TargetTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 14px', fontSize: 12, fontWeight: 500,
        color: active ? '#6b8cff' : 'var(--text-secondary)',
        border: 'none', background: active ? 'rgba(107,140,255,0.05)' : 'none',
        cursor: 'pointer', borderBottom: active ? '2px solid #6b8cff' : '2px solid transparent',
        marginBottom: -1, transition: 'color 0.15s, border-color 0.15s', minHeight: 44,
        borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
      }}
    >
      {label}
    </button>
  );
}

// Explicit unknown cell for partial/failed scanner dims (§5.2: never conflate with success)
function UnknownCell() {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 }}>
      <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12">
        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
      </svg>
      unknown
    </span>
  );
}
