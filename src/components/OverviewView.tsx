import { Play, Plus, RefreshCw } from 'lucide-react';
import type {
  ComputeNodeItem,
  ModelInventoryItem,
  OrchestratedTask,
  SystemOverviewResponse,
} from '../types/controlPlane.ts';
import {
  formatTaskStatusLabel,
  formatTimestamp,
  getTaskStatusTextClass,
} from './formatters.ts';

interface OverviewViewProps {
  overview: SystemOverviewResponse | null;
  tasks: OrchestratedTask[];
  models: ModelInventoryItem[];
  computeNodes: ComputeNodeItem[];
  loading: boolean;
  tickBusy: boolean;
  onRefresh: () => void;
  onRunWorkerTick: () => void;
  onOpenNewTask: () => void;
  onSelectTask: (taskId: string) => void;
  onNavigateTab: (
    dest: 'tasks' | 'approvals' | 'models' | 'schedules' | 'policy' | 'audit' | 'security',
  ) => void;
}

export function OverviewView({
  overview,
  tasks,
  models,
  computeNodes,
  loading,
  tickBusy,
  onRefresh,
  onRunWorkerTick,
  onOpenNewTask,
  onSelectTask,
  onNavigateTab,
}: OverviewViewProps) {
  if (loading && !overview) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((n) => (
            <div
              key={n}
              className="h-24 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse"
            />
          ))}
        </div>
        <div className="h-44 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-950/20 p-5 text-sm text-rose-200 flex items-center justify-between gap-4">
        <span>System overview data is currently unavailable.</span>
        <button
          type="button"
          onClick={onRefresh}
          className="min-h-[44px] px-4 rounded-xl border border-rose-400/40 text-xs font-medium hover:bg-rose-900/30 whitespace-nowrap"
        >
          Retry
        </button>
      </div>
    );
  }

  const queuedPlusRunning =
    (overview.counts.tasks_by_status.queued ?? 0) +
    (overview.counts.tasks_by_status.running ?? 0);
  const recentTasks = tasks.slice(0, 5);
  const latestMigration =
    overview.persistence.migrations_applied[
      overview.persistence.migrations_applied.length - 1
    ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            System Overview
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
            Signed in as {overview.owner.username} ({overview.owner.owner_id}) · Primary runtime: {overview.worker.primary_runtime}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRunWorkerTick}
            disabled={tickBusy}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#0B1120] px-3.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
          >
            <Play className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
            <span>{tickBusy ? 'Running Tick…' : 'Run Worker Tick'}</span>
          </button>
          <button
            type="button"
            onClick={onOpenNewTask}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>New Task</span>
          </button>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh overview"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-slate-800 bg-[#0B1120] text-slate-300 hover:text-white hover:bg-slate-800"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {overview.counts.pending_approvals > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-amber-200 tabular-nums">
              {overview.counts.pending_approvals} approval request
              {overview.counts.pending_approvals === 1 ? '' : 's'} waiting for owner sign-off
            </p>
            <p className="text-xs text-amber-300/80 mt-0.5">
              Supervised L3/L4 tasks remain paused until explicitly approved or rejected.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('approvals')}
            className="min-h-[44px] px-4 rounded-xl bg-amber-500/20 border border-amber-400/40 text-xs font-medium text-amber-100 hover:bg-amber-500/30 whitespace-nowrap shrink-0"
          >
            Review Inbox
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-4">
          <div className="text-xs text-slate-400">Queued & Running</div>
          <div className="mt-1.5 text-2xl font-semibold text-slate-50 font-mono tabular-nums">
            {queuedPlusRunning}
          </div>
          <div className="mt-1 text-xs text-slate-400 tabular-nums">
            {overview.counts.tasks_by_status.succeeded ?? 0} succeeded ·{' '}
            {overview.counts.tasks_by_status.failed ?? 0} failed
          </div>
        </div>

        <button
          type="button"
          onClick={() => onNavigateTab('approvals')}
          className="text-left rounded-xl border border-slate-800 bg-[#0B1120] p-4 hover:border-indigo-500/50 transition-colors"
        >
          <div className="text-xs text-slate-400">Pending Approvals</div>
          <div
            className={`mt-1.5 text-2xl font-semibold font-mono tabular-nums ${
              overview.counts.pending_approvals > 0
                ? 'text-amber-300'
                : 'text-slate-50'
            }`}
          >
            {overview.counts.pending_approvals}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            Owner-only approval gate
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('models')}
          className="text-left rounded-xl border border-slate-800 bg-[#0B1120] p-4 hover:border-cyan-500/50 transition-colors"
        >
          <div className="text-xs text-slate-400">Verified Models</div>
          <div className="mt-1.5 text-2xl font-semibold text-cyan-300 font-mono tabular-nums">
            {overview.counts.verified_enabled_models} / {overview.counts.registered_models}
          </div>
          <div className="mt-1 text-xs text-slate-400 tabular-nums">
            {overview.counts.online_compute_nodes} compute node online
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('schedules')}
          className="text-left rounded-xl border border-slate-800 bg-[#0B1120] p-4 hover:border-indigo-500/50 transition-colors"
        >
          <div className="text-xs text-slate-400">Active Schedules</div>
          <div className="mt-1.5 text-2xl font-semibold text-slate-50 font-mono tabular-nums">
            {overview.counts.active_schedules} / {overview.counts.total_schedules}
          </div>
          <div className="mt-1 text-xs text-slate-400 tabular-nums">
            {overview.worker.active_leases} active worker lease
          </div>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Control Plane Health & Persistence
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
            <div>
              <dt className="text-slate-400">Database Engine</dt>
              <dd className="text-slate-100 font-mono mt-0.5">
                {overview.persistence.engine} (v{latestMigration?.version ?? 0})
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Worker ID</dt>
              <dd className="text-slate-100 font-mono mt-0.5 truncate">
                {overview.worker.worker_id}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Primary Runtime</dt>
              <dd className="text-cyan-300 font-mono mt-0.5">
                {overview.worker.primary_runtime}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Paid API Fallback</dt>
              <dd className="text-emerald-400 font-mono mt-0.5">
                {overview.worker.paid_api_fallback_enabled ? 'Enabled' : 'Disabled'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Trusted Endpoints</dt>
              <dd className="text-slate-100 font-mono tabular-nums mt-0.5">
                {overview.counts.trusted_endpoints}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Session Expires</dt>
              <dd className="text-slate-200 font-mono tabular-nums mt-0.5">
                {formatTimestamp(overview.owner.expires_at)}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              Compute Nodes & Model Summary
            </h3>
            <button
              type="button"
              onClick={() => onNavigateTab('models')}
              className="text-xs text-cyan-400 hover:text-cyan-300 font-medium"
            >
              Inspect Runtimes
            </button>
          </div>
          {computeNodes.length === 0 ? (
            <p className="text-xs text-slate-400">No compute nodes registered.</p>
          ) : (
            <div className="divide-y divide-slate-800/80">
              {computeNodes.map((node) => (
                <div key={node.node_id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-100 truncate">
                      {node.name}
                    </span>
                    <span
                      className={`text-xs font-medium shrink-0 ${
                        node.online ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {node.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                    {node.node_id} · {node.available_ram_mb}/{node.total_ram_mb} MB RAM · {node.supported_runtimes.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="pt-1 border-t border-slate-800/80 text-xs text-slate-400 tabular-nums">
            {models.length === 0
              ? 'No open-weight models registered in local-models.json yet.'
              : `${models.length} local model(s) registered · ${models.filter((m) => m.runtime_type === 'airllm').length} targeting AirLLM.`}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-100">
            Recent Task Activity
          </h3>
          <button
            type="button"
            onClick={() => onNavigateTab('tasks')}
            className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
          >
            View All Tasks
          </button>
        </div>

        {recentTasks.length === 0 ? (
          <div className="py-6 text-center space-y-3">
            <p className="text-sm text-slate-400">
              No tasks have been queued yet.
            </p>
            <button
              type="button"
              onClick={onOpenNewTask}
              className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Create First Governed Task</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {recentTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => onSelectTask(task.id)}
                className="w-full min-h-[52px] py-3 text-left flex items-center justify-between gap-3 hover:bg-slate-900/50 rounded-lg px-2 -mx-2 transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-100 truncate">
                    {task.title}
                  </div>
                  <div className="text-xs text-slate-400 font-mono tabular-nums mt-0.5 truncate">
                    {task.action} · {task.autonomy_level} · {task.environment} ·{' '}
                    {formatTimestamp(task.updated_at)}
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
      </section>
    </div>
  );
}
