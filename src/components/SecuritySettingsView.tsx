import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Lock,
  LogOut,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type {
  ActiveSessionInfo,
  MfaFactorInfo,
  OwnerProfileInfo,
  SystemOverviewResponse,
} from '../types/controlPlane.ts';
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
  const [profile, setProfile] = useState<OwnerProfileInfo | null>(null);
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>([]);
  const [factors, setFactors] = useState<MfaFactorInfo[]>([]);
  const [recoveryRemaining, setRecoveryRemaining] = useState<number | null>(null);

  // Profile form
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [timezone, setTimezone] = useState('UTC');

  // Password change form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // MFA enrollment & verification password
  const [mfaLabel, setMfaLabel] = useState('Owner Authenticator');
  const [mfaVerifyPassword, setMfaVerifyPassword] = useState('');
  const [mfaProvisioning, setMfaProvisioning] = useState<{
    factor_id: string;
    otpauth_uri?: string;
    provisioning_secret?: string;
  } | null>(null);
  const [copiedUri, setCopiedUri] = useState(false);

  // Recovery codes regeneration
  const [regenPassword, setRegenPassword] = useState('');
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);
  const [copiedRecovery, setCopiedRecovery] = useState(false);

  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadAccountDetails = useCallback(async () => {
    if (!overview?.owner) return;
    try {
      const [profileRes, sessionsRes, mfaRes] = await Promise.all([
        controlPlaneApi.getProfile(),
        controlPlaneApi.listSessions(),
        controlPlaneApi.listMfaFactors(),
      ]);
      setProfile(profileRes.profile);
      setDisplayName(profileRes.profile.display_name ?? '');
      setEmail(profileRes.profile.email);
      setTimezone(profileRes.profile.timezone || 'UTC');
      setSessions(sessionsRes.sessions);
      setFactors(mfaRes.factors);
      setRecoveryRemaining(mfaRes.recovery_codes_remaining);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load owner profile and sessions.',
      );
    }
  }, [overview?.owner]);

  useEffect(() => {
    void loadAccountDetails();
  }, [loadAccountDetails]);

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      const res = await controlPlaneApi.updateProfile({
        display_name: displayName.trim(),
        email: email.trim(),
        timezone: timezone.trim() || 'UTC',
      });
      setProfile(res.profile);
      setStatusMessage('Owner profile updated.');
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update owner profile.');
    } finally {
      setBusy(false);
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      const res = await controlPlaneApi.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setStatusMessage(
        `Password updated. Revoked ${res.revoked_other_sessions} other active session(s).`,
      );
      await loadAccountDetails();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password.');
    } finally {
      setBusy(false);
    }
  }

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
      await loadAccountDetails();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enroll TOTP MFA factor.');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleFactor(factor: MfaFactorInfo) {
    if (!mfaVerifyPassword) {
      setError('Enter your current password in the MFA confirmation field before toggling an MFA factor.');
      return;
    }
    setError(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      await controlPlaneApi.toggleMfaFactor(
        factor.factor_id,
        !factor.enabled,
        mfaVerifyPassword,
      );
      setMfaVerifyPassword('');
      setStatusMessage(
        `MFA factor "${factor.label}" ${!factor.enabled ? 'enabled' : 'disabled'}.`,
      );
      await loadAccountDetails();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update MFA factor.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveFactor(factor: MfaFactorInfo) {
    if (!mfaVerifyPassword) {
      setError('Enter your current password in the MFA confirmation field before removing an MFA factor.');
      return;
    }
    setError(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      await controlPlaneApi.removeMfaFactor(factor.factor_id, mfaVerifyPassword);
      setMfaVerifyPassword('');
      setStatusMessage(`MFA factor "${factor.label}" removed.`);
      await loadAccountDetails();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove MFA factor.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerateRecoveryCodes(e: FormEvent) {
    e.preventDefault();
    if (!regenPassword) {
      setError('Enter your current password to regenerate single-use recovery codes.');
      return;
    }
    setError(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      const res = await controlPlaneApi.regenerateRecoveryCodes(regenPassword);
      setRegenPassword('');
      setNewRecoveryCodes(res.recovery_codes);
      setStatusMessage('Generated new single-use recovery codes. Previous unused codes are now invalid.');
      await loadAccountDetails();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate recovery codes.');
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

  async function copyGeneratedRecoveryCodes() {
    if (!newRecoveryCodes) return;
    try {
      await navigator.clipboard.writeText(newRecoveryCodes.join('\n'));
      setCopiedRecovery(true);
      setTimeout(() => setCopiedRecovery(false), 2000);
    } catch {
      setError('Clipboard copy blocked. Copy the recovery codes manually.');
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

  async function handleRevokeSingleSession(sessionId: string) {
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await controlPlaneApi.revokeSession(sessionId);
      if (res.revoked_current) {
        onSignedOut('Current session revoked. Please sign in again.');
        return;
      }
      setStatusMessage(`Session ${sessionId} revoked.`);
      await loadAccountDetails();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeOthers() {
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await controlPlaneApi.revokeOtherSessions();
      setStatusMessage(`Revoked ${res.revoked_count} other active session(s).`);
      await loadAccountDetails();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke other sessions.');
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
  const effectiveRecoveryRemaining =
    recoveryRemaining ?? posture?.recovery_codes_remaining ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            Owner Profile & Security Center
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Profile identity, Argon2id password rotation, active sessions, TOTP MFA, recovery codes, and secret presence inventory.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadAccountDetails()}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#0B1120] px-4 text-xs font-medium text-slate-200 hover:bg-slate-800 self-start"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Refresh Security State</span>
        </button>
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

      {/* 1. Owner Profile */}
      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-indigo-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">Owner Profile</h3>
          </div>
          <span className="text-xs font-mono text-slate-400">
            {overview.owner.username} · {overview.owner.role}
          </span>
        </div>

        <form onSubmit={handleSaveProfile} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="owner-display-name" className="block text-xs text-slate-300 mb-1">
              Display Name
            </label>
            <input
              id="owner-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ritesh (Owner)"
              maxLength={80}
              className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="owner-email" className="block text-xs text-slate-300 mb-1">
              Owner Email
            </label>
            <input
              id="owner-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@example.com"
              className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="owner-timezone" className="block text-xs text-slate-300 mb-1">
              Timezone (IANA)
            </label>
            <input
              id="owner-timezone"
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="UTC"
              maxLength={64}
              className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div className="sm:col-span-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              {profile
                ? `Password rotated: ${formatTimestamp(profile.password_changed_at)} · Updated: ${formatTimestamp(profile.updated_at)}`
                : `Owner ID: ${overview.owner.owner_id}`}
            </span>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Save Profile
            </button>
          </div>
        </form>
      </section>

      {/* 2. Password Rotation */}
      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-cyan-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-100">Change Owner Password</h3>
        </div>
        <p className="text-xs text-slate-400">
          Verified against Argon2id hash. Rotating your password immediately revokes all other active sessions.
        </p>
        <form onSubmit={handleChangePassword} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <label htmlFor="pw-current" className="block text-xs text-slate-300 mb-1">
              Current Password
            </label>
            <input
              id="pw-current"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="pw-new" className="block text-xs text-slate-300 mb-1">
              New Passphrase (min 14 chars, 3+ classes)
            </label>
            <input
              id="pw-new"
              type="password"
              required
              minLength={14}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Update Password
          </button>
        </form>
      </section>

      {/* 3. Active Owner Sessions */}
      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-indigo-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">Active Owner Sessions</h3>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {sessions.length || posture?.active_sessions_count || 1} active
          </span>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs border-b border-slate-800/80 pb-3">
          <div>
            <dt className="text-slate-400">Current Session ID</dt>
            <dd className="text-slate-200 font-mono mt-0.5 truncate">{overview.owner.session_id}</dd>
          </div>
          <div>
            <dt className="text-slate-400">RBAC Role</dt>
            <dd className="text-cyan-300 font-mono mt-0.5">{overview.owner.role}</dd>
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
        </dl>

        {sessions.length > 0 && (
          <div className="divide-y divide-slate-800/80 border border-slate-800/80 rounded-xl overflow-hidden">
            {sessions.map((sess) => (
              <div
                key={sess.session_id}
                className="p-3 bg-[#030712]/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="font-mono text-slate-100 flex items-center gap-2">
                    <span className="truncate">{sess.session_id}</span>
                    {sess.is_current && (
                      <span className="text-cyan-300 font-semibold">Current</span>
                    )}
                  </div>
                  <div className="text-slate-400 font-mono tabular-nums truncate">
                    IP: {sess.ip_address} · Last seen: {formatTimestamp(sess.last_seen_at)} ·{' '}
                    {sess.user_agent}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRevokeSingleSession(sess.session_id)}
                  className="min-h-[44px] px-3.5 rounded-xl border border-slate-700 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 shrink-0"
                >
                  {sess.is_current ? 'Sign Out Here' : 'Revoke Session'}
                </button>
              </div>
            ))}
          </div>
        )}

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
          <div className="flex flex-col sm:flex-row flex-wrap gap-2.5 pt-1">
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
              onClick={() => void handleRevokeOthers()}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#030712] px-4 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <span>Revoke Other Sessions</span>
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

      {/* 4. MFA & Recovery Codes */}
      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-cyan-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">
              Multi-Factor Authentication (TOTP) & Recovery Codes
            </h3>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {factors.filter((f) => f.enabled).length || posture?.mfa_enrolled_count || 0} active factor(s) ·{' '}
            {effectiveRecoveryRemaining} recovery codes left
          </span>
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

        {factors.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-slate-800/80">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <label htmlFor="mfa-verify-pw" className="text-xs text-slate-300 shrink-0">
                Confirm password to toggle or remove MFA factors:
              </label>
              <input
                id="mfa-verify-pw"
                type="password"
                value={mfaVerifyPassword}
                onChange={(e) => setMfaVerifyPassword(e.target.value)}
                placeholder="Current owner password"
                className="flex-1 min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800/80">
              {factors.map((factor) => (
                <div
                  key={factor.factor_id}
                  className="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs"
                >
                  <div>
                    <div className="font-medium text-slate-100">
                      {factor.label}{' '}
                      <span className="font-mono text-slate-400">({factor.factor_id})</span>
                    </div>
                    <div className="font-mono text-slate-400 mt-0.5 tabular-nums">
                      Type: {factor.type} · Status:{' '}
                      <span className={factor.enabled ? 'text-emerald-400' : 'text-amber-300'}>
                        {factor.enabled ? 'Enabled' : 'Disabled'}
                      </span>{' '}
                      · Enrolled {formatTimestamp(factor.enrolled_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleFactor(factor)}
                      className="min-h-[44px] px-3.5 rounded-xl border border-slate-700 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {factor.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRemoveFactor(factor)}
                      aria-label={`Remove MFA factor ${factor.label}`}
                      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-rose-500/40 bg-rose-950/30 px-3 text-rose-200 hover:bg-rose-900/40 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

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

        {/* Regenerate Recovery Codes */}
        <div className="pt-3 border-t border-slate-800/80 space-y-3">
          <div className="text-xs font-semibold text-slate-200">
            Single-Use Recovery Codes ({effectiveRecoveryRemaining} remaining)
          </div>
          <form onSubmit={handleRegenerateRecoveryCodes} className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="password"
              aria-label="Current password to regenerate recovery codes"
              value={regenPassword}
              onChange={(e) => setRegenPassword(e.target.value)}
              placeholder="Current password to regenerate 8 new codes"
              className="flex-1 min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              className="min-h-[44px] px-4 rounded-xl border border-slate-700 bg-[#030712] text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
            >
              Regenerate Recovery Codes
            </button>
          </form>

          {newRecoveryCodes && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 space-y-2.5 text-xs">
              <p className="font-medium text-amber-200">
                Save these new recovery codes offline now. They will not be shown again.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 rounded-lg border border-slate-800 bg-[#030712] p-3 font-mono text-cyan-300 tabular-nums">
                {newRecoveryCodes.map((code) => (
                  <div key={code} className="select-all">
                    {code}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void copyGeneratedRecoveryCodes()}
                  className="min-h-[44px] px-4 rounded-xl border border-slate-700 bg-[#0B1120] text-slate-200 hover:bg-slate-800"
                >
                  {copiedRecovery ? 'Copied Codes' : 'Copy Recovery Codes'}
                </button>
                <button
                  type="button"
                  onClick={() => setNewRecoveryCodes(null)}
                  className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
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
