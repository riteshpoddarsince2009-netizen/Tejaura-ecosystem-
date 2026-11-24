import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Cpu,
  Layers,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type {
  DelegationMetrics,
  DelegationTaskEventItem,
  DelegationTaskItem,
  DelegationTaskStatus,
  DepartmentAgentItem,
  SandboxCapabilitiesItem,
  Stage46Overview,
} from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface AIWorkforceViewProps {
  onOpenApprovals?: () => void;
}

const STATUS_STYLES: Record<DelegationTaskStatus, string> = {
  CREATED: 'border-slate-700 bg-slate-900/60 text-slate-300',
  VALIDATING: 'border-cyan-500/40 bg-cyan-950/30 text-cyan-300',
  QUEUED: 'border-indigo-500/40 bg-indigo-950/30 text-indigo-300',
  ASSIGNED: 'border-cyan-500/40 bg-cyan-950/30 text-cyan-300',
  RUNNING: 'border-cyan-400/50 bg-cyan-950/40 text-cyan-200',
  WAITING_FOR_APPROVAL: 'border-amber-500/40 bg-amber-950/30 text-amber-200',
  RETRYING: 'border-orange-500/40 bg-orange-950/30 text-orange-200',
  COMPLETED: 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300',
  FAILED: 'border-rose-500/40 bg-rose-950/30 text-rose-300',
  CANCELLED: 'border-slate-700 bg-slate-900/60 text-slate-400',
};

const EMPTY_METRICS: DelegationMetrics = {
  counts: {
    CREATED: 0,
    VALIDATING: 0,
    QUEUED: 0,
    ASSIGNED: 0,
    RUNNING: 0,
    WAITING_FOR_APPROVAL: 0,
    RETRYING: 0,
    COMPLETED: 0,
    FAILED: 0,
    CANCELLED: 0,
  },
  active: 0,
  queued: 0,
  waiting_for_approval: 0,
  oldest_queued_age_ms: null,
  total: 0,
};

