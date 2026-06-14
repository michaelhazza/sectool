import { useState, useEffect, useCallback } from 'react';
import type { TargetsConfig, AllowlistConfig, BaselineConfig, ConfigHealthResponse } from '../types.js';
import {
  fetchTargetsConfig,
  fetchAllowlistConfig,
  fetchBaselineConfig,
  fetchConfigHealth,
  addRepo,
  editRepo,
  removeRepo,
  addStagingTarget,
  editStagingTarget,
  removeStagingTarget,
  addHost,
  removeHost,
} from '../api.js';
import { ALLOWLIST_LABEL, CONFIG_EDIT_DISABLED_LABEL } from '../vocabulary.js';
import { StepUpModal } from '../components/StepUpModal.js';
import { ConfigHistory } from '../components/ConfigHistory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Inline error / status display
// ---------------------------------------------------------------------------

function ActionError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 14px',
        background: 'rgba(var(--sev-critical-rgb,220,38,38),0.08)',
        border: '1px solid var(--sev-critical)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--sev-critical)',
        fontSize: 13,
        marginTop: 10,
      }}
    >
      <span>{message}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss error"
        style={{ background: 'none', border: 'none', color: 'var(--sev-critical)', cursor: 'pointer', fontSize: 16, padding: 0, flexShrink: 0, minHeight: 24 }}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable field row for inline forms
// ---------------------------------------------------------------------------

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</label>
      {children}
    </div>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  padding: '9px 11px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--bg-inset)',
  color: 'var(--text-primary)',
  fontSize: 13,
  minHeight: 44,
  width: '100%',
};

// ---------------------------------------------------------------------------
// Add / Edit Repo form
// ---------------------------------------------------------------------------

interface RepoFormProps {
  initial?: { name: string; gitUrl?: string; enabled: boolean };
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}

