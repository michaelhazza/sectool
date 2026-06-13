import { useState, useEffect } from 'react';
import type { TargetsConfig, AllowlistConfig, BaselineConfig } from '../types.js';
import { fetchTargetsConfig, fetchAllowlistConfig, fetchBaselineConfig } from '../api.js';
import { ALLOWLIST_LABEL } from '../vocabulary.js';

function daysUntilExpiry(expiry: string): number {
  const exp = new Date(expiry).getTime();
  const now = Date.now();
  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
}

function ExpiryBadge({ expiry }: { expiry: string | undefined }) {
  if (!expiry) return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>No expiry</span>;
  const days = daysUntilExpiry(expiry);
  if (days < 0) return <span className="expiry-expired">EXPIRED ({expiry})</span>;
  if (days <= 30) return <span className="expiry-warn">Expires in {days} day{days === 1 ? '' : 's'} ({expiry})</span>;
  return <span className="expiry-ok">Expires {expiry}</span>;
}

export function TargetsSafety() {
  const [targets, setTargets] = useState<TargetsConfig | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistConfig | null>(null);
  const [baseline, setBaseline] = useState<BaselineConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [t, a, b] = await Promise.all([
          fetchTargetsConfig(),
          fetchAllowlistConfig(),
          fetchBaselineConfig(),
        ]);
        setTargets(t);
        setAllowlist(a);
        setBaseline(b);
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

  const repoTargets = targets?.repoTargets ?? [];
  const stagingTargets = targets?.stagingTargets ?? [];
  const allowlistHosts = allowlist?.hosts ?? [];
  const baselineEntries = baseline?.entries ?? [];

  const expiredEntries = baselineEntries.filter(e => e.expiry && daysUntilExpiry(e.expiry) < 0);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Sites and Safety</h1>
        <p className="page-subtitle">Read-only view of registered targets, approved test sites, and acknowledged risks</p>
      </div>
      <div className="page-body">

        {/* Expired baseline alert */}
        {expiredEntries.length > 0 && (
          <div className="run-banner run-banner-failed" role="alert" style={{ marginBottom: 24 }}>
            <div className="run-banner-icon">
              <svg viewBox="0 0 20 20" fill="var(--status-failed)" width="22" height="22">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="run-banner-body">
              <div className="run-banner-title" style={{ color: 'var(--status-failed)' }}>
                {expiredEntries.length} acknowledged risk{expiredEntries.length === 1 ? '' : 's'} expired
              </div>
              <div className="run-banner-sub" style={{ color: 'var(--status-failed)' }}>
                Expired baseline entries no longer suppress their findings. Update or remove them via PR.
              </div>
            </div>
          </div>
        )}

        {/* Source Repos */}
        <div className="section-heading">Source Repositories (In the code)</div>
        <div className="card mb-24">
          {repoTargets.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No repositories configured.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Linked staging target</th>
                  </tr>
                </thead>
                <tbody>
                  {repoTargets.map(t => (
                    <tr key={t.name}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{t.name}</div>
                        {t.url && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>{t.url}</div>}
                      </td>
                      <td>
                        {t.enabled
                          ? <span className="pill pill-success">Enabled</span>
                          : <span className="pill pill-unknown">Disabled</span>}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {t.repo ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Staging targets */}
        <div className="section-heading">Staging Targets (On the live test site)</div>
        <div className="card mb-24">
          {stagingTargets.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No staging targets configured.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Status</th>
                    <th>Active scan</th>
                    <th>Linked repo</th>
                  </tr>
                </thead>
                <tbody>
                  {stagingTargets.map(t => (
                    <tr key={t.name}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{t.name}</div>
                        {t.host && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>{t.host}</div>}
                      </td>
                      <td>
                        {t.enabled
                          ? <span className="pill pill-success">Enabled</span>
                          : <span className="pill pill-unknown">Disabled</span>}
                      </td>
                      <td>
                        {t.activeScan
                          ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--status-success-bg)', color: 'var(--status-success)', border: '1px solid var(--status-success-border)', borderRadius: 20, padding: '3px 9px', fontSize: 11, fontWeight: 600 }}>
                              Active scan on
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--bg-inset)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 20, padding: '3px 9px', fontSize: 11 }}>
                              Passive only
                            </span>
                          )}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t.repo ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Allowlist */}
        <div className="section-heading">{ALLOWLIST_LABEL}</div>
        <div className="mb-8" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Hosts listed here may be scanned. All others are blocked — no override path exists.
          Changes require a PR review.
        </div>
        {allowlistHosts.length === 0 ? (
          <div className="card mb-24" style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '32px' }}>
            <div style={{ marginBottom: 8 }}>
              <svg viewBox="0 0 20 20" fill="var(--text-muted)" width="28" height="28">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>No approved test sites</div>
            <div>The live scan path cannot scan anything until hosts are added to <code className="tag">config/allowed-staging-hosts.json</code> via PR.</div>
          </div>
        ) : (
          <div className="mb-24">
            {allowlistHosts.map(h => (
              <div key={h.host} style={{ background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', marginBottom: 8 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--status-success)', marginBottom: 6 }}>{h.host}</div>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
                  {h.owner && <div><span style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Owner</span><br /><span style={{ color: 'var(--text-secondary)' }}>{h.owner}</span></div>}
                  {h.addedAt && <div><span style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Added</span><br /><span style={{ color: 'var(--text-secondary)' }}>{h.addedAt}</span></div>}
                  {h.note && <div><span style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Note</span><br /><span style={{ color: 'var(--text-secondary)' }}>{h.note}</span></div>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Baseline entries */}
        <div className="section-heading">Acknowledged Risks</div>
        <div className="mb-8" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          These findings have been reviewed and accepted. They will not show as open issues unless their expiry passes.
          Entries are approved via PR.
        </div>
        {baselineEntries.length === 0 ? (
          <div className="card mb-24" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            No acknowledged risks.
          </div>
        ) : (
          <div className="mb-24">
            {baselineEntries.map(entry => {
              const isExpired = entry.expiry ? daysUntilExpiry(entry.expiry) < 0 : false;
              return (
                <div
                  key={entry.fingerprint}
                  style={{
                    background: isExpired ? 'rgba(255,68,85,0.03)' : 'var(--bg-card)',
                    border: isExpired ? '1px solid var(--sev-critical-border)' : '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    padding: '16px 18px',
                    marginBottom: 10,
                  } as React.CSSProperties}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{entry.ruleId}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-muted)' }}>f-{entry.fingerprint.slice(0, 16)}</div>
                    </div>
                    <ExpiryBadge expiry={entry.expiry} />
                  </div>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
                    <div>
                      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Target</div>
                      <div>{entry.target}</div>
                    </div>
                    {entry.justification && (
                      <div>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Justification</div>
                        <div>{entry.justification}</div>
                      </div>
                    )}
                    {entry.approvedBy && (
                      <div>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Approved by</div>
                        <div>{entry.approvedBy}</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}
