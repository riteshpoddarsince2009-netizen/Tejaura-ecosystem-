import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Bot, History, Pause, Play, Plus, Power, Wrench } from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type {
  AgentDepartment,
  AgentExecutionJobItem,
  AgentExecutionLogItem,
  AgentStatus,
  ManagedAgentItem,
  ModelInventoryItem,
} from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface AgentsManagementViewProps {
  models: ModelInventoryItem[];
  initialAgents?: ManagedAgentItem[];
  onRefresh?: () => Promise<void>;
}

const DEPARTMENTS: Array<{ id: AgentDepartment; label: string }> = [
  { id: 'research', label: 'Research' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'seo', label: 'SEO' },
  { id: 'design', label: 'Design' },
  { id: 'content', label: 'Content' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'customer_support', label: 'Support' },
];

const PAGE_SIZE = 10;

export function AgentsManagementView({
  models,
  initialAgents,
  onRefresh,
}: AgentsManagementViewProps) {
  const [agents, setAgents] = useState<ManagedAgentItem[]>(initialAgents ?? []);
  const [total, setTotal] = useState<number>(initialAgents?.length ?? 0);
  const [departmentFilter, setDepartmentFilter] = useState<AgentDepartment | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(!initialAgents);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [department, setDepartment] = useState<AgentDepartment>('engineering');
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [autonomyLevel, setAutonomyLevel] = useState<'L0' | 'L1' | 'L2' | 'L3'>('L2');
  const [preferredModelId, setPreferredModelId] = useState('');
  const [backupModelId, setBackupModelId] = useState('');
  const [toolsCsv, setToolsCsv] = useState('workspace.read, sandbox.inspect');
  const [pathsCsv, setPathsCsv] = useState('sandbox');
  const [maxConcurrent, setMaxConcurrent] = useState('1');
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [networkMode, setNetworkMode] = useState<'none' | 'allowlisted_endpoints'>('none');

  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const [historyJobs, setHistoryJobs] = useState<AgentExecutionJobItem[]>([]);
  const [historyLogs, setHistoryLogs] = useState<AgentExecutionLogItem[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await controlPlaneApi.listAgents({
        department: departmentFilter,
        limit: PAGE_SIZE,
        offset,
      });
      setAgents(res.agents);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents.');
    } finally {
      setLoading(false);
    }
  }, [departmentFilter, offset]);

  useEffect(() => {
    if (!initialAgents) {
      void loadAgents();
    }
  }, [initialAgents, loadAgents]);

  function openCreateForm() {
    setEditingId(null);
    setName('');
    setDepartment('engineering');
    setRole('Sandboxed Engineer');
    setDescription('');
    setAutonomyLevel('L2');
    setPreferredModelId(models[0]?.model_id ?? '');
    setBackupModelId('');
    setToolsCsv('workspace.read, sandbox.inspect');
    setPathsCsv('sandbox');
    setMaxConcurrent('1');
    setTimeoutMs('30000');
    setNetworkMode('none');
    setShowForm(true);
  }

  function openEditForm(agent: ManagedAgentItem) {
    setEditingId(agent.id);
    setName(agent.name);
    setDepartment(agent.department);
    setRole(agent.role);
    setDescription(agent.description);
    setAutonomyLevel(agent.permitted_autonomy_level);
    setPreferredModelId(agent.preferred_model_ids[0] ?? '');
    setBackupModelId(agent.backup_model_ids[0] ?? '');
    setToolsCsv(agent.allowed_tool_ids.join(', '));
    setPathsCsv(agent.allowed_paths.join(', '));
    setMaxConcurrent(String(agent.max_concurrent_jobs));
    setTimeoutMs(String(agent.timeout_ms));
    setNetworkMode(agent.network_mode);
    setShowForm(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        name: name.trim(),
        department,
        role: role.trim(),
        description: description.trim(),
        permitted_autonomy_level: autonomyLevel,
        allowed_tool_ids: toolsCsv
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        preferred_model_ids: preferredModelId ? [preferredModelId] : [],
        backup_model_ids: backupModelId ? [backupModelId] : [],
        max_concurrent_jobs: Number(maxConcurrent) || 1,
        timeout_ms: Number(timeoutMs) || 30000,
        allowed_paths: pathsCsv
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        network_mode: networkMode,
      };

      if (editingId) {
        const res = await controlPlaneApi.updateAgent(editingId, payload);
        setNotice(`Updated agent "${res.agent.name}" (${res.agent.permitted_autonomy_level}).`);
      } else {
        const res = await controlPlaneApi.createAgent(payload);
        setNotice(`Created agent "${res.agent.name}" in ${res.agent.department} department.`);
      }
      setShowForm(false);
      await loadAgents();
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent.');
    } finally {
      setBusy(false);
    }
  }

  async function handleStatusChange(agent: ManagedAgentItem, status: AgentStatus) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await controlPlaneApi.setAgentStatus(
        agent.id,
        status,
        status === 'active',
      );
      setNotice(`Agent "${res.agent.name}" is now ${res.agent.status}.`);
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change agent status.');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleHistory(agentId: string) {
    if (historyAgentId === agentId) {
      setHistoryAgentId(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await controlPlaneApi.getAgentHistory(agentId);
      setHistoryAgentId(agentId);
      setHistoryJobs(res.jobs);
      setHistoryLogs(res.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch agent history.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            Agent Management Center
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Department agents, sandboxed execution bounds, model bindings, and L0–L3 autonomy governance (L4 permanently owner-exclusive).
          </p>
        </div>

        <button
          type="button"
          onClick={() => (showForm ? setShowForm(false) : openCreateForm())}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 self-start"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>{showForm ? 'Close Agent Form' : 'Create Agent'}</span>
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

      {notice && (
        <div
          role="status"
          className="rounded-xl border border-cyan-500/35 bg-cyan-950/25 p-3 text-xs text-cyan-200"
        >
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#0B1120] border border-slate-800">
        <button
          type="button"
          onClick={() => {
            setDepartmentFilter('all');
            setOffset(0);
          }}
          className={`min-h-[40px] px-3 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
            departmentFilter === 'all'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          All Departments
        </button>
        {DEPARTMENTS.map((dept) => (
          <button
            key={dept.id}
            type="button"
            onClick={() => {
              setDepartmentFilter(dept.id);
              setOffset(0);
            }}
            className={`min-h-[40px] px-3 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
              departmentFilter === dept.id
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {dept.label}
          </button>
        ))}
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-indigo-500/35 bg-[#0B1120] p-4 sm:p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              {editingId ? `Edit Agent (${editingId})` : 'Create Department Agent'}
            </h3>
            <span className="text-xs text-slate-400">
              Max autonomy: L3 · No self-approval
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label htmlFor="ag-name" className="block text-xs text-slate-300 mb-1">
                Agent Name
              </label>
              <input
                id="ag-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Engineering Code Reviewer"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="ag-dept" className="block text-xs text-slate-300 mb-1">
                Department
              </label>
              <select
                id="ag-dept"
                value={department}
                onChange={(e) => setDepartment(e.target.value as AgentDepartment)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                {DEPARTMENTS.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.label} ({dept.id})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="ag-role" className="block text-xs text-slate-300 mb-1">
                Role Title
              </label>
              <input
                id="ag-role"
                type="text"
                required
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Sandboxed Developer"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="ag-autonomy" className="block text-xs text-slate-300 mb-1">
                Permitted Autonomy (L0–L3 only)
              </label>
              <select
                id="ag-autonomy"
                value={autonomyLevel}
                onChange={(e) =>
                  setAutonomyLevel(e.target.value as 'L0' | 'L1' | 'L2' | 'L3')
                }
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="L0">L0 · Observe only</option>
                <option value="L1">L1 · Propose drafts</option>
                <option value="L2">L2 · Bounded sandbox</option>
                <option value="L3">L3 · Owner-approved supervised</option>
              </select>
            </div>

            <div>
              <label htmlFor="ag-primary-model" className="block text-xs text-slate-300 mb-1">
                Primary Assigned Model
              </label>
              <select
                id="ag-primary-model"
                value={preferredModelId}
                onChange={(e) => setPreferredModelId(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">None assigned</option>
                {models.map((m) => (
                  <option key={m.model_id} value={m.model_id}>
                    {m.model_name} ({m.runtime_type})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="ag-backup-model" className="block text-xs text-slate-300 mb-1">
                Backup Model
              </label>
              <select
                id="ag-backup-model"
                value={backupModelId}
                onChange={(e) => setBackupModelId(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">None</option>
                {models.map((m) => (
                  <option key={m.model_id} value={m.model_id}>
                    {m.model_name} ({m.runtime_type})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="ag-tools" className="block text-xs text-slate-300 mb-1">
                Allowed Tools (comma-separated)
              </label>
              <input
                id="ag-tools"
                type="text"
                value={toolsCsv}
                onChange={(e) => setToolsCsv(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="ag-paths" className="block text-xs text-slate-300 mb-1">
                Allowed Relative Workspace Paths
              </label>
              <input
                id="ag-paths"
                type="text"
                value={pathsCsv}
                onChange={(e) => setPathsCsv(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="ag-network" className="block text-xs text-slate-300 mb-1">
                Network Access & Concurrency
              </label>
              <div className="grid grid-cols-3 gap-2">
                <select
                  id="ag-network"
                  value={networkMode}
                  onChange={(e) =>
                    setNetworkMode(
                      e.target.value as 'none' | 'allowlisted_endpoints',
                    )
                  }
                  className="col-span-2 min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="none">No network (Isolated)</option>
                  <option value="allowlisted_endpoints">Allowlisted only</option>
                </select>
                <input
                  type="number"
                  aria-label="Max concurrent jobs"
                  min={1}
                  max={10}
                  value={maxConcurrent}
                  onChange={(e) => setMaxConcurrent(e.target.value)}
                  className="min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-2 font-mono text-xs tabular-nums text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="ag-desc" className="block text-xs text-slate-300 mb-1">
                Responsibility Description
              </label>
              <input
                id="ag-desc"
                type="text"
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Runs sandboxed code reviews and generates staging patches for owner approval."
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="ag-timeout" className="block text-xs text-slate-300 mb-1">
                Execution Timeout (ms)
              </label>
              <input
                id="ag-timeout"
                type="number"
                min={500}
                max={300000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs tabular-nums text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? 'Saving…' : editingId ? 'Save Agent Changes' : 'Create Agent'}
            </button>
          </div>
        </form>
      )}

      {loading && agents.length === 0 ? (
        <div className="h-44 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-6 text-center space-y-3">
          <p className="text-sm text-slate-300">
            No agents registered in this department view yet.
          </p>
          <button
            type="button"
            onClick={openCreateForm}
            className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500"
          >
            Create First Agent
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400 tabular-nums">
            <span>
              Showing {agents.length} of {total} managed agent(s)
            </span>
          </div>

          {agents.map((agent) => (
            <article
              key={agent.id}
              className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 space-y-3"
            >
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                    <Bot className="h-4 w-4 text-cyan-400 shrink-0" aria-hidden="true" />
                    <span>{agent.name}</span>
                    <span className="font-mono text-xs text-slate-400">({agent.id})</span>
                  </div>
                  <div className="text-xs text-slate-400 font-mono">
                    Department: {agent.department} · Role: {agent.role} · Autonomy:{' '}
                    <span className="text-cyan-300">{agent.permitted_autonomy_level}</span> · Status:{' '}
                    <span
                      className={
                        agent.status === 'active'
                          ? 'text-emerald-400'
                          : agent.status === 'paused'
                            ? 'text-amber-300'
                            : 'text-rose-400'
                      }
                    >
                      {agent.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-300">{agent.description}</p>
                </div>

                <div className="flex flex-wrap gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openEditForm(agent)}
                    className="min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded-xl border border-slate-700 bg-[#030712] text-xs font-medium text-slate-200 hover:bg-slate-800"
                  >
                    <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Edit</span>
                  </button>
                  {agent.status !== 'active' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleStatusChange(agent, 'active')}
                      className="min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded-xl border border-emerald-500/40 bg-emerald-950/25 text-xs font-medium text-emerald-200 hover:bg-emerald-900/40"
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Activate</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleStatusChange(agent, 'paused')}
                      className="min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded-xl border border-amber-500/40 bg-amber-950/25 text-xs font-medium text-amber-200 hover:bg-amber-900/40"
                    >
                      <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Pause</span>
                    </button>
                  )}
                  {agent.status !== 'disabled' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleStatusChange(agent, 'disabled')}
                      className="min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded-xl border border-rose-500/40 bg-rose-950/30 text-xs font-medium text-rose-200 hover:bg-rose-900/40"
                    >
                      <Power className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Disable</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleToggleHistory(agent.id)}
                    className="min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded-xl border border-slate-700 bg-[#030712] text-xs font-medium text-slate-200 hover:bg-slate-800"
                  >
                    <History className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
                    <span>{historyAgentId === agent.id ? 'Hide History' : 'History'}</span>
                  </button>
                </div>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-mono pt-2.5 border-t border-slate-800/80 tabular-nums">
                <div>
                  <dt className="text-slate-400">Model Bindings</dt>
                  <dd className="text-slate-200 mt-0.5 truncate">
                    Primary: {agent.preferred_model_ids[0] ?? 'Default'} · Backup:{' '}
                    {agent.backup_model_ids[0] ?? 'None'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Tools & Workspace Scope</dt>
                  <dd className="text-slate-200 mt-0.5 truncate">
                    {agent.allowed_tool_ids.join(', ')} ({agent.allowed_paths.join(', ')})
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Execution Bounds</dt>
                  <dd className="text-slate-200 mt-0.5">
                    Max {agent.max_concurrent_jobs} job(s) · {agent.timeout_ms}ms · Net: {agent.network_mode}
                  </dd>
                </div>
              </dl>

              {historyAgentId === agent.id && (
                <div className="pt-3 border-t border-slate-800/80 space-y-2 text-xs">
                  <div className="font-semibold text-slate-200 tabular-nums">
                    Execution History ({historyJobs.length} job(s), {historyLogs.length} log(s))
                  </div>
                  {historyJobs.length === 0 && historyLogs.length === 0 ? (
                    <p className="text-slate-400">No sandboxed execution jobs recorded for this agent yet.</p>
                  ) : (
                    <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800/80 bg-[#030712]">
                      {historyJobs.slice(0, 8).map((job) => (
                        <div key={job.job_id} className="p-2.5 font-mono flex flex-wrap justify-between gap-2">
                          <span className="text-slate-200">
                            {job.job_id} · {job.adapter_id} · {job.environment}
                          </span>
                          <span className="text-cyan-300">
                            {job.status} · {formatTimestamp(job.created_at)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-200 disabled:opacity-40"
              >
                Previous Page
              </button>
              <span className="text-xs font-mono text-slate-400 tabular-nums">
                Offset {offset} · Page size {PAGE_SIZE}
              </span>
              <button
                type="button"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-200 disabled:opacity-40"
              >
                Next Page
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
