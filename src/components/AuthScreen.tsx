import { useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { ApiError, controlPlaneApi } from '../api/client.ts';
import type { OwnerSessionInfo } from '../types/controlPlane.ts';

interface AuthScreenProps {
  initialized: boolean;
  transportError?: string;
  sessionNotice?: string | null;
  embeddedFrame?: boolean;
  onAuthenticated: (owner: OwnerSessionInfo) => void;
  onSetupCompleted: () => void;
}

type AuthMode = 'setup' | 'login' | 'recover';

export function AuthScreen({
  initialized,
  transportError,
  sessionNotice,
  embeddedFrame,
  onAuthenticated,
  onSetupCompleted,
}: AuthScreenProps) {
  const inIframe =
    embeddedFrame === true ||
    (typeof window !== 'undefined' && (() => {
      try {
        return window.self !== window.top;
      } catch {
        return true;
      }
    })());
  const [mode, setMode] = useState<AuthMode>(initialized ? 'login' : 'setup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Setup fields
  const [ownerId, setOwnerId] = useState('owner_primary');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copiedCodes, setCopiedCodes] = useState(false);

  // Login fields
  const [identifier, setIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);

  // Recovery fields
  const [recoverIdentifier, setRecoverIdentifier] = useState('');
  const [recoverCode, setRecoverCode] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const effectiveMode: AuthMode = !initialized && mode === 'login' ? 'setup' : mode;

  async function handleSetupSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setBusy(true);
    try {
      const res = await controlPlaneApi.setupOwner({
        owner_id: ownerId.trim() || 'owner_primary',
        username: username.trim(),
        email: email.trim(),
        password: setupPassword,
      });
      setSetupPassword('');
      setRecoveryCodes(res.recovery_codes);
      setIdentifier(res.username);
      onSetupCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize owner account.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLoginSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setBusy(true);
    try {
      const res = await controlPlaneApi.login({
        identifier: identifier.trim(),
        password: loginPassword,
        mfa_code: mfaCode.trim() || undefined,
      });

      const verifyStatus = await controlPlaneApi.getAuthStatus();
      if (!verifyStatus.authenticated || !verifyStatus.owner) {
        if (verifyStatus.transport_error) {
          setError(verifyStatus.transport_error);
        } else if (verifyStatus.embedded_frame || inIframe) {
          setError(
            'Sign-in credentials succeeded, but your browser blocked the HttpOnly session cookie inside this embedded preview iframe. Open this TEJAURA URL directly in its own browser tab to sign in securely.',
          );
        } else {
          setError(
            'Sign-in credentials succeeded, but the browser did not persist the HttpOnly session cookie. Ensure HTTPS or localhost loopback and enable cookies.',
          );
        }
        return;
      }

      setLoginPassword('');
      setMfaCode('');
      onAuthenticated(verifyStatus.owner ?? res.owner);
    } catch (err) {
      if (err instanceof ApiError && err.mfaRequired) {
        setMfaRequired(true);
      }
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRecoverSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setBusy(true);
    try {
      const res = await controlPlaneApi.recoverAccount({
        identifier: recoverIdentifier.trim(),
        recovery_code: recoverCode.trim(),
        new_password: newPassword,
      });
      setRecoverCode('');
      setNewPassword('');
      setMode('login');
      setIdentifier(recoverIdentifier.trim());
      setInfoMessage(
        `Password updated and ${res.revoked_sessions} active session(s) revoked. ${res.remaining_recovery_codes} recovery code(s) remain.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account recovery failed.');
    } finally {
      setBusy(false);
    }
  }

  async function copyRecoveryCodes() {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCopiedCodes(true);
      setTimeout(() => setCopiedCodes(false), 2000);
    } catch {
      setError('Clipboard copy was blocked by browser permissions. Please copy codes manually.');
    }
  }

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col justify-center px-4 py-8 sm:px-6">
      <div className="w-full max-w-md mx-auto">
        <div className="mb-6">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-50">
                TEJAURA Control Plane
              </h1>
              <p className="text-xs text-slate-400">
                Human-governed local AI operations
              </p>
            </div>
          </div>
        </div>

        {transportError && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-rose-500/40 bg-rose-950/30 p-3.5 text-sm text-rose-200 flex items-start gap-2.5"
          >
            <ShieldAlert className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{transportError}</span>
          </div>
        )}

        {sessionNotice && (
          <div
            role="status"
            className="mb-4 rounded-xl border border-amber-500/30 bg-amber-950/25 p-3.5 text-sm text-amber-200"
          >
            {sessionNotice}
          </div>
        )}

        {inIframe && !transportError && (
          <div className="mb-4 rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-3.5 text-xs text-cyan-200">
            Embedded preview mode detected. Partitioned HTTPS session cookies are enabled; if your browser blocks third-party frame cookies, open this URL in a standalone browser tab.
          </div>
        )}

        {recoveryCodes ? (
          <section
            aria-label="Single-use recovery codes"
            className="rounded-2xl border border-slate-800 bg-[#0B1120] p-5 sm:p-6 space-y-4"
          >
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-slate-50">
                Save Single-Use Recovery Codes
              </h2>
              <p className="text-sm text-amber-300">
                Store these codes offline in a secure password manager right now. They are shown only once and cannot be retrieved later.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-1.5 rounded-xl border border-slate-800 bg-[#030712] p-3 font-mono text-xs text-cyan-300 tabular-nums">
              {recoveryCodes.map((code) => (
                <div key={code} className="py-0.5 select-all">
                  {code}
                </div>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <button
                type="button"
                onClick={copyRecoveryCodes}
                className="min-h-[44px] flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 transition-colors"
              >
                {copiedCodes ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    <span>Copy Codes</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRecoveryCodes(null);
                  setMode('login');
                }}
                className="min-h-[44px] flex-1 inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 transition-colors"
              >
                Proceed to Sign In
              </button>
            </div>
          </section>
        ) : (
          <section className="rounded-2xl border border-slate-800 bg-[#0B1120] p-5 sm:p-6">
            {initialized && (
              <div className="flex items-center gap-1 p-1 rounded-xl bg-[#030712] border border-slate-800/80 mb-5">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode('login');
                  }}
                  className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    effectiveMode === 'login'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Owner Sign In
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode('recover');
                  }}
                  className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    effectiveMode === 'recover'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Account Recovery
                </button>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mb-4 rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-sm text-rose-200"
              >
                {error}
              </div>
            )}

            {infoMessage && (
              <div
                role="status"
                className="mb-4 rounded-xl border border-cyan-500/35 bg-cyan-950/25 p-3 text-sm text-cyan-200"
              >
                {infoMessage}
              </div>
            )}

            {effectiveMode === 'setup' && (
              <form onSubmit={handleSetupSubmit} className="space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-50">
                    Initial Owner Account Setup
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    One-time human sovereign setup. Password hashed via Argon2id; never stored in browser storage.
                  </p>
                </div>

                <div>
                  <label htmlFor="setup-owner-id" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Owner Identifier
                  </label>
                  <input
                    id="setup-owner-id"
                    type="text"
                    required
                    value={ownerId}
                    onChange={(e) => setOwnerId(e.target.value)}
                    placeholder="owner_primary"
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="setup-username" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Username (lowercase, 3–32 chars)
                  </label>
                  <input
                    id="setup-username"
                    type="text"
                    required
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="ritesh_owner"
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="setup-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Owner Email
                  </label>
                  <input
                    id="setup-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="owner@example.com"
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="setup-password" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Strong Passphrase (min 14 chars, 3+ char classes)
                  </label>
                  <input
                    id="setup-password"
                    type="password"
                    required
                    minLength={14}
                    autoComplete="new-password"
                    value={setupPassword}
                    onChange={(e) => setSetupPassword(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 transition-colors"
                >
                  <Lock className="h-4 w-4" aria-hidden="true" />
                  <span>{busy ? 'Creating Owner Account…' : 'Create Owner Account'}</span>
                </button>
              </form>
            )}

            {effectiveMode === 'login' && (
              <form onSubmit={handleLoginSubmit} className="space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-50">
                    Authenticate Owner Session
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Uses HttpOnly, Secure, SameSite session cookies.
                  </p>
                </div>

                <div>
                  <label htmlFor="login-identifier" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Username or Email
                  </label>
                  <input
                    id="login-identifier"
                    type="text"
                    required
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="login-password" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Password
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="login-mfa" className="block text-xs font-medium text-slate-300 mb-1.5">
                    {mfaRequired
                      ? 'Authenticator TOTP Code (Required)'
                      : 'Authenticator TOTP Code (If Enrolled)'}
                  </label>
                  <input
                    id="login-mfa"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required={mfaRequired}
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder="6-digit code"
                    className={`w-full min-h-[44px] rounded-xl border bg-[#030712] px-3.5 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none ${
                      mfaRequired ? 'border-cyan-500' : 'border-slate-700'
                    }`}
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 transition-colors"
                >
                  <Lock className="h-4 w-4" aria-hidden="true" />
                  <span>{busy ? 'Verifying…' : 'Sign In'}</span>
                </button>
              </form>
            )}

            {effectiveMode === 'recover' && (
              <form onSubmit={handleRecoverSubmit} className="space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-50">
                    Recover Owner Access
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Consumes one single-use recovery code, sets a new password, and revokes all active sessions.
                  </p>
                </div>

                <div>
                  <label htmlFor="recover-identifier" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Username or Email
                  </label>
                  <input
                    id="recover-identifier"
                    type="text"
                    required
                    value={recoverIdentifier}
                    onChange={(e) => setRecoverIdentifier(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="recover-code" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Recovery Code
                  </label>
                  <input
                    id="recover-code"
                    type="text"
                    required
                    value={recoverCode}
                    onChange={(e) => setRecoverCode(e.target.value)}
                    placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="recover-new-password" className="block text-xs font-medium text-slate-300 mb-1.5">
                    New Strong Passphrase
                  </label>
                  <input
                    id="recover-new-password"
                    type="password"
                    required
                    minLength={14}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 transition-colors"
                >
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  <span>{busy ? 'Resetting Access…' : 'Reset Password'}</span>
                </button>
              </form>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
