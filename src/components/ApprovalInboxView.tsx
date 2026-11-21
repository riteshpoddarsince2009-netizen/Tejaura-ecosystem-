import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type { ApprovalItem } from '../types/controlPlane.ts';
import {
  formatTimestamp,
  getApprovalStatusTextClass,
} from './formatters.ts';

interface ApprovalInboxViewProps {
  approvals: ApprovalItem[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onSelectTask: (taskId: string) => void;
}

export function ApprovalInboxView({
  approvals,
  loading,
  onRefresh,
  onSelectTask,
}: ApprovalInboxViewProps) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{
    approvalId: string;
    decision: 'approved' | 'rejected';
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = approvals.filter((a) => a.status === 'pending');
  const resolved = approvals.filter((a) => a.status !== 'pending');

  async function submitDecision(
    approvalId: string,
    decision: 'approved' | 'rejected',
  ) {
    const reason = (reasons[approvalId] ?? '').trim();
    if (reason.length < 3) {
      setError('Enter an explicit owner decision reason (at least 3 characters).');
      return;
    }

    setBusyId(approvalId);
    setError(null);
    try {
      await controlPlaneApi.decideApproval(approvalId, decision, reason);
      setConfirming(null);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval decision failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-50">
          Approval Inbox
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Human-only sign-off for supervised L3 and owner-exclusive L4 operations. Agents cannot approve their own requests.
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

      {loading && approvals.length === 0 ? (
        <div className="h-36 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />
      ) : (
        <>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 tabular-nums">
              Pending Requests ({pending.length})
            </h3>

            {pending.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-6 text-center text-sm text-slate-400">
                No pending L3/L4 approvals right now.
              </div>
            ) : (
              <div className="space-y-3">
                {pending.map((item) => {
                  const isConfirming = confirming?.approvalId === item.id;
                  const reasonValue = reasons[item.id] ?? '';
                  return (
                    <article
                      key={item.id}
                      className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3.5"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                        <div className="space-y-1">
                          <div className="text-sm font-semibold text-slate-50 font-mono">
                            {item.action}
                          </div>
                          <div className="text-xs text-slate-400 font-mono tabular-nums">
                            {item.id} · Requested by {item.requested_by} · Env: {item.environment} ·{' '}
                            {formatTimestamp(item.requested_at)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onSelectTask(item.task_id)}
                          className="text-xs text-cyan-400 hover:text-cyan-300 font-mono self-start"
                        >
                          Task {item.task_id.slice(0, 14)}…
                        </button>
                      </div>

                      <p className="text-sm text-slate-200">{item.reason}</p>

                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs pt-2 border-t border-slate-800/80">
                        <div>
                          <dt className="text-slate-400">Target Resources</dt>
                          <dd className="text-slate-200 font-mono mt-0.5 break-all">
                            {item.scope.resources.join(', ')}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-400">Declared Permissions</dt>
                          <dd className="text-slate-200 font-mono mt-0.5 break-all">
                            {item.scope.permissions.join(', ')}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-400">Impact & Replay Guard</dt>
                          <dd className="text-slate-300 mt-0.5">
                            {item.scope.single_use ? 'Single-use approval' : 'Multi-use'} · Bound to {item.environment}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-400">Expires At</dt>
                          <dd className="text-slate-300 font-mono tabular-nums mt-0.5">
                            {formatTimestamp(item.scope.expires_at)}
                          </dd>
                        </div>
                      </dl>

                      <div className="space-y-2.5 pt-2 border-t border-slate-800/80">
                        <label
                          htmlFor={`reason-${item.id}`}
                          className="block text-xs font-medium text-slate-300"
                        >
                          Owner Decision Reason (Required)
                        </label>
                        <input
                          id={`reason-${item.id}`}
                          type="text"
                          value={reasonValue}
                          onChange={(e) =>
                            setReasons((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                          placeholder="Verified target resource and authorized supervised execution"
                          className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                        />

                        {isConfirming ? (
                          <div className="rounded-xl border border-indigo-500/40 bg-indigo-950/25 p-3 space-y-2.5">
                            <p className="text-xs text-slate-200">
                              Confirm <span className="font-semibold">{confirming.decision}</span> decision for{' '}
                              <span className="font-mono">{item.action}</span> on{' '}
                              <span className="font-mono">{item.environment}</span>?
                            </p>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <button
                                type="button"
                                disabled={busyId === item.id}
                                onClick={() =>
                                  submitDecision(item.id, confirming.decision)
                                }
                                className={`min-h-[44px] flex-1 rounded-xl px-4 text-xs font-medium text-white disabled:opacity-50 ${
                                  confirming.decision === 'approved'
                                    ? 'bg-indigo-600 hover:bg-indigo-500'
                                    : 'bg-rose-600 hover:bg-rose-500'
                                }`}
                              >
                                {busyId === item.id
                                  ? 'Submitting…'
                                  : `Confirm ${confirming.decision === 'approved' ? 'Approve & Queue' : 'Reject & Cancel'}`}
                              </button>
                              <button
                                type="button"
                                disabled={busyId === item.id}
                                onClick={() => setConfirming(null)}
                                className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-800"
                              >
                                Back
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col sm:flex-row gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                if (reasonValue.trim().length < 3) {
                                  setError(
                                    'Enter a meaningful decision reason before confirming.',
                                  );
                                  return;
                                }
                                setError(null);
                                setConfirming({
                                  approvalId: item.id,
                                  decision: 'approved',
                                });
                              }}
                              className="min-h-[44px] flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500"
                            >
                              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                              <span>Approve Request</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (reasonValue.trim().length < 3) {
                                  setError(
                                    'Enter a meaningful rejection reason before confirming.',
                                  );
                                  return;
                                }
                                setError(null);
                                setConfirming({
                                  approvalId: item.id,
                                  decision: 'rejected',
                                });
                              }}
                              className="min-h-[44px] flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-950/30 px-4 text-xs font-medium text-rose-200 hover:bg-rose-900/40"
                            >
                              <XCircle className="h-4 w-4" aria-hidden="true" />
                              <span>Reject Request</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 tabular-nums">
              Decision History ({resolved.length})
            </h3>
            {resolved.length === 0 ? (
              <p className="text-xs text-slate-500">No historical approval decisions yet.</p>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-[#0B1120] divide-y divide-slate-800/80">
                {resolved.map((item) => (
                  <div
                    key={item.id}
                    className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="text-sm font-medium text-slate-100 font-mono">
                        {item.action} · {item.environment}
                      </div>
                      <div className="text-xs text-slate-400">
                        {item.reason}
                      </div>
                      <div className="text-xs text-slate-500 font-mono tabular-nums">
                        Reviewed by {item.reviewed_by ?? 'n/a'} · {formatTimestamp(item.reviewed_at)}
                        {item.consumed_at ? ` · Consumed ${formatTimestamp(item.consumed_at)}` : ''}
                      </div>
                    </div>
                    <span
                      className={`text-xs font-medium capitalize shrink-0 ${getApprovalStatusTextClass(item.status)}`}
                    >
                      {item.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