function statusLabel(status: DelegationTaskStatus): string {
  return status
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function MetricCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string | number;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-3 sm:p-4">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

function SandboxBanner({ sandbox }: { sandbox: SandboxCapabilitiesItem | null }) {
  if (!sandbox) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-950/25 p-3 text-xs text-amber-200">
        Sandbox capabilities are unavailable. Delegated engineering work will fail closed.
      </div>
    );
  }
  if (sandbox.available === false) {
    const reasons = sandbox.runtime_capabilities?.reasons ?? [];
    return (
      <div className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-950/25 p-3 text-xs text-rose-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">
            {sandbox.selected_provider} is selected but unavailable
          </p>
          <p className="mt-0.5 text-rose-300/80">
            Engineering execution fails closed until the container runtime and image are ready.
          </p>
          {reasons.length > 0 ? (
            <ul className="mt-1 list-disc pl-4 text-[11px] text-rose-300/80">
              {reasons.slice(0, 3).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    );
  }
  if (sandbox.os_isolated) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-emerald-500/35 bg-emerald-950/20 p-3 text-xs text-emerald-200">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">
            Real OS isolation active — {sandbox.selected_provider}
          </p>
          <p className="mt-0.5 text-emerald-300/80">
            {sandbox.isolation_disclaimer ??
              'Engineering tasks run in a non-root, capability-dropped container with network disabled.'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-950/25 p-3 text-xs text-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">Simulated sandbox — development only</p>
        <p className="mt-0.5 text-amber-300/80">
          {sandbox.selected_provider} does not provide OS isolation. Production requires{' '}
          <span className="font-mono">TEJAURA_SANDBOX_PROVIDER=isolated_container_v1</span>.
        </p>
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: DepartmentAgentItem }) {
  const def = agent.definition;
  const state = agent.state;
  const healthTone =
    state?.health === 'healthy'
      ? 'text-emerald-300'
      : state?.health === 'degraded'
        ? 'text-amber-300'
        : state?.health === 'offline'
          ? 'text-rose-300'
          : 'text-slate-400';
  return (
    <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-100">{def.name}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-indigo-300">
            {def.department}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-[10px] font-mono text-slate-300">
          {def.permitted_autonomy_level}
        </span>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">{def.role}</p>
      <div className="flex flex-wrap gap-1">
        {def.capabilities.slice(0, 4).map((capability) => (
          <span
            key={capability}
            className="rounded-md border border-slate-800 bg-[#030712] px-1.5 py-0.5 text-[10px] text-slate-400"
          >
            {capability.replace(/_/g, ' ')}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-slate-800 pt-2 text-[11px]">
        <div>
          <p className="text-slate-500">Health</p>
          <p className={`font-medium capitalize ${healthTone}`}>{state?.health ?? 'unknown'}</p>
        </div>
        <div>
          <p className="text-slate-500">Done</p>
          <p className="font-medium tabular-nums text-slate-200">{state?.tasks_completed ?? 0}</p>
        </div>
        <div>
          <p className="text-slate-500">Failed</p>
          <p className="font-medium tabular-nums text-slate-200">{state?.tasks_failed ?? 0}</p>
        </div>
      </div>
      <p className="text-[10px] text-slate-500">
        {def.allowed_tool_ids.length} tools · depth {def.max_delegation_depth} ·{' '}
        {def.allowed_delegate_ids.length} delegates
      </p>
    </div>
  );
}

export function AIWorkforceView({ onOpenApprovals }: AIWorkforceViewProps) {
  const [overview, setOverview] = useState<Stage46Overview | null>(null);
  const [metrics, setMetrics] = useState<DelegationMetrics>(EMPTY_METRICS);
  const [tasks, setTasks] = useState<DelegationTaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [contextText, setContextText] = useState('{}');
  const [environment, setEnvironment] = useState<'sandbox' | 'local' | 'staging'>('local');

  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<DelegationTaskStatus | 'all'>('all');
  const [selectedTask, setSelectedTask] = useState<DelegationTaskItem | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<DelegationTaskEventItem[]>([]);
  const [cancelReason, setCancelReason] = useState('Owner cancelled this task.');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewRes, tasksRes] = await Promise.all([
        controlPlaneApi.getStage46Overview(),
        controlPlaneApi.listStage46Tasks({
          project_id: selectedProjectId === 'all' ? undefined : selectedProjectId,
          status: statusFilter === 'all' ? undefined : statusFilter,
          limit: 100,
        }),
      ]);
      setOverview(overviewRes);
      setMetrics(tasksRes.metrics);
      setTasks(tasksRes.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI workforce state.');
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openTask(taskId: string) {
    try {
      const detail = await controlPlaneApi.getStage46Task(taskId);
      setSelectedTask(detail.task);
      setSelectedEvents(detail.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task detail.');
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let context: Record<string, unknown> = {};
      if (contextText.trim().length > 0) {
        const parsed = JSON.parse(contextText) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('Context must be a JSON object.');
        }
        context = parsed as Record<string, unknown>;
      }
      const res = await controlPlaneApi.createStage46Project({
        name: name.trim(),
        objective: objective.trim(),
        context,
        environment,
      });
      setNotice(
        res.duplicate
          ? `Objective already exists as project ${res.project.project_id}.`
          : `Objective queued: ${res.project.name}. The CEO agent is ready to plan.`,
      );
      setShowForm(false);
      setName('');
      setObjective('');
      setContextText('{}');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create objective.');
    } finally {
      setBusy(false);
    }
  }

  async function handleProcessQueue() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await controlPlaneApi.processStage46Queue(10);
      setNotice(
        `Processed ${res.summary.processed} task(s): ${res.summary.completed} completed, ${res.summary.failed} failed, ${res.summary.waiting_for_approval} waiting for owner approval.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Queue processing failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!selectedTask) return;
    setBusy(true);
    setError(null);
    try {
      const res = await controlPlaneApi.cancelStage46Task(
        selectedTask.task_id,
        cancelReason.trim(),
      );
      setNotice(`Cancelled ${res.cancelled_count} task(s).`);
      setSelectedTask(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancellation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleAcknowledge(alertId: string) {
    setBusy(true);
    try {
      await controlPlaneApi.acknowledgeStage46Alert(alertId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acknowledge alert.');
    } finally {
      setBusy(false);
    }
  }

  const activeAgents = useMemo(
    () =>
      (overview?.agents ?? []).filter(
        (agent) => (agent.state?.status ?? 'active') === 'active',
      ).length,
    [overview],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            AI Workforce
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Ten department agents plan, delegate, execute, review and consolidate work under
            owner-only approvals.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || busy}
            className="min-h-[44px] inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#0B1120] px-3 text-xs font-medium text-slate-200 hover:border-slate-600 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void handleProcessQueue()}
            disabled={
              busy ||
              metrics.counts.CREATED +
                metrics.counts.VALIDATING +
                metrics.counts.QUEUED +
                metrics.counts.RETRYING ===
                0
            }
            className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            Run queue
          </button>
          <button
            type="button"
            onClick={() => setShowForm((value) => !value)}
            className="min-h-[44px] inline-flex items-center gap-2 rounded-xl border border-indigo-500/40 bg-indigo-950/30 px-3 text-xs font-medium text-indigo-200 hover:bg-indigo-950/50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New objective
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-xl border border-cyan-500/35 bg-cyan-950/25 p-3 text-xs text-cyan-200">
          {notice}
        </div>
      ) : null}

      <SandboxBanner sandbox={overview?.sandbox ?? null} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
        <MetricCard label="Agents active" value={activeAgents} tone="text-indigo-300" />
        <MetricCard label="Running" value={metrics.active} tone="text-cyan-300" />
        <MetricCard label="Queued" value={metrics.queued} tone="text-indigo-200" />
        <MetricCard
          label="Waiting owner"
          value={metrics.waiting_for_approval}
          tone="text-amber-300"
          hint="Approval Inbox"
        />
        <MetricCard
          label="Completed"
          value={metrics.counts.COMPLETED}
          tone="text-emerald-300"
        />
        <MetricCard label="Failed" value={metrics.counts.FAILED} tone="text-rose-300" />
      </div>

      {showForm ? (
        <form
          onSubmit={(e) => void handleCreate(e)}
          className="rounded-xl border border-indigo-500/35 bg-[#0B1120] p-4 sm:p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">Delegate a new objective</h3>
            <span className="text-[11px] text-slate-500">Owner L4 only</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block text-xs text-slate-300">
              Project name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                maxLength={160}
                className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                placeholder="Q4 launch site"
              />
            </label>
            <label className="block text-xs text-slate-300">
              Environment
              <select
                value={environment}
                onChange={(e) =>
                  setEnvironment(e.target.value as 'sandbox' | 'local' | 'staging')
                }
                className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="sandbox">Sandbox</option>
                <option value="local">Local</option>
                <option value="staging">Staging</option>
              </select>
            </label>
            <label className="block text-xs text-slate-300">
              Context JSON (optional)
              <input
                value={contextText}
                onChange={(e) => setContextText(e.target.value)}
                className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                placeholder='{"brand":"Tejaura"}'
              />
            </label>
          </div>
          <label className="block text-xs text-slate-300">
            Objective
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              required
              minLength={8}
              maxLength={4000}
              rows={3}
              className="mt-1 w-full rounded-xl border border-slate-700 bg-[#030712] px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              placeholder="Build the marketing site, prepare SEO and content, run tests, and prepare the launch package for owner approval."
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="min-h-[44px] rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Create objective
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-[44px] rounded-xl border border-slate-700 px-4 text-xs text-slate-300 hover:border-slate-600"
            >
              Cancel
            </button>
            <span className="text-[11px] text-slate-500">
              Publishing and external actions always require a separate owner approval.
            </span>
          </div>
        </form>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-indigo-300" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-100">Department agents</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-3">
          {(overview?.agents ?? []).map((agent) => (
            <AgentCard key={agent.definition.id} agent={agent} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-indigo-300" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-100">Objectives</h3>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setSelectedProjectId('all')}
            className={`rounded-xl border p-3 text-left ${
              selectedProjectId === 'all'
                ? 'border-indigo-500/60 bg-indigo-950/25'
                : 'border-slate-800 bg-[#0B1120] hover:border-slate-700'
            }`}
          >
            <p className="text-xs font-medium text-slate-100">All objectives</p>
            <p className="mt-1 text-[11px] text-slate-500">
              Show every delegated task across projects.
            </p>
          </button>
          {(overview?.projects ?? []).map((project) => (
            <button
              type="button"
              key={project.project_id}
              onClick={() => setSelectedProjectId(project.project_id)}
              className={`rounded-xl border p-3 text-left ${
                selectedProjectId === project.project_id
                  ? 'border-indigo-500/60 bg-indigo-950/25'
                  : 'border-slate-800 bg-[#0B1120] hover:border-slate-700'
              }`}
            >
              <p className="text-xs font-medium text-slate-100">{project.name}</p>
              <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">
                {project.objective}
              </p>
              <p className="mt-2 font-mono text-[10px] text-slate-500">
                {project.project_id} · {formatTimestamp(project.created_at)}
              </p>
            </button>
          ))}
          {(overview?.projects ?? []).length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 p-4 text-xs text-slate-500">
              No objectives yet. Create one to start the CEO planner.
            </div>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-indigo-300" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">Delegation pipeline</h3>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-slate-500" htmlFor="stage46-status-filter">
              Status
            </label>
            <select
              id="stage46-status-filter"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as DelegationTaskStatus | 'all')
              }
              className="min-h-[40px] rounded-lg border border-slate-700 bg-[#030712] px-2 text-xs text-slate-200"
            >
              <option value="all">All</option>
              {Object.keys(STATUS_STYLES).map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status as DelegationTaskStatus)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="bg-[#0B1120] text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Depth</th>
                <th className="px-3 py-2 font-medium">Retry</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {tasks.map((task) => (
                <tr
                  key={task.task_id}
                  onClick={() => void openTask(task.task_id)}
                  className="cursor-pointer bg-[#030712]/40 hover:bg-[#0B1120]"
                >
                  <td className="px-3 py-2">
                    <p className="font-medium text-slate-200">{task.title}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                      {task.task_id}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <p className="text-slate-300">{task.agent_id}</p>
                    <p className="text-[10px] uppercase text-slate-500">{task.department}</p>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[task.status]}`}
                    >
                      {statusLabel(task.status)}
                    </span>
                    {task.approval_id ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenApprovals?.();
                        }}
                        className="ml-2 text-[10px] text-amber-300 underline underline-offset-2"
                      >
                        Approval
                      </button>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-400">
                    {task.depth}/{task.max_depth}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-400">
                    {task.retry_count}/{task.max_retries}
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {formatTimestamp(task.updated_at)}
                  </td>
                </tr>
              ))}
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                    No delegated tasks for this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-indigo-300" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">Model workers</h3>
          </div>
          {(overview?.workers ?? []).length === 0 ? (
            <p className="text-xs text-slate-500">
              No model worker heartbeat yet. Local planning is deterministic; AirLLM is optional.
            </p>
          ) : (
            (overview?.workers ?? []).map((worker) => (
              <div key={worker.worker_id} className="rounded-lg border border-slate-800 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-slate-200">{worker.worker_id}</p>
                  <span
                    className={`text-[10px] font-medium ${
                      worker.health === 'healthy' ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {worker.health}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-slate-500">{worker.endpoint}</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {worker.runtime_type} · latency {worker.latency_ms ?? '—'}ms ·{' '}
                  {worker.models.length} model(s)
                </p>
              </div>
            ))
          )}
        </section>

        <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100">Execution alerts</h3>
          </div>
          {(overview?.alerts ?? []).length === 0 ? (
            <p className="text-xs text-slate-500">No open alerts.</p>
          ) : (
            (overview?.alerts ?? []).map((alert) => (
              <div
                key={alert.alert_id}
                className={`rounded-lg border p-3 ${
                  alert.severity === 'critical'
                    ? 'border-rose-500/40 bg-rose-950/20'
                    : alert.severity === 'warning'
                      ? 'border-amber-500/35 bg-amber-950/15'
                      : 'border-slate-800'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[11px] font-medium text-slate-200">
                    {alert.code} · {alert.severity}
                  </p>
                  {alert.acknowledged_at ? (
                    <span className="text-[10px] text-emerald-300">Acknowledged</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleAcknowledge(alert.alert_id)}
                      disabled={busy}
                      className="text-[10px] text-indigo-300 underline underline-offset-2"
                    >
                      Acknowledge
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-slate-400">{alert.message}</p>
                <p className="mt-1 text-[10px] text-slate-500">
                  {formatTimestamp(alert.created_at)}
                </p>
              </div>
            ))
          )}
        </section>
      </div>

      {selectedTask ? (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/70 p-3">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-[#0B1120] p-4 sm:p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-100">{selectedTask.title}</p>
                <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                  {selectedTask.task_id} · {selectedTask.agent_id} · depth {selectedTask.depth}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTask(null)}
                className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300"
              >
                Close
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[selectedTask.status]}`}
              >
                {statusLabel(selectedTask.status)}
              </span>
              {selectedTask.error ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-rose-300">
                  <XCircle className="h-3 w-3" aria-hidden="true" />
                  {selectedTask.error.code}
                </span>
              ) : null}
              {selectedTask.status === 'COMPLETED' ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                  Completed
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                <Clock className="h-3 w-3" aria-hidden="true" />
                {formatTimestamp(selectedTask.updated_at)}
              </span>
            </div>

            <p className="text-xs text-slate-400">{selectedTask.description}</p>

            {selectedTask.error ? (
              <div className="rounded-lg border border-rose-500/40 bg-rose-950/25 p-3 text-[11px] text-rose-200">
                {selectedTask.error.message}
              </div>
            ) : null}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div>
                <p className="mb-1 text-[11px] font-medium text-slate-400">Input</p>
                <pre className="max-h-60 overflow-auto rounded-lg border border-slate-800 bg-[#030712] p-2 text-[10px] text-slate-300">
                  {pretty(selectedTask.input)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-medium text-slate-400">Output</p>
                <pre className="max-h-60 overflow-auto rounded-lg border border-slate-800 bg-[#030712] p-2 text-[10px] text-slate-300">
                  {pretty(selectedTask.output)}
                </pre>
              </div>
            </div>

            <div>
              <p className="mb-1 text-[11px] font-medium text-slate-400">Event timeline</p>
              <div className="space-y-1">
                {selectedEvents.map((event) => (
                  <div
                    key={event.event_id}
                    className="rounded-lg border border-slate-800 px-2 py-1.5 text-[10px]"
                  >
                    <span className="text-slate-300">{event.event_type}</span>
                    <span className="text-slate-500">
                      {' '}
                      · {event.from_status ?? '—'} → {event.to_status ?? '—'} ·{' '}
                      {event.actor_id} · {formatTimestamp(event.created_at)}
                    </span>
                    {event.message ? (
                      <p className="mt-0.5 text-slate-500">{event.message}</p>
                    ) : null}
                  </div>
                ))}
                {selectedEvents.length === 0 ? (
                  <p className="text-[11px] text-slate-500">No events recorded.</p>
                ) : null}
              </div>
            </div>

            {['QUEUED', 'CREATED', 'WAITING_FOR_APPROVAL', 'RETRYING'].includes(
              selectedTask.status,
            ) ? (
              <div className="flex flex-col sm:flex-row gap-2 border-t border-slate-800 pt-3">
                <input
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  className="min-h-[44px] flex-1 rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100"
                  placeholder="Cancellation reason"
                />
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  disabled={busy || cancelReason.trim().length < 2}
                  className="min-h-[44px] rounded-xl border border-rose-500/40 bg-rose-950/30 px-4 text-xs font-medium text-rose-200 disabled:opacity-50"
                >
                  Cancel task tree
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
