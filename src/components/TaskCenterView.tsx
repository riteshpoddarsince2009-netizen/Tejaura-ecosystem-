import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Plus, RotateCcw, Search, XCircle } from 'lucide-react';
import { ApiError, controlPlaneApi } from '../api/client.ts';
import type {
  ActionCatalogItem,
  AutonomyLevel,
  ExecutionAttempt,
  ExecutionEnvironment,
  OrchestratedTask,
  TaskEvent,
  TaskStatus,
} from '../types/controlPlane.ts';
import {
  formatTaskStatusLabel,
  formatTimestamp,
  getTaskStatusTextClass,
} from './formatters.ts';

interface TaskCenterViewProps {
  tasks: OrchestratedTask[];
  actionCatalog: ActionCatalogItem[];
  selectedTaskId: string | null;
  loading: boolean;
  showNewTaskModal: boolean;
  onCloseNewTaskModal: () => void;
  onOpenNewTaskModal: () => void;
  onSelectTask: (taskId: string | null) => void;
  onRefresh: () => Promise<void>;
}

const STATUS_FILTERS: Array<{ label: string; value: 'all' | TaskStatus }> = [
  { label: 'All', value: 'all' },
  { label: 'Queued', value: 'queued' },
  { label: 'Waiting Approval', value: 'waiting_for_approval' },
  { label: 'Running', value: 'running' },
  { label: 'Succeeded', value: 'succeeded' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
];

export function TaskCenterView({
  tasks,
  actionCatalog,
  selectedTaskId,
  loading,
  showNewTaskModal,
  onCloseNewTaskModal,
  onOpenNewTaskModal,
  onSelectTask,
  onRefresh,
}: TaskCenterViewProps) {
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<{
    task: OrchestratedTask;
    events: TaskEvent[];
    attempts: ExecutionAttempt[];
  } | null>(null);

  // Cancel & retry state
  const [cancelReason, setCancelReason] = useState('');
  const [showCancelBox, setShowCancelBox] = useState(false);
  const [confirmNonIdempotentRetry, setConfirmNonIdempotentRetry] = useState(false);
  const [requiresNonIdempotentConfirm, setRequiresNonIdempotentConfirm] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  // New task form state
  const defaultAction = actionCatalog[0];
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [action, setAction] = useState(defaultAction?.action ?? 'governance:read');
  const [resourceId, setResourceId] = useState('system:inventory');
  const [environment, setEnvironment] = useState<ExecutionEnvironment>(
    defaultAction?.allowed_environments[0] ?? 'local',
  );
  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>(
    defaultAction?.required_autonomy ?? 'L0',
  );
  const [scopesText, setScopesText] = useState(
    defaultAction?.required_scope ?? 'governance:read',
  );
  const [promptText, setPromptText] = useState('');
  const [priority, setPriority] = useState(50);
  const [maxRetries, setMaxRetries] = useState(1);
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [idempotentAction, setIdempotentAction] = useState(true);
  const [ownerConfirmedL4, setOwnerConfirmedL4] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  useEffect(() => {
    if (actionCatalog.length > 0 && !actionCatalog.some((a) => a.action === action)) {
      const first = actionCatalog[0]!;
      setAction(first.action);
      setEnvironment(first.allowed_environments[0] ?? 'local');
      setAutonomyLevel(first.required_autonomy);
      setScopesText(first.required_scope);
    }
  }, [actionCatalog, action]);

  async function loadDetail(taskId: string) {
    setDetailLoading(true);
    setDetailError(null);
    setShowCancelBox(false);
    setRequiresNonIdempotentConfirm(false);
    setConfirmNonIdempotentRetry(false);
    try {
      const res = await controlPlaneApi.getTaskDetail(taskId);
      setDetailData({
        task: res.task,
        events: res.events,
        attempts: res.attempts,
      });
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Failed to load task detail.');
      setDetailData(null);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    if (selectedTaskId) {
      void loadDetail(selectedTaskId);
    } else {
      setDetailData(null);
    }
  }, [selectedTaskId]);

  function handleActionChange(nextAction: string) {
    setAction(nextAction);
    const spec = actionCatalog.find((a) => a.action === nextAction);
    if (spec) {
      setAutonomyLevel(spec.required_autonomy);
      setScopesText(spec.required_scope);
      if (!spec.allowed_environments.includes(environment)) {
        setEnvironment(spec.allowed_environments[0] ?? 'local');
      }
      setOwnerConfirmedL4(false);
    }
  }

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);

    const scopes = scopesText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (title.trim().length < 2 || description.trim().length < 2 || scopes.length === 0) {
      setCreateError('Title, description, and at least one declared scope are required.');
      return;
    }

    setCreateBusy(true);
    try {
      const res = await controlPlaneApi.createTask({
        title: title.trim(),
        description: description.trim(),
        action,
        resource_id: resourceId.trim(),
        environment,
        autonomy_level: autonomyLevel,
        declared_scopes: scopes,
        priority,
        idempotency_key: idempotencyKey.trim() || undefined,
        idempotent_action: idempotentAction,
        max_retries: maxRetries,
        timeout_ms: timeoutMs,
        input: promptText.trim() ? { prompt: promptText.trim() } : {},
        owner_confirmed_l4: ownerConfirmedL4,
      });
      setTitle('');
      setDescription('');
      setPromptText('');
      setIdempotencyKey('');
      onCloseNewTaskModal();
      await onRefresh();
      onSelectTask(res.task.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Task creation failed.');
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleCancelTask() {
    if (!detailData) return;
    if (cancelReason.trim().length < 3) {
      setDetailError('Please enter a cancellation reason (at least 3 characters).');
      return;
    }
    setActionBusy(true);
    setDetailError(null);
    try {
      await controlPlaneApi.cancelTask(detailData.task.id, cancelReason.trim());
      setCancelReason('');
      setShowCancelBox(false);
      await onRefresh();
      await loadDetail(detailData.task.id);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Cancellation failed.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRetryTask() {
    if (!detailData) return;
    setActionBusy(true);
    setDetailError(null);
    try {
      await controlPlaneApi.retryTask(
        detailData.task.id,
        confirmNonIdempotentRetry,
      );
      await onRefresh();
      await loadDetail(detailData.task.id);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === 'NON_IDEMPOTENT_CONFIRMATION_REQUIRED'
      ) {
        setRequiresNonIdempotentConfirm(true);
      }
      setDetailError(err instanceof Error ? err.message : 'Retry failed.');
    } finally {
      setActionBusy(false);
    }
  }

  const filteredTasks = tasks.filter((t) => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (searchQuery.trim().length > 0) {
      const q = searchQuery.trim().toLowerCase();
      return (
        t.title.toLowerCase().includes(q) ||
        t.action.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const selectedSpec = actionCatalog.find((a) => a.action === action);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            Task Center
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Persistent SQLite task queue, policy gating, execution attempts, and cancellation controls.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenNewTaskModal}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>New Task</span>
        </button>
      </div>

      {showNewTaskModal && (
        <section
          aria-label="Create new governed task"
          className="rounded-xl border border-indigo-500/40 bg-[#0B1120] p-4 sm:p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-50">
              Submit Governed Task
            </h3>
            <button
              type="button"
              onClick={onCloseNewTaskModal}
              className="min-h-[36px] px-3 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800"
            >
              Close
            </button>
          </div>

          {createError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200"
            >
              {createError}
            </div>
          )}

          <form onSubmit={handleCreateSubmit} className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="task-action" className="block text-xs font-medium text-slate-300 mb-1">
                  Policy Catalog Action
                </label>
                <select
                  id="task-action"
                  value={action}
                  onChange={(e) => handleActionChange(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  {actionCatalog.map((item) => (
                    <option key={item.action} value={item.action}>
                      {item.action} ({item.required_autonomy})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="task-env" className="block text-xs font-medium text-slate-300 mb-1">
                  Environment
                </label>
                <select
                  id="task-env"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as ExecutionEnvironment)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  {(selectedSpec?.allowed_environments ?? ['sandbox', 'local', 'staging', 'production']).map(
                    (env) => (
                      <option key={env} value={env}>
                        {env}
                      </option>
                    ),
                  )}
                </select>
              </div>
            </div>

            {selectedSpec && (
              <p className="text-xs text-cyan-300/90">
                {selectedSpec.description} Required scope: <span className="font-mono">{selectedSpec.required_scope}</span>
              </p>
            )}

            <div>
              <label htmlFor="task-title" className="block text-xs font-medium text-slate-300 mb-1">
                Task Title
              </label>
              <input
                id="task-title"
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Inspect registered models and compute nodes"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="task-desc" className="block text-xs font-medium text-slate-300 mb-1">
                Description / Rationale
              </label>
              <textarea
                id="task-desc"
                rows={2}
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-[#030712] p-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            {(action === 'model:invoke_local' || action === 'proposal:draft') && (
              <div>
                <label htmlFor="task-prompt" className="block text-xs font-medium text-slate-300 mb-1">
                  Prompt Input (Dispatched to AirLLM / Local Router)
                </label>
                <textarea
                  id="task-prompt"
                  rows={2}
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  placeholder="Optional explicit prompt text"
                  className="w-full rounded-xl border border-slate-700 bg-[#030712] p-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="task-resource" className="block text-xs font-medium text-slate-300 mb-1">
                  Resource ID
                </label>
                <input
                  id="task-resource"
                  type="text"
                  required
                  value={resourceId}
                  onChange={(e) => setResourceId(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="task-scopes" className="block text-xs font-medium text-slate-300 mb-1">
                  Declared Scopes (comma-sep)
                </label>
                <input
                  id="task-scopes"
                  type="text"
                  required
                  value={scopesText}
                  onChange={(e) => setScopesText(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="task-autonomy" className="block text-xs font-medium text-slate-300 mb-1">
                  Autonomy Level
                </label>
                <select
                  id="task-autonomy"
                  value={autonomyLevel}
                  onChange={(e) => setAutonomyLevel(e.target.value as AutonomyLevel)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  {(['L0', 'L1', 'L2', 'L3', 'L4'] as AutonomyLevel[]).map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label htmlFor="task-priority" className="block text-xs font-medium text-slate-300 mb-1">
                  Priority (0–100)
                </label>
                <input
                  id="task-priority"
                  type="number"
                  min={0}
                  max={100}
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="task-retries" className="block text-xs font-medium text-slate-300 mb-1">
                  Max Retries (0–5)
                </label>
                <input
                  id="task-retries"
                  type="number"
                  min={0}
                  max={5}
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="task-timeout" className="block text-xs font-medium text-slate-300 mb-1">
                  Timeout (ms)
                </label>
                <input
                  id="task-timeout"
                  type="number"
                  min={500}
                  max={300000}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value))}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs tabular-nums text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="task-idem" className="block text-xs font-medium text-slate-300 mb-1">
                  Idempotency Key
                </label>
                <input
                  id="task-idem"
                  type="text"
                  value={idempotencyKey}
                  onChange={(e) => setIdempotencyKey(e.target.value)}
                  placeholder="Optional"
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100"
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-4 pt-1">
              <label className="inline-flex items-center gap-2 text-xs text-slate-300 min-h-[36px]">
                <input
                  type="checkbox"
                  checked={idempotentAction}
                  onChange={(e) => setIdempotentAction(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-[#030712] text-indigo-600"
                />
                <span>Safe to automatically retry if interrupted (idempotent action)</span>
              </label>

              {(autonomyLevel === 'L4' || selectedSpec?.owner_exclusive) && (
                <label className="inline-flex items-center gap-2 text-xs text-amber-300 min-h-[36px]">
                  <input
                    type="checkbox"
                    checked={ownerConfirmedL4}
                    onChange={(e) => setOwnerConfirmedL4(e.target.checked)}
                    className="h-4 w-4 rounded border-amber-500 bg-[#030712] text-indigo-600"
                  />
                  <span>Explicit L4 owner confirmation</span>
                </label>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onCloseNewTaskModal}
                className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createBusy}
                className="min-h-[44px] px-5 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {createBusy ? 'Submitting…' : 'Submit Task'}
              </button>
            </div>
          </form>
        </section>
      )}

      {selectedTaskId ? (
        <section
          aria-label="Task details"
          className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-5"
        >
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => onSelectTask(null)}
              className="min-h-[40px] inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 hover:text-cyan-300"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to Task Queue</span>
            </button>
            {detailData && (
              <span
                className={`text-xs font-semibold ${getTaskStatusTextClass(detailData.task.status)}`}
              >
                {formatTaskStatusLabel(detailData.task.status)}
              </span>
            )}
          </div>

          {detailError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200"
            >
              {detailError}
            </div>
          )}

          {detailLoading || !detailData ? (
            <div className="h-40 rounded-xl bg-slate-900/60 animate-pulse" />
          ) : (
            <>
              <div className="space-y-1.5">
                <h3 className="text-lg font-semibold text-slate-50">
                  {detailData.task.title}
                </h3>
                <p className="text-sm text-slate-300">
                  {detailData.task.description}
                </p>
                <div className="text-xs text-slate-400 font-mono tabular-nums">
                  {detailData.task.id} · {detailData.task.action} · Priority {detailData.task.priority} ·{' '}
                  {detailData.task.autonomy_level} · {detailData.task.environment}
                </div>
              </div>

              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs border-y border-slate-800/80 py-3.5">
                <div>
                  <dt className="text-slate-400">Resource</dt>
                  <dd className="text-slate-200 font-mono mt-0.5 break-all">
                    {detailData.task.resource_id}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Retries</dt>
                  <dd className="text-slate-200 font-mono tabular-nums mt-0.5">
                    {detailData.task.retry_count} / {detailData.task.max_retries} (
                    {detailData.task.idempotent_action ? 'idempotent' : 'non-idempotent'})
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Created</dt>
                  <dd className="text-slate-200 font-mono tabular-nums mt-0.5">
                    {formatTimestamp(detailData.task.created_at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Updated</dt>
                  <dd className="text-slate-200 font-mono tabular-nums mt-0.5">
                    {formatTimestamp(detailData.task.updated_at)}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap gap-2">
                {['queued', 'running', 'waiting_for_approval'].includes(
                  detailData.task.status,
                ) && (
                  <button
                    type="button"
                    onClick={() => setShowCancelBox((v) => !v)}
                    className="min-h-[44px] inline-flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-950/30 px-4 text-xs font-medium text-rose-200 hover:bg-rose-900/40"
                  >
                    <XCircle className="h-4 w-4" aria-hidden="true" />
                    <span>Cancel Task</span>
                  </button>
                )}

                {detailData.task.status === 'failed' && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={handleRetryTask}
                    className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    <span>{actionBusy ? 'Retrying…' : 'Retry Failed Task'}</span>
                  </button>
                )}
              </div>

              {showCancelBox && (
                <div className="rounded-xl border border-rose-500/40 bg-[#030712] p-3.5 space-y-2.5">
                  <label htmlFor="cancel-reason" className="block text-xs font-medium text-rose-200">
                    Cancellation Reason (Required)
                  </label>
                  <input
                    id="cancel-reason"
                    type="text"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder="Superseded by updated owner instruction"
                    className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#0B1120] px-3 text-sm text-slate-100"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={handleCancelTask}
                      className="min-h-[44px] px-4 rounded-xl bg-rose-600 text-xs font-medium text-white hover:bg-rose-500"
                    >
                      Confirm Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCancelBox(false)}
                      className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs text-slate-300"
                    >
                      Keep Task
                    </button>
                  </div>
                </div>
              )}

              {requiresNonIdempotentConfirm && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-950/25 p-3.5 space-y-2">
                  <p className="text-xs text-amber-200">
                    This failed task already dispatched a non-idempotent external effect. Verify the external target state before forcing a manual retry.
                  </p>
                  <label className="inline-flex items-center gap-2 text-xs text-amber-100">
                    <input
                      type="checkbox"
                      checked={confirmNonIdempotentRetry}
                      onChange={(e) => setConfirmNonIdempotentRetry(e.target.checked)}
                      className="h-4 w-4 rounded"
                    />
                    <span>I have verified external state and explicitly confirm retrying</span>
                  </label>
                </div>
              )}

              {detailData.task.error && (
                <div className="rounded-xl border border-rose-500/35 bg-rose-950/20 p-3.5 space-y-1">
                  <div className="text-xs font-mono font-semibold text-rose-300">
                    Error: {detailData.task.error.code}
                  </div>
                  <div className="text-xs text-rose-200">
                    {detailData.task.error.message}
                  </div>
                </div>
              )}

              {detailData.task.result && (
                <div className="space-y-1.5">
                  <h4 className="text-xs font-semibold text-slate-300">
                    Execution Output
                  </h4>
                  <pre className="rounded-xl border border-slate-800 bg-[#030712] p-3 text-xs font-mono text-cyan-200 overflow-x-auto">
                    {JSON.stringify(detailData.task.result, null, 2)}
                  </pre>
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-300 tabular-nums">
                  Execution Attempts ({detailData.attempts.length})
                </h4>
                {detailData.attempts.length === 0 ? (
                  <p className="text-xs text-slate-500">No execution attempts leased yet.</p>
                ) : (
                  <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-[#030712]">
                    {detailData.attempts.map((att) => (
                      <div key={att.attempt_id} className="p-3 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2 font-mono">
                          <span className="text-slate-100">
                            Attempt #{att.attempt_number} · {att.worker_id}
                          </span>
                          <span className="text-cyan-300">{att.status}</span>
                        </div>
                        <div className="text-slate-400 font-mono tabular-nums">
                          Started {formatTimestamp(att.started_at)} · Lease expires{' '}
                          {formatTimestamp(att.lease_expires_at)}
                          {att.runtime_type ? ` · Runtime ${att.runtime_type}` : ''}
                          {att.external_effect_dispatched ? ' · External effect dispatched' : ''}
                        </div>
                        {att.error_message && (
                          <div className="text-rose-300 font-mono">
                            {att.error_code}: {att.error_message}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-300 tabular-nums">
                  Task Events Timeline ({detailData.events.length})
                </h4>
                <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-[#030712]">
                  {detailData.events.map((evt) => (
                    <div key={evt.event_id} className="p-3 text-xs space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-indigo-300">
                          {evt.event_type}
                        </span>
                        <span className="font-mono text-slate-500 tabular-nums">
                          {formatTimestamp(evt.created_at)}
                        </span>
                      </div>
                      <div className="text-slate-200">{evt.message}</div>
                      <div className="text-slate-500 font-mono">
                        Actor: {evt.actor_id}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search
                className="h-4 w-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="Search tasks"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tasks by title, action, or ID…"
                className="w-full min-h-[44px] rounded-xl border border-slate-800 bg-[#0B1120] pl-10 pr-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div
            role="tablist"
            aria-label="Filter tasks by status"
            className="flex items-center gap-1.5 overflow-x-auto pb-1"
          >
            {STATUS_FILTERS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={statusFilter === opt.value}
                onClick={() => setStatusFilter(opt.value)}
                className={`min-h-[40px] px-3 rounded-xl text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  statusFilter === opt.value
                    ? 'bg-indigo-600 text-white'
                    : 'border border-slate-800 bg-[#0B1120] text-slate-300 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {loading && tasks.length === 0 ? (
            <div className="h-40 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />
          ) : filteredTasks.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-6 text-center space-y-3">
              <p className="text-sm text-slate-400">
                No tasks match the current filter.
              </p>
              <button
                type="button"
                onClick={onOpenNewTaskModal}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Create Task</span>
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-[#0B1120] divide-y divide-slate-800/80">
              {filteredTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onSelectTask(task.id)}
                  className="w-full min-h-[60px] p-4 text-left flex items-center justify-between gap-3 hover:bg-slate-900/60 transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-medium text-slate-100 truncate">
                      {task.title}
                    </div>
                    <div className="text-xs text-slate-400 font-mono tabular-nums truncate">
                      {task.action} · Priority {task.priority} · {task.autonomy_level} ·{' '}
                      {task.environment} · {formatTimestamp(task.created_at)}
                    </div>
                  </div>
                  <span
                    className={`text-xs font-medium whitespace-nowrap shrink-0 ${getTaskStatusTextClass(task.status)}`}
                  >
                    {formatTaskStatusLabel(task.status)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
