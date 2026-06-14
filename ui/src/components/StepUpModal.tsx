import { useState, useRef, useEffect } from 'react';
import { stepUp } from '../api.js';

interface StepUpModalProps {
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * 2FA step-up modal — prompts for a 6-digit TOTP code and exchanges it for
 * the step-up session cookie. On success, calls onSuccess so the caller can
 * retry the pending write. Stays open on wrong/expired codes with a clear
 * error.
 */
export function StepUpModal({ onSuccess, onCancel }: StepUpModalProps) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setError('Enter a 6-digit code from your authenticator app.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await stepUp(code);
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg.includes('invalid') || msg.includes('403')) {
        setError('Wrong or expired code — try again.');
      } else {
        setError(msg);
      }
      setCode('');
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Two-factor authentication required"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        padding: '16px',
      }}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: '28px 24px',
          width: '100%',
          maxWidth: 400,
          boxShadow: '0 8px 32px rgba(0,0,0,0.32)',
        }}
      >
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6, color: 'var(--text-primary)' }}>
          2FA required
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.5 }}>
          Enter the 6-digit code from your authenticator app to save this change.
        </p>

        <form onSubmit={(e) => { void handleSubmit(e); }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            <label htmlFor="totp-code" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              Authenticator code
            </label>
            <input
              ref={inputRef}
              id="totp-code"
              type="tel"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => {
                setError(null);
                setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              }}
              disabled={submitting}
              placeholder="000000"
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                border: error ? '1px solid var(--sev-critical)' : '1px solid var(--border)',
                background: 'var(--bg-inset)',
                color: 'var(--text-primary)',
                fontSize: 22,
                letterSpacing: '0.25em',
                minHeight: 44,
                width: '100%',
                textAlign: 'center',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
          </div>

          {error && (
            <div
              role="alert"
              style={{
                marginBottom: 16,
                padding: '8px 12px',
                background: 'rgba(var(--sev-critical-rgb,220,38,38),0.08)',
                border: '1px solid var(--sev-critical)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--sev-critical)',
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || code.length !== 6}
              style={{ minHeight: 44, fontWeight: 600, fontSize: 15 }}
            >
              {submitting ? 'Verifying…' : 'Verify and save'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={onCancel}
              disabled={submitting}
              style={{
                minHeight: 44,
                background: 'var(--bg-inset)',
                border: '1px solid var(--border)',
                color: 'var(--text-secondary)',
                fontSize: 14,
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
