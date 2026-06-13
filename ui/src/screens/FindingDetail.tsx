import { useState, useEffect } from 'react';
import type { Finding, RunReport } from '../types.js';
import { fetchReport, fetchReportList, copyToClipboard } from '../api.js';
import { SEVERITY_LABELS, SURFACE_LABELS, BASELINE_LABELS } from '../vocabulary.js';
import { SeverityChip, SurfaceChip, FixStatusChip } from '../components/Chips.js';

interface FindingDetailProps {
  fingerprint: string;
  onBack: () => void;
}

export function FindingDetail({ fingerprint, onBack }: FindingDetailProps) {
  const [report, setReport] = useState<RunReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [copiedBaseline, setCopiedBaseline] = useState(false);
  const [copiedInstructions, setCopiedInstructions] = useState(false);

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

  const finding = report?.findings.find(f => f.fingerprint === fingerprint);

  if (!finding) {
    return (
      <div>
        <div className="page-header">
          <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: 12 }}>← Back</button>
          <h1 className="page-title">Issue Not Found</h1>
        </div>
        <div className="page-body">
          <div className="card" style={{ color: 'var(--text-muted)' }}>
            Finding with fingerprint <code className="tag">{fingerprint.slice(0, 16)}…</code> was not found in the latest report.
          </div>
        </div>
      </div>
    );
  }

  const baselineEntry = {
    fingerprint: finding.fingerprint,
    ruleId: finding.ruleId,
    target: finding.target,
    justification: 'Accepted: <explain why this is acceptable>',
    approvedBy: '<approver>',
    expiry: '<YYYY-MM-DD or omit>',
  };

  const fixInstructions = `Security Issue: ${finding.title ?? finding.ruleId}
Rule: ${finding.ruleId}
Severity: ${SEVERITY_LABELS[finding.severity]} (${finding.severity})
Surface: ${SURFACE_LABELS[finding.target.kind]}
Target: ${finding.target.name}
Fingerprint: ${finding.fingerprint}

${finding.description ?? ''}

Please fix the issue identified by rule ${finding.ruleId} in ${finding.target.name}.
The fix is verified when this fingerprint no longer fires on re-scan.`;

  async function handleCopyBaseline() {
    await copyToClipboard(JSON.stringify(baselineEntry, null, 2));
    setCopiedBaseline(true);
    setTimeout(() => setCopiedBaseline(false), 2000);
  }

  async function handleCopyInstructions() {
    await copyToClipboard(fixInstructions);
    setCopiedInstructions(true);
    setTimeout(() => setCopiedInstructions(false), 2000);
  }

  const correlated = finding.correlatedWith && finding.correlatedWith.length > 0;
  const fixRef = finding.externalRefs?.[0];

  return (
    <div>
      <div className="page-header">
        <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: 12 }}>← Back to findings</button>
        <h1 className="page-title">{finding.title ?? finding.ruleId}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20, marginTop: 8 }}>
          <SeverityChip severity={finding.severity} />
          <SurfaceChip kind={finding.target.kind} />
          {finding.suppressed && <span className="pill pill-unknown">{BASELINE_LABELS.suppressed}</span>}
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20, alignItems: 'start' }}>

          {/* Main column */}
          <div>
            {/* Business consequence / plain-English description */}
            {finding.description && (
              <div className="card mb-20">
                <div className="card-title mb-8">What this means for your business</div>
                <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text-primary)' }}>{finding.description}</p>
              </div>
            )}

            {/* Evidence (collapsed by default) */}
            {finding.evidence?.snippet && (
              <div className="mb-20">
                <button
                  className="collapsible-toggle"
                  onClick={() => setEvidenceOpen(o => !o)}
                  aria-expanded={evidenceOpen}
                >
                  <span>Evidence snippet</span>
                  <span>{evidenceOpen ? '▲' : '▼'}</span>
                </button>
                {evidenceOpen && (
                  <div className="evidence-block" style={{ borderTop: 'none', borderRadius: '0 0 var(--radius-sm) var(--radius-sm)' }}>
                    {finding.evidence.snippet}
                  </div>
                )}
              </div>
            )}

            {/* Correlated evidence pair */}
            {correlated && (
              <div className="card mb-20">
                <div className="card-title mb-12">Correlated Evidence</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--surface-static)', marginBottom: 8 }}>
                      {SURFACE_LABELS.static}
                    </div>
                    <div style={{ background: 'var(--bg-inset)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {finding.location?.file && <div><span className="text-muted">File: </span>{finding.location.file}</div>}
                      {finding.location?.symbol && <div><span className="text-muted">Symbol: </span>{finding.location.symbol}</div>}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--surface-live)', marginBottom: 8 }}>
                      {SURFACE_LABELS.live}
                    </div>
                    <div style={{ background: 'var(--bg-inset)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {finding.correlatedWith?.map(fp => (
                        <div key={fp} className="tag">{fp.slice(0, 16)}…</div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Severity computation breakdown */}
            <div className="card mb-20">
              <div className="card-title mb-12">How this risk was scored</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <SevTraceStep
                  label={`Base severity: ${SEVERITY_LABELS[finding.severity]}`}
                  desc={`Scanner rule assigned ${finding.severity} severity.`}
                  sevColor={`var(--sev-${finding.severity})`}
                  abbr={finding.severity.charAt(0).toUpperCase()}
                />
                {finding.reachability === 'unauthenticated' && (
                  <SevTraceStep
                    label="Accessible without login (+1 step)"
                    desc="This issue is reachable without authentication, increasing the risk."
                    sevColor="var(--sev-critical)"
                    abbr="+"
                  />
                )}
                {finding.reachability === 'admin' && (
                  <SevTraceStep
                    label="Admin-only path (−1 step)"
                    desc="This issue is only reachable from admin paths, reducing the risk."
                    sevColor="var(--sev-low)"
                    abbr="−"
                  />
                )}
                {correlated && (
                  <SevTraceStep
                    label="Confirmed on the live test site (+1 step)"
                    desc="This issue was detected both in the code and on the live test site."
                    sevColor="var(--sev-critical)"
                    abbr="!"
                  />
                )}
                {finding.reachability === 'unknown' && (
                  <SevTraceStep
                    label="Reachability unknown (neutral)"
                    desc="Could not determine how this code is reached. No modifier applied."
                    sevColor="var(--text-muted)"
                    abbr="?"
                  />
                )}
              </div>
            </div>

            {/* Copy affordances (local clipboard only, no network) */}
            <div className="card">
              <div className="card-title mb-12">Actions</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Copy baseline entry JSON — paste into <code className="tag">config/baseline.json</code> to acknowledge this risk (requires PR review)
                  </div>
                  <button className="btn btn-copy" onClick={() => void handleCopyBaseline()}>
                    {copiedBaseline ? '✓ Copied!' : 'Copy baseline entry JSON'}
                  </button>
                </div>
                <hr className="divider" />
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Copy fix instructions — ready-to-paste prompt for manual fixing
                  </div>
                  <button className="btn btn-copy" onClick={() => void handleCopyInstructions()}>
                    {copiedInstructions ? '✓ Copied!' : 'Copy fix instructions'}
                  </button>
                </div>
                <hr className="divider" />
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Send for fixing — files a fix request in the target repo (wired in P8)
                  </div>
                  {fixRef ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <FixStatusChip status={fixRef.status} />
                      <a href={fixRef.url} target="_blank" rel="noreferrer" className="btn btn-ghost" style={{ fontSize: 11 }}>
                        View issue ↗
                      </a>
                    </div>
                  ) : (
                    <div>
                      <button
                        className="btn btn-fix"
                        disabled
                        aria-disabled="true"
                        title="Fix-sending will be enabled in P8"
                      >
                        Send for fixing
                      </button>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                        Fix-sending will be wired in P8. Use "Copy fix instructions" to fix manually.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div>
            <div className="card mb-12">
              <div className="card-title mb-12">Details</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12 }}>
                <div>
                  <div className="info-row-label">Rule ID</div>
                  <div className="tag" style={{ marginTop: 3 }}>{finding.ruleId}</div>
                </div>
                <div>
                  <div className="info-row-label">Fingerprint</div>
                  <div className="tag" style={{ marginTop: 3, wordBreak: 'break-all', fontFamily: 'var(--mono)' }}>f-{finding.fingerprint.slice(0, 16)}</div>
                </div>
                {finding.firstSeen && (
                  <div>
                    <div className="info-row-label">First seen</div>
                    <div style={{ color: 'var(--text-primary)', marginTop: 2 }}>{new Date(finding.firstSeen).toLocaleDateString()}</div>
                  </div>
                )}
                {finding.location?.file && (
                  <div>
                    <div className="info-row-label">File</div>
                    <div className="tag" style={{ marginTop: 3 }}>{finding.location.file}</div>
                  </div>
                )}
                {finding.location?.line && (
                  <div>
                    <div className="info-row-label">Line</div>
                    <div style={{ color: 'var(--text-primary)' }}>{finding.location.line}</div>
                  </div>
                )}
                <div>
                  <div className="info-row-label">Confidence</div>
                  <div style={{ color: 'var(--text-primary)', textTransform: 'capitalize' }}>{finding.confidence}</div>
                </div>
              </div>
            </div>

            {finding.suppression && (
              <div className="card" style={{ borderColor: 'var(--status-partial-border)' }}>
                <div className="card-title mb-8">Acknowledged Risk</div>
                {finding.suppression.justification && (
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{finding.suppression.justification}</p>
                )}
                {finding.suppression.approvedBy && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Approved by: {finding.suppression.approvedBy}</div>
                )}
                {finding.suppression.expiry && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Expires: {finding.suppression.expiry}
                  </div>
                )}
              </div>
            )}

            {finding.note && (
              <div className="card mt-8" style={{ background: 'rgba(245,200,66,0.05)', borderColor: 'var(--status-partial-border)' }}>
                <div className="card-title mb-4">Note</div>
                <p style={{ fontSize: 12, color: 'var(--status-partial)' }}>{finding.note}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SevTraceStep({ label, desc, sevColor, abbr }: { label: string; desc: string; sevColor: string; abbr: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: 11, border: `2px solid ${sevColor}`, color: sevColor,
        }}>
          {abbr}
        </div>
      </div>
      <div style={{ flex: 1, paddingTop: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{desc}</div>
      </div>
    </div>
  );
}
