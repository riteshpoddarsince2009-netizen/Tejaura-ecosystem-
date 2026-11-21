import { useState, type FormEvent } from 'react';
import { Pause, Play, Plus } from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type {
  ActionCatalogItem,
  AutonomyLevel,
  ExecutionEnvironment,
  ScheduleItem,
} from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface SchedulesViewProps {
  schedules: ScheduleItem[];
  actionCatalog: ActionCatalogItem[];
  loading: boolean;
  onRefresh: () => Promise<void>;
}

export function SchedulesView({
  schedules,
  actionCatalog,
  loading,
  onRefresh,
}: SchedulesViewProps) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [action, setAction] = useState(actionCatalog[0]?.action ?? 'governance:read');
  const [resourceId, setResourceId] = useState('system:inventory');
  const [environment, setEnvironment] = useState<ExecutionEnvironment>('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSpec = actionCatalog.find((a) => a.action === action);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2 || description.trim().length < 2) {
      setError('Schedule name and description must each be at least 2 characters.');
      return;
    }
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10) {
      setError('Interval must be a whole number of at least 10 seconds.');
      return;
    }

    const spec = selectedSpec;
    const allowedEnv =
      spec && !spec.allowed_environments.includes(environment)
        ? spec.allowed_environments[0] ?? 'local'
        : environment;

    setBusy(true);
    try {
      await controlPlaneApi.createSchedule({
        name: name.trim(),
        description: description.trim(),
        interval_seconds: intervalSeconds,
        task_template: {
          type: action.replace(/:/g, '.'),
          title: name.trim(),
          description: description.trim(),
          action,
          resource_id: resourceId.trim() || 'system:inventory',
          environment: allowedEnv,
          autonomy_level: (spec?.required_autonomy ?? 'L0') as AutonomyLevel,
          declared_scopes: [spec?.required_scope ?? 'governance:read'],
          priority: 50,
          idempotent_action: true,
          max_retries: 1,
          timeout_ms: 30000,
          input: {},
        },
      });
      setName('');
      setDescription('');
      setShowForm(false);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create schedule.');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(schedule: ScheduleItem) {
    setError(null);
    setBusy(true);
    try {
      await controlPlaneApi.toggleSchedule(schedule.id, !schedule.enabled);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update schedule.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            Schedules
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Recurring task templates with deterministic per-slot idempotency keys.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>{showForm ? 'Close Form' : 'New Schedule'}</span>
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200"
        >
          {error}
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-xl border border-indigo-500/40 bg-[#0B1120] p-4 sm:p-5 space-y-3.5"
        >
          <h3 className="text-sm font-semibold text-slate-50">
            Create Recurring Schedule
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="sched-name" className="block text-xs font-medium text-slate-300 mb-1">
                Schedule Name
              </label>
              <input
                id="sched-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Hourly Governance & Runtime Audit"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="sched-interval" className="block text-xs font-medium text-slate-300 mb-1">
                Interval (seconds, min 10)
              </label>
              <input
                id="sched-interval"
                type="number"
                min={10}
                required
                value={intervalSeconds}
                onChange={(e) => setIntervalSeconds(Number(e.target.value))}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-sm tabular-nums text-slate-100"
              />
            </div>
          </div>

          <div>
            <label htmlFor="sched-desc" className="block text-xs font-medium text-slate-300 mb-1">
              Description
            </label>
            <input
              id="sched-desc"
              type="text"
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Periodically checks local registry & compute nodes."
              className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="sched-action" className="block text-xs font-medium text-slate-300 mb-1">
                Template Action
              </label>
              <select
                id="sched-action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100"
              >
                {actionCatalog.map((item) => (
                  <option key={item.action} value={item.action}>
                    {item.action} ({item.required_autonomy})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sched-env" className="block text-xs font-medium text-slate-300 mb-1">
                Environment
              </label>
              <select
                id="sched-env"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as ExecutionEnvironment)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-sm text-slate-100"
              >
                {(selectedSpec?.allowed_environments ?? ['local', 'sandbox']).map((env) => (
                  <option key={env} value={env}>
                    {env}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sched-res" className="block text-xs font-medium text-slate-300 mb-1">
                Resource ID
              </label>
              <input
                id="sched-res"
                type="text"
                required
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[44px] px-5 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Create Schedule'}
            </button>
          </div>
        </form>
      )}

      {loading && schedules.length === 0 ? (
        <div className="h-32 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />
      ) : schedules.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-6 text-center text-sm text-slate-400">
          No recurring schedules configured.
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((sched) => (
            <article
              key={sched.id}
              className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-sm font-semibold text-slate-100 truncate">
                    {sched.name}
                  </h3>
                  <span
                    className={`text-xs font-medium ${
                      sched.enabled ? 'text-emerald-400' : 'text-slate-400'
                    }`}
                  >
                    {sched.enabled ? 'Enabled' : 'Paused'}
                  </span>
                </div>
                <p className="text-xs text-slate-400">{sched.description}</p>
                <div className="text-xs text-slate-400 font-mono tabular-nums">
                  {sched.task_template.action} · Every {sched.interval_seconds}s · Next:{' '}
                  {formatTimestamp(sched.next_run_at)} · Last: {formatTimestamp(sched.last_run_at)}
                </div>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => handleToggle(sched)}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#030712] px-4 text-xs font-medium text-slate-200 hover:bg-slate-800 shrink-0"
              >
                {sched.enabled ? (
                  <>
                    <Pause className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                    <span>Pause</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <span>Enable</span>
                  </>
                )}
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
