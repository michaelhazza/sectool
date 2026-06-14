import { useState, useEffect, useRef } from 'react';
import type { ScanJob, ScanJobState, TargetsConfig } from '../types.js';
import { fetchTargetsConfig, triggerScan, fetchScanJobs } from '../api.js';

const POLL_INTERVAL_MS = 5000;

const TERMINAL_STATES: ScanJobState[] = ['complete', 'failed', 'timed_out'];

function isTerminal(state: ScanJobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function RunAScan() {
  const [config, setConfig] = useState<TargetsConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedUrl, setSelectedUrl] = useState('');

  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ScanJob | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchTargetsConfig()
      .then(setConfig)
      .catch((e: unknown) => {
        setConfigError(e instanceof Error ? e.message : 'Failed to load config');
      });
  }, []);

  useEffect(() => {
    if (activeJobId === null) return;

    function poll() {
      fetchScanJobs()
        .then((jobs) => {
          const job = jobs.find((j) => j.jobId === activeJobId) ?? null;
          setActiveJob(job);
          if (job && isTerminal(job.state)) {
            if (pollRef.current !== null) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }
        })
        .catch(() => {
          // polling error — keep trying until terminal state or unmount
        });
    }

    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeJobId]);

  const repos = config?.repoTargets.filter((r) => r.enabled) ?? [];
  const stagingTargets = config?.stagingTargets.filter((s) => s.enabled) ?? [];

  const hasRepos = repos.length > 0;
  const hasStagingTargets = stagingTargets.length > 0;
  const configReady = hasRepos && hasStagingTargets;

  const scanInProgress = activeJob !== null && activeJob.state === 'in_progress';
  const canSubmit =
    configReady &&
    selectedRepo !== '' &&
    selectedUrl !== '' &&
    !dispatching &&
    !scanInProgress;

  async function handleRunScan() {
    if (!canSubmit) return;
    setDispatching(true);
    setDispatchError(null);
    setActiveJob(null);
    setActiveJobId(null);
    try {
      const { jobId } = await triggerScan(selectedRepo, selectedUrl);
      setActiveJobId(jobId);
    } catch (e: unknown) {
      setDispatchError(e instanceof Error ? e.message : 'Scan request failed');
    } finally {
      setDispatching(false);
    }
  }

  const statusMessage = (() => {
    if (dispatching) return null;
    if (!activeJob) return null;
    if (activeJob.state === 'in_progress') return 'Scan dispatched — waiting for results';
    if (activeJob.state === 'complete') return 'Scan complete. Results are available in the report views.';
    if (activeJob.state === 'failed') return 'Scan failed to dispatch. Check your configuration and try again.';
    if (activeJob.state === 'timed_out') return 'Scan timed out. The CI job may still be running — check GitHub Actions.';
    if (activeJob.state === 'pre_dispatch') return 'Dispatch in progress…';
    return null;
  })();

  const statusVariant: 'info' | 'success' | 'error' | null = (() => {
    if (!activeJob) return null;
    if (activeJob.state === 'in_progress' || activeJob.state === 'pre_dispatch') return 'info';
    if (activeJob.state === 'complete') return 'success';
    return 'error';
  })();

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Run a Scan</h1>
        <p className="page-subtitle">Trigger an on-demand security scan against a registered target</p>
      </div>
      <div className="page-body">
        <div className="card" style={{ maxWidth: 560 }}>

          {configError && (
            <div
              role="alert"
              style={{
                marginBottom: 20,
                padding: '10px 14px',
                background: 'rgba(var(--sev-critical-rgb, 220,38,38), 0.08)',
                border: '1px solid var(--sev-critical)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--sev-critical)',
                fontSize: 13,
              }}
            >
              Could not load scan targets: {configError}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Repo dropdown */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label
                htmlFor="scan-repo"
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}
              >
                Repository
              </label>
              <select
                id="scan-repo"
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
                disabled={!hasRepos || dispatching || scanInProgress}
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-inset)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  minHeight: 44,
                  width: '100%',
                }}
              >
                <option value="">Select a repository…</option>
                {repos.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
              {!hasRepos && !configError && config !== null && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No enabled repositories found in the target registry.
                </div>
              )}
            </div>

            {/* Staging target dropdown */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label
                htmlFor="scan-url"
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}
              >
                Staging target
              </label>
              <select
                id="scan-url"
                value={selectedUrl}
                onChange={(e) => setSelectedUrl(e.target.value)}
                disabled={!hasStagingTargets || dispatching || scanInProgress}
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-inset)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  minHeight: 44,
                  width: '100%',
                }}
              >
                <option value="">Select a staging target…</option>
                {stagingTargets.map((s) => (
                  <option key={s.url ?? s.host ?? s.name} value={s.url ?? s.host ?? ''}>
                    {s.name}{s.host ? ` (${s.host})` : s.url ? ` (${s.url})` : ''}
                  </option>
                ))}
              </select>
              {!hasStagingTargets && !configError && config !== null && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No enabled staging targets found in the target registry.
                </div>
              )}
            </div>

            {/* Dispatch error */}
            {dispatchError && (
              <div
                role="alert"
                style={{
                  padding: '10px 14px',
                  background: 'rgba(var(--sev-critical-rgb, 220,38,38), 0.08)',
                  border: '1px solid var(--sev-critical)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--sev-critical)',
                  fontSize: 13,
                }}
              >
                {dispatchError}
              </div>
            )}

            {/* Status message */}
            {statusMessage && statusVariant && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  ...(statusVariant === 'info' && {
                    background: 'rgba(59,130,246,0.08)',
                    border: '1px solid rgba(59,130,246,0.4)',
                    color: 'var(--text-primary)',
                  }),
                  ...(statusVariant === 'success' && {
                    background: 'rgba(61,214,140,0.08)',
                    border: '1px solid var(--status-success)',
                    color: 'var(--status-success)',
                  }),
                  ...(statusVariant === 'error' && {
                    background: 'rgba(var(--sev-critical-rgb, 220,38,38), 0.08)',
                    border: '1px solid var(--sev-critical)',
                    color: 'var(--sev-critical)',
                  }),
                }}
              >
                {statusMessage}
              </div>
            )}

            {/* Submit button */}
            <button
              className="btn btn-primary"
              onClick={() => { void handleRunScan(); }}
              disabled={!canSubmit}
              style={{ minHeight: 44, fontWeight: 600, fontSize: 15 }}
            >
              {dispatching ? 'Dispatching…' : scanInProgress ? 'Scan in progress…' : 'Run scan'}
            </button>

          </div>
        </div>
      </div>
    </div>
  );
}