function RepoForm({ initial, onSave, onCancel }: RepoFormProps) {
  const isEdit = initial !== undefined;
  const [name, setName] = useState(initial?.name ?? '');
  const [gitUrl, setGitUrl] = useState(initial?.gitUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isEdit && name.trim() === '') { setError('Name is required.'); return; }
    if (!isEdit && gitUrl.trim() === '') { setError('Git URL is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (!isEdit) payload['name'] = name.trim();
      if (gitUrl.trim()) payload['gitUrl'] = gitUrl.trim();
      await onSave(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!isEdit && (
        <FieldRow label="Repository name">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={saving} style={INPUT_STYLE} placeholder="my-app" required />
        </FieldRow>
      )}
      <FieldRow label="Git URL">
        <input type="url" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} disabled={saving} style={INPUT_STYLE} placeholder="https://github.com/org/repo" required />
      </FieldRow>
      {error && <ActionError message={error} onDismiss={() => setError(null)} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-primary" disabled={saving} style={{ minHeight: 44, fontWeight: 600, flex: '1 1 auto' }}>
          {saving ? 'Saving…' : isEdit ? 'Save' : 'Add repo'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving} style={{ minHeight: 44, flex: '1 1 auto', background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit Staging Target form
// ---------------------------------------------------------------------------

interface StagingFormProps {
  initial?: { name: string; url?: string; host?: string; repo?: string; activeScan?: boolean; enabled: boolean };
  allowlistHosts: string[];
  onSave: (data: Record<string, unknown>, addHostOpt?: boolean) => Promise<void>;
  onCancel: () => void;
}

function StagingForm({ initial, allowlistHosts, onSave, onCancel }: StagingFormProps) {
  const isEdit = initial !== undefined;
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [repo, setRepo] = useState(initial?.repo ?? '');
  const [doAddHost, setDoAddHost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let detectedHost = '';
  try { detectedHost = url.trim() ? new URL(url.trim()).hostname : ''; } catch { /* invalid url */ }

  const hostAllowlisted = detectedHost !== '' && allowlistHosts.includes(detectedHost);
  const showAddHostPrompt = !isEdit && detectedHost !== '' && !hostAllowlisted;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isEdit && name.trim() === '') { setError('Name is required.'); return; }
    if (!isEdit && url.trim() === '') { setError('URL is required.'); return; }
    if (repo.trim() === '') { setError('Linked repo is required (the code repo this staging site belongs to).'); return; }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (!isEdit) { payload['name'] = name.trim(); payload['url'] = url.trim(); }
      if (repo.trim()) payload['repo'] = repo.trim();
      // activeScan is intentionally not set here — it requires an auth/test-user
      // config the form does not collect; new targets are passive-only. (Service
      // defaults activeScan:false on create; edit preserves the existing value.)
      await onSave(payload, doAddHost && showAddHostPrompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {!isEdit && (
        <>
          <FieldRow label="Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={saving} style={INPUT_STYLE} placeholder="staging-app" required />
          </FieldRow>
          <FieldRow label="Staging URL">
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} disabled={saving} style={INPUT_STYLE} placeholder="https://staging.example.com" required />
          </FieldRow>
        </>
      )}
      <FieldRow label="Linked repo (name of a registered repo, not a URL)">
        <input type="text" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={saving} style={INPUT_STYLE} placeholder="my-app" required />
      </FieldRow>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -4 }}>
        New targets are added as <strong>passive scan only</strong>. Active scanning needs login
        automation (test users) — configure that in <code style={{ fontFamily: 'var(--mono)' }}>config/targets.json</code>.
      </div>

      {showAddHostPrompt && (
        <div
          style={{
            background: 'rgba(59,130,246,0.07)',
            border: '1px solid rgba(59,130,246,0.3)',
            borderRadius: 'var(--radius-sm)',
            padding: '10px 12px',
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
            Host <code style={{ fontFamily: 'var(--mono)', background: 'var(--bg-inset)', padding: '1px 4px', borderRadius: 3 }}>{detectedHost}</code> is not on the approved list.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              id="also-add-host"
              checked={doAddHost}
              onChange={(e) => setDoAddHost(e.target.checked)}
              disabled={saving}
              style={{ width: 18, height: 18, cursor: 'pointer', flexShrink: 0 }}
            />
            <label htmlFor="also-add-host" style={{ fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
              Also add <strong>{detectedHost}</strong> to approved sites in the same change
            </label>
          </div>
        </div>
      )}

      {detectedHost !== '' && !isEdit && (
        <div style={{ fontSize: 12, color: hostAllowlisted ? 'var(--status-success)' : 'var(--text-muted)' }}>
          {hostAllowlisted ? `Host ${detectedHost} is already approved.` : !showAddHostPrompt ? '' : ''}
        </div>
      )}

      {error && <ActionError message={error} onDismiss={() => setError(null)} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-primary" disabled={saving} style={{ minHeight: 44, fontWeight: 600, flex: '1 1 auto' }}>
          {saving ? 'Saving…' : isEdit ? 'Save' : 'Add staging target'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving} style={{ minHeight: 44, flex: '1 1 auto', background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Add Host form
// ---------------------------------------------------------------------------

interface HostFormProps {
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}

function HostForm({ onSave, onCancel }: HostFormProps) {
  const [host, setHost] = useState('');
  const [owner, setOwner] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (host.trim() === '') { setError('Host is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        host: host.trim(),
        addedAt: new Date().toISOString().slice(0, 10),
      };
      if (owner.trim()) payload['owner'] = owner.trim();
      if (note.trim()) payload['note'] = note.trim();
      await onSave(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <FieldRow label="Hostname">
        <input type="text" value={host} onChange={(e) => setHost(e.target.value)} disabled={saving} style={INPUT_STYLE} placeholder="staging.example.com" required />
      </FieldRow>
      <FieldRow label="Owner (optional)">
        <input type="text" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={saving} style={INPUT_STYLE} placeholder="eng team" />
      </FieldRow>
      <FieldRow label="Note (optional)">
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} style={INPUT_STYLE} placeholder="Purpose or context" />
      </FieldRow>
      {error && <ActionError message={error} onDismiss={() => setError(null)} />}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-primary" disabled={saving} style={{ minHeight: 44, fontWeight: 600, flex: '1 1 auto' }}>
          {saving ? 'Saving…' : 'Add host'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving} style={{ minHeight: 44, flex: '1 1 auto', background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main TargetsSafety screen
// ---------------------------------------------------------------------------

type ActiveForm =
  | { kind: 'addRepo' }
  | { kind: 'editRepo'; name: string }
  | { kind: 'addStaging' }
  | { kind: 'editStaging'; name: string }
  | { kind: 'addHost' };

export function TargetsSafety() {
  const [targets, setTargets] = useState<TargetsConfig | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistConfig | null>(null);
  const [baseline, setBaseline] = useState<BaselineConfig | null>(null);
  const [health, setHealth] = useState<ConfigHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeForm, setActiveForm] = useState<ActiveForm | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [showStepUp, setShowStepUp] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null);

  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, a, b, h] = await Promise.all([
        fetchTargetsConfig(),
        fetchAllowlistConfig(),
        fetchBaselineConfig(),
        fetchConfigHealth().catch(() => null),
      ]);
      setTargets(t);
      setAllowlist(a);
      setBaseline(b);
      setHealth(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const editingEnabled = health?.configWriteDeps.ok === true;

  // Wrap any write action: on 403, open step-up modal then retry
  async function withStepUp(action: () => Promise<void>) {
    try {
      await action();
      setHistoryRefreshKey((k) => k + 1);
      await load();
      setActiveForm(null);
      setActionError(null);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 403) {
        // Session expired / first write → prompt for a 2FA code, then retry.
        setPendingAction(() => () => withStepUp(action));
        setShowStepUp(true);
        return;
      }
      // Re-throw so the caller surfaces it where the user is looking: the form's
      // own inline error (for Add/Edit), or the global banner (for row actions).
      throw e;
    }
  }

  // Run a row action (no form to show errors); surface failures in the global banner.
  function runRowAction(action: () => Promise<void>) {
    void withStepUp(action).catch((e: Error) => setActionError(e.message || 'Action failed'));
  }

  function handleStepUpSuccess() {
    setShowStepUp(false);
    if (pendingAction !== null) {
      const action = pendingAction;
      setPendingAction(null);
      void action().catch((e: Error) => setActionError(e.message || 'Action failed'));
    }
  }

  function handleStepUpCancel() {
    setShowStepUp(false);
    setPendingAction(null);
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  const repoTargets = targets?.repoTargets ?? [];
  const stagingTargets = targets?.stagingTargets ?? [];
  const allowlistHosts = allowlist?.hosts ?? [];
  const baselineEntries = baseline?.entries ?? [];
  const expiredEntries = baselineEntries.filter(e => e.expiry && daysUntilExpiry(e.expiry) < 0);

  // ---------------------------------------------------------------------------
  // Row actions
  // ---------------------------------------------------------------------------

  function handleDisableRepo(name: string, currentEnabled: boolean) {
    runRowAction(() => editRepo(name, { enabled: !currentEnabled }) as Promise<void>);
  }

  function handleRemoveRepo(name: string) {
    if (!confirm(`Remove repository "${name}"? This cannot be undone without a revert.`)) return;
    runRowAction(() => removeRepo(name) as Promise<void>);
  }

  function handleDisableStaging(name: string, currentEnabled: boolean) {
    runRowAction(() => editStagingTarget(name, { enabled: !currentEnabled }) as Promise<void>);
  }

  function handleRemoveStaging(name: string) {
    if (!confirm(`Remove staging target "${name}"? This cannot be undone without a revert.`)) return;
    runRowAction(() => removeStagingTarget(name) as Promise<void>);
  }

  function handleRemoveHost(host: string) {
    if (!confirm(`Remove "${host}" from approved sites? Any enabled staging target using it must be disabled first.`)) return;
    runRowAction(() => removeHost(host) as Promise<void>);
  }

  // ---------------------------------------------------------------------------
  // Form submission handlers
  // ---------------------------------------------------------------------------

  function handleSaveRepo(data: Record<string, unknown>) {
    if (activeForm?.kind === 'editRepo') {
      return withStepUp(() => editRepo(activeForm.name, data) as Promise<void>);
    }
    return withStepUp(() => addRepo(data) as Promise<void>);
  }

  function handleSaveStaging(data: Record<string, unknown>, doAddHost?: boolean) {
    if (activeForm?.kind === 'editStaging') {
      return withStepUp(() => editStagingTarget(activeForm.name, data) as Promise<void>);
    }
    return withStepUp(() => addStagingTarget(data, { addHost: doAddHost }) as Promise<void>);
  }

  function handleSaveHost(data: Record<string, unknown>) {
    return withStepUp(() => addHost(data) as Promise<void>);
  }

  // ---------------------------------------------------------------------------
  // Row action button component (reusable, ≥44px targets)
  // ---------------------------------------------------------------------------

  function RowAction({ label, onClick, variant = 'secondary' }: { label: string; onClick: () => void; variant?: 'secondary' | 'danger' }) {
    return (
      <button
        onClick={onClick}
        style={{
          fontSize: 11,
          padding: '6px 10px',
          minHeight: 44,
          minWidth: 44,
          background: 'var(--bg-inset)',
          border: `1px solid ${variant === 'danger' ? 'var(--sev-critical)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-sm)',
          color: variant === 'danger' ? 'var(--sev-critical)' : 'var(--text-secondary)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {label}
      </button>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) return <div className="page-body" style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  if (error) return <div className="page-body" style={{ color: 'var(--sev-critical)' }}>Error: {error}</div>;

  return (
    <div>
      {showStepUp && (
        <StepUpModal onSuccess={handleStepUpSuccess} onCancel={handleStepUpCancel} />
      )}

      <div className="page-header">
        <h1 className="page-title">Sites and Safety</h1>
        <p className="page-subtitle">
          {editingEnabled
            ? 'Manage registered targets and approved test sites. Changes are 2FA-gated and recorded in git.'
            : 'Read-only view of registered targets, approved test sites, and acknowledged risks.'}
        </p>
      </div>
      <div className="page-body">

        {/* Editing-disabled banner */}
        {health !== null && !health.configWriteDeps.ok && (
          <div
            role="alert"
            style={{
              marginBottom: 20,
              padding: '12px 16px',
              background: 'rgba(234,179,8,0.07)',
              border: '1px solid rgba(234,179,8,0.4)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              color: 'var(--text-primary)',
            }}
          >
            <strong>{CONFIG_EDIT_DISABLED_LABEL}</strong>
            {health.configWriteDeps.missing.length > 0 && (
              <span style={{ color: 'var(--text-muted)' }}>
                {' — missing: '}
                {health.configWriteDeps.missing.map((v) => (
                  <code key={v} style={{ fontFamily: 'var(--mono)', background: 'var(--bg-inset)', padding: '1px 4px', borderRadius: 3, marginRight: 4 }}>{v}</code>
                ))}
              </span>
            )}
          </div>
        )}

        {/* Global action error */}
        {actionError && <ActionError message={actionError} onDismiss={() => setActionError(null)} />}

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
                Expired baseline entries no longer suppress their findings. Update or remove them.
              </div>
            </div>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Source Repos */}
        {/* ---------------------------------------------------------------- */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <div className="section-heading" style={{ margin: 0 }}>Source Repositories (In the code)</div>
          {editingEnabled && activeForm?.kind !== 'addRepo' && (
            <button
              className="btn btn-primary"
              onClick={() => setActiveForm({ kind: 'addRepo' })}
              style={{ fontSize: 13, padding: '7px 14px', minHeight: 44 }}
            >
              + Add repo
            </button>
          )}
        </div>

        {activeForm?.kind === 'addRepo' && (
          <div className="card mb-24">
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14, color: 'var(--text-primary)' }}>Add repository</div>
            <RepoForm
              onSave={handleSaveRepo}
              onCancel={() => setActiveForm(null)}
            />
          </div>
        )}

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
                    {editingEnabled && <th aria-label="Actions"></th>}
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
                      {editingEnabled && (
                        <td>
                          {activeForm?.kind === 'editRepo' && activeForm.name === t.name ? (
                            <div style={{ padding: '8px 0' }}>
                              <RepoForm
                                initial={{ name: t.name, gitUrl: t.url, enabled: t.enabled }}
                                onSave={handleSaveRepo}
                                onCancel={() => setActiveForm(null)}
                              />
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <RowAction label="Edit" onClick={() => setActiveForm({ kind: 'editRepo', name: t.name })} />
                              <RowAction label={t.enabled ? 'Disable' : 'Enable'} onClick={() => handleDisableRepo(t.name, t.enabled)} />
                              <RowAction label="Remove" onClick={() => handleRemoveRepo(t.name)} variant="danger" />
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Staging targets */}
        {/* ---------------------------------------------------------------- */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <div className="section-heading" style={{ margin: 0 }}>Staging Targets (On the live test site)</div>
          {editingEnabled && activeForm?.kind !== 'addStaging' && (
            <button
              className="btn btn-primary"
              onClick={() => setActiveForm({ kind: 'addStaging' })}
              style={{ fontSize: 13, padding: '7px 14px', minHeight: 44 }}
            >
              + Add staging target
            </button>
          )}
        </div>

        {activeForm?.kind === 'addStaging' && (
          <div className="card mb-16">
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14, color: 'var(--text-primary)' }}>Add staging target</div>
            <StagingForm
              allowlistHosts={allowlistHosts.map(h => h.host)}
              onSave={handleSaveStaging}
              onCancel={() => setActiveForm(null)}
            />
          </div>
        )}

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
                    {editingEnabled && <th aria-label="Actions"></th>}
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
                      {editingEnabled && (
                        <td>
                          {activeForm?.kind === 'editStaging' && activeForm.name === t.name ? (
                            <div style={{ padding: '8px 0' }}>
                              <StagingForm
                                initial={{ name: t.name, url: t.url, host: t.host, repo: t.repo, activeScan: t.activeScan, enabled: t.enabled }}
                                allowlistHosts={allowlistHosts.map(h => h.host)}
                                onSave={handleSaveStaging}
                                onCancel={() => setActiveForm(null)}
                              />
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <RowAction label="Edit" onClick={() => setActiveForm({ kind: 'editStaging', name: t.name })} />
                              <RowAction label={t.enabled ? 'Disable' : 'Enable'} onClick={() => handleDisableStaging(t.name, t.enabled)} />
                              <RowAction label="Remove" onClick={() => handleRemoveStaging(t.name)} variant="danger" />
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Allowlist */}
        {/* ---------------------------------------------------------------- */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <div className="section-heading" style={{ margin: 0 }}>{ALLOWLIST_LABEL}</div>
          {editingEnabled && activeForm?.kind !== 'addHost' && (
            <button
              className="btn btn-primary"
              onClick={() => setActiveForm({ kind: 'addHost' })}
              style={{ fontSize: 13, padding: '7px 14px', minHeight: 44 }}
            >
              + Add host
            </button>
          )}
        </div>

        {!editingEnabled && (
          <div className="mb-8" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Hosts listed here may be scanned. All others are blocked. Changes are 2FA-gated and committed to git.
          </div>
        )}

        {activeForm?.kind === 'addHost' && (
          <div className="card mb-16">
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14, color: 'var(--text-primary)' }}>Add approved site</div>
            <HostForm
              onSave={handleSaveHost}
              onCancel={() => setActiveForm(null)}
            />
          </div>
        )}

        {allowlistHosts.length === 0 ? (
          <div className="card mb-24" style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '32px' }}>
            <div style={{ marginBottom: 8 }}>
              <svg viewBox="0 0 20 20" fill="var(--text-muted)" width="28" height="28">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>No approved test sites</div>
            <div>The live scan path cannot scan anything until hosts are added to the approved list.</div>
          </div>
        ) : (
          <div className="mb-24">
            {allowlistHosts.map(h => (
              <div
                key={h.host}
                style={{
                  background: 'var(--bg-inset)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '14px 16px',
                  marginBottom: 8,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--status-success)', marginBottom: 6 }}>{h.host}</div>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
                    {h.owner && <div><span style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Owner</span><br /><span style={{ color: 'var(--text-secondary)' }}>{h.owner}</span></div>}
                    {h.addedAt && <div><span style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Added</span><br /><span style={{ color: 'var(--text-secondary)' }}>{h.addedAt}</span></div>}
                    {h.note && <div><span style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Note</span><br /><span style={{ color: 'var(--text-secondary)' }}>{h.note}</span></div>}
                  </div>
                </div>
                {editingEnabled && (
                  <RowAction label="Remove" onClick={() => handleRemoveHost(h.host)} variant="danger" />
                )}
              </div>
            ))}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Baseline entries (read-only) */}
        {/* ---------------------------------------------------------------- */}
        <div className="section-heading">Acknowledged Risks</div>
        <div className="mb-8" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          These findings have been reviewed and accepted. They will not show as open issues unless their expiry passes.
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

        {/* ---------------------------------------------------------------- */}
        {/* Change history (only when editing is configured) */}
        {/* ---------------------------------------------------------------- */}
        {health !== null && health.editingEnabled && (
          <div className="card mb-24">
            <ConfigHistory refreshKey={historyRefreshKey} />
          </div>
        )}

      </div>
    </div>
  );
}
