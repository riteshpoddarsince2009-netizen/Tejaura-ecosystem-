import { useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, LogOut, ShieldAlert, ShieldCheck } from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type { SystemOverviewResponse } from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface SecuritySettingsViewProps {
  overview: SystemOverviewResponse | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
  onSignedOut: (notice?: string) => void;
}

export function SecuritySettingsView({
  overview,
  loading,
  onRefresh,
  onSignedOut,
}: SecuritySettingsViewProps) {
  const [mfaLabel, setMfaLabel] = useState('Owner Authenticator');
  const [mfaProvisioning, setMfaProvisioning] = useState<{
    factor_id: string;
    otpauth_uri?: string;
    provisioning_secret?: string;
  } | null>(null);
  const [copiedUri, setCopiedUri] = useState(false);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function handleEnrollMfa(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      const res = await controlPlaneApi.enrollMfa(mfaLabel.trim() || 'Owner Authenticator');
      setMfaProvisioning({
        factor_id: res.factor_id,
        otpauth_uri: res.otpauth_uri,
        provisioning_secret: res.provisioning_secret,
      });
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enroll TOTP MFA factor.');
    } finally {
      setBusy(false);
    }
  }

  async function copyProvisioningUri() {
    if (!mfaProvisioning?.otpauth_uri) return;
    try {
      await navigator.clipboard.writeText(mfaProvisioning.otpauth_uri);
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 2000);
    } catch {
      setError('Clipboard copy blocked. Copy the provisioning details manually.');
    }
  }

  async function handleLogout() {
    setBusy(true);
    setError(null);
    try {
      await controlPlaneApi.logout();
      onSignedOut('You have signed out cleanly.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logout failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeAll() {
    setBusy(true);
    setError(null);
    try {
      const res = await controlPlaneApi.revokeAllSessions();
      setConfirmRevokeAll(false);
      onSignedOut(`Revoked ${res.revoked_count} active session(s). Please sign in again.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke active sessions.');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !overview) {
    return <div className="h-44 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />;
  }

  if (!overview) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-5 text-sm text-slate-400">
        Security and session metadata is unavailable.
      </div>
    );
  }

  const posture = overview.auth_posture;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-50">
          Settings & Security
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Session controls, TOTP MFA enrollment, transport posture, and non-sensitive secret presence metadata.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-sm text-rose-200"
        >
          {error}
        </div>
      )}

      {statusMessage && (
        <div
          role="status"
          className="rounded-xl border border-cyan-500/35 bg-cyan-950/25 p-3 text-sm text-cyan-200"
        >
          {statusMessage}
        </div>
      )}

      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-indigo-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-100">Active Owner Session</h3>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <div>
            <dt className="text-slate-400">Owner Identity</dt>
            <dd className="text-slate-100 font-mono mt-0.5">
              {overview.owner.username} ({overview.owner.owner_id})
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">RBAC Role</dt>
            <dd className="text-cyan-300 font-mono mt-0.5">{overview.owner.role}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Session ID</dt>
            <dd className="text-slate-200 font-mono mt-0.5 truncate">{overview.owner.session_id}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Absolute Expiration</dt>
            <dd className="text-slate-200 font-mono tabular-nums mt-0.5">
              {formatTimestamp(overview.owner.expires_at)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Idle Timeout</dt>
            <dd className="text-slate-200 font-mono tabular-nums mt-0.5">
              {formatTimestamp(overview.owner.idle_expires_at)}
            </dd>
          </div>
          {posture && (
            <div>
              <dt className="text-slate-400">Active Sessions</dt>
              <dd className="text-slate-100 font-mono tabular-nums mt-0.5">
                {posture.active_sessions_count} active
              </dd>
            </div>
          )}
        </dl>

        {confirmRevokeAll ? (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/25 p-3.5 space-y-2.5">
            <p className="text-xs text-rose-200">
              Revoke all active owner sessions across all phones and browsers? You will need to sign in again immediately.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRevokeAll()}
                className="min-h-[44px] px-4 rounded-xl bg-rose-600 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {busy ? 'Revoking…' : 'Confirm Revoke All Sessions'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmRevokeAll(false)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleLogout()}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#030712] px-4 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <LogOut className="h-4 w-4 text-slate-300" aria-hidden="true" />
              <span>Sign Out Current Session</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmRevokeAll(true)}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-950/30 px-4 text-xs font-medium text-rose-200 hover:bg-rose-900/40 disabled:opacity-50"
            >
              <ShieldAlert className="h-4 w-4" aria-hidden="true" />
              <span>Revoke All Sessions</span>
            </button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-cyan-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">
              Multi-Factor Authentication (TOTP)
            </h3>
          </div>
          {posture && (
            <span className="text-xs font-mono tabular-nums text-slate-400">
              {posture.mfa_enrolled_count} enrolled · {posture.recovery_codes_remaining} recovery codes left
            </span>
          )}
        </div>

        <form onSubmit={handleEnrollMfa} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            aria-label="Authenticator device label"
            value={mfaLabel}
            onChange={(e) => setMfaLabel(e.target.value)}
            maxLength={64}
            placeholder="Owner Android Authenticator"
            className="flex-1 min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 whitespace-nowrap"
          >
            Enroll TOTP Factor
          </button>
        </form>

        {mfaProvisioning && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 space-y-2.5 text-xs">
            <p className="font-medium text-amber-200">
              Add this TOTP secret to your authenticator app now. It is displayed only once during enrollment.
            </p>
            <div className="space-y-1 font-mono text-slate-200 break-all bg-[#030712] border border-slate-800 rounded-lg p-3">
              <div>Factor ID: {mfaProvisioning.factor_id}</div>
              {mfaProvisioning.provisioning_secret && (
                <div className="text-cyan-300 select-all">
                  Secret: {mfaProvisioning.provisioning_secret}
                </div>
              )}
              {mfaProvisioning.otpauth_uri && (
                <div className="text-slate-400 select-all">
                  URI: {mfaProvisioning.otpauth_uri}
                </div>
              )}
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              {mfaProvisioning.otpauth_uri && (
                <button
                  type="button"
                  onClick={() => void copyProvisioningUri()}
                  className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 rounded-xl border border-slate-700 bg-[#0B1120] text-slate-200 hover:bg-slate-800"
                >
                  {copiedUri ? (
                    <>
                      <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                      <span>Copied URI</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" aria-hidden="true" />
                      <span>Copy otpauth URI</span>
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMfaProvisioning(null);
                  setStatusMessage('TOTP factor registered. Require MFA code on future owner sign-ins.');
                }}
                className="min-h-[44px] px-4 rounded-xl bg-indigo-600 font-medium text-white hover:bg-indigo-500"
              >
                Dismiss Secret Display
              </button>
            </div>
          </div>
        )}
      </section>

      {posture && (
        <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Session Cookie & Transport Posture
          </h3>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <dt className="text-slate-400">Cookie Name</dt>
              <dd className="text-slate-200 font-mono mt-0.5 break-all">{posture.cookie_name}</dd>
            </div>
            <div>
              <dt className="text-slate-400">HttpOnly Cookie</dt>
              <dd className="text-emerald-400 font-mono mt-0.5">{String(posture.http_only)}</dd>
            </div>
            <div>
              <dt className="text-slate-400">SameSite Policy</dt>
              <dd className="text-slate-200 font-mono mt-0.5">{posture.same_site}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Secure Cookie Flag</dt>
              <dd className="text-emerald-400 font-mono mt-0.5">{String(posture.secure_cookie)}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Production HTTPS Required</dt>
              <dd className="text-emerald-400 font-mono mt-0.5">
                {String(posture.enforce_https_in_deployment)}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Secret Key Inventory (Presence Metadata Only)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Master encryption keys, AirLLM worker bearer tokens, and vault ciphertexts remain server-side only and are never readable by browser clients.
          </p>
        </div>

        {overview.secrets_inventory.length === 0 ? (
          <p className="text-xs text-slate-500">No secret entries indexed.</p>
        ) : (
          <div className="divide-y divide-slate-800/80 border-t border-slate-800/80">
            {overview.secrets_inventory.map((entry) => (
              <div
                key={`${entry.source}:${entry.key}`}
                className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-mono font-medium text-slate-100 break-all">
                    {entry.key}
                  </div>
                  <div className="font-mono text-slate-400 mt-0.5">
                    Source: {entry.source} · Scope: {entry.scope}
                    {entry.updated_at ? ` · Updated ${formatTimestamp(entry.updated_at)}` : ''}
                  </div>
                </div>
                <span
                  className={`font-medium shrink-0 ${
                    entry.present ? 'text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {entry.present ? 'Configured' : 'Not Set'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
