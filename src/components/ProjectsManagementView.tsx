import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FolderGit2, Plus, Rocket, Trash2, Wrench } from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type {
  ExecutionEnvironment,
  ManagedAgentItem,
  ManagedProjectItem,
  ManagedProjectType,
} from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface ProjectsManagementViewProps {
  agents: ManagedAgentItem[];
  initialProjects?: ManagedProjectItem[];
  onRefresh?: () => Promise<void>;
  onOpenApprovals?: () => void;
}

const ENVIRONMENTS: ExecutionEnvironment[] = ['sandbox', 'local', 'staging', 'production'];
const PROJECT_TYPES: Array<{ id: ManagedProjectType; label: string }> = [
  { id: 'website', label: 'Website' },
  { id: 'web_app', label: 'Web Application' },
  { id: 'api_service', label: 'API Service' },
  { id: 'automation', label: 'Automation Workflow' },
];

export function ProjectsManagementView({
  agents,
  initialProjects,
  onRefresh,
  onOpenApprovals,
}: ProjectsManagementViewProps) {
  const [projects, setProjects] = useState<ManagedProjectItem[]>(initialProjects ?? []);
  const [envFilter, setEnvFilter] = useState<ExecutionEnvironment | 'all'>('all');
  const [loading, setLoading] = useState(!initialProjects);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [projectType, setProjectType] = useState<ManagedProjectType>('website');
  const [environment, setEnvironment] = useState<ExecutionEnvironment>('staging');
  const [workspacePath, setWorkspacePath] = useState('');
  const [domainUrl, setDomainUrl] = useState('');
  const [description, setDescription] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);

  const [deployTargets, setDeployTargets] = useState<Record<string, ExecutionEnvironment>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await controlPlaneApi.listProjects({ environment: envFilter });
      setProjects(res.projects);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects.');
    } finally {
      setLoading(false);
    }
  }, [envFilter]);

  useEffect(() => {
    if (!initialProjects) {
      void loadProjects();
    }
  }, [initialProjects, loadProjects]);

  function openCreateForm() {
    setEditingId(null);
    setName('');
    setSlug('');
    setProjectType('website');
    setEnvironment('staging');
    setWorkspacePath('');
    setDomainUrl('');
    setDescription('');
    setSelectedAgents([]);
    setShowForm(true);
  }

  function openEditForm(project: ManagedProjectItem) {
    setEditingId(project.project_id);
    setName(project.name);
    setSlug(project.slug);
    setProjectType(project.project_type);
    setEnvironment(project.environment);
    setWorkspacePath(project.workspace_path);
    setDomainUrl(project.domain_url ?? '');
    setDescription(project.description);
    setSelectedAgents(project.assigned_agent_ids);
    setShowForm(true);
  }

  function toggleAgentSelection(agentId: string) {
    setSelectedAgents((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        name: name.trim(),
        slug: slug.trim() || undefined,
        project_type: projectType,
        environment,
        workspace_path: workspacePath.trim() || undefined,
        domain_url: domainUrl.trim() || null,
        description: description.trim(),
        assigned_agent_ids: selectedAgents,
      };
      if (editingId) {
        const res = await controlPlaneApi.updateProject(editingId, payload);
        setNotice(`Updated project "${res.project.name}".`);
      } else {
        const res = await controlPlaneApi.createProject(payload);
        setNotice(`Registered project "${res.project.name}" (${res.project.environment}).`);
      }
      setShowForm(false);
      await loadProjects();
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeploy(project: ManagedProjectItem) {
    const targetEnv = deployTargets[project.project_id] ?? project.environment;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await controlPlaneApi.deployProject(project.project_id, {
        target_environment: targetEnv,
      });
      if (res.requires_approval && res.approval) {
        setNotice(
          `${targetEnv} deployment for "${res.project.name}" requires explicit owner approval (${res.approval.id}). Review & approve in Approval Inbox.`,
        );
      } else {
        setNotice(`Project "${res.project.name}" deployed to ${res.project.environment}.`);
      }
      await loadProjects();
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Project deployment request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(projectId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await controlPlaneApi.deleteProject(projectId);
      setNotice(`Deleted project "${projectId}".`);
      await loadProjects();
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            Projects & Websites
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Track managed sites/services, assigned department agents, environment readiness, and mandatory L4 owner approval gates for production deploys.
          </p>
        </div>

        <button
          type="button"
          onClick={() => (showForm ? setShowForm(false) : openCreateForm())}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 self-start"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>{showForm ? 'Close Project Form' : 'Create Project'}</span>
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
          className="rounded-xl border border-cyan-500/35 bg-cyan-950/25 p-3 text-xs text-cyan-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
        >
          <span>{notice}</span>
          {onOpenApprovals && notice.includes('Approval Inbox') && (
            <button
              type="button"
              onClick={onOpenApprovals}
              className="min-h-[40px] px-3 rounded-lg bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 shrink-0"
            >
              Open Approval Inbox
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[#0B1120] border border-slate-800">
        <button
          type="button"
          onClick={() => setEnvFilter('all')}
          className={`min-h-[40px] px-3 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
            envFilter === 'all'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          All Environments
        </button>
        {ENVIRONMENTS.map((env) => (
          <button
            key={env}
            type="button"
            onClick={() => setEnvFilter(env)}
            className={`min-h-[40px] px-3 rounded-lg text-xs font-medium capitalize transition-colors whitespace-nowrap ${
              envFilter === env
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {env}
          </button>
        ))}
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-indigo-500/35 bg-[#0B1120] p-4 sm:p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-100">
            {editingId ? `Edit Project (${editingId})` : 'Register Managed Project'}
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label htmlFor="p-name" className="block text-xs text-slate-300 mb-1">
                Project Name
              </label>
              <input
                id="p-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="TEJAURA Docs Portal"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="p-slug" className="block text-xs text-slate-300 mb-1">
                URL Slug (Optional)
              </label>
              <input
                id="p-slug"
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="tejaura-docs"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="p-type" className="block text-xs text-slate-300 mb-1">
                Project Type
              </label>
              <select
                id="p-type"
                value={projectType}
                onChange={(e) => setProjectType(e.target.value as ManagedProjectType)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                {PROJECT_TYPES.map((pt) => (
                  <option key={pt.id} value={pt.id}>
                    {pt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="p-env" className="block text-xs text-slate-300 mb-1">
                Target Environment
              </label>
              <select
                id="p-env"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as ExecutionEnvironment)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                {ENVIRONMENTS.map((env) => (
                  <option key={env} value={env}>
                    {env}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="p-path" className="block text-xs text-slate-300 mb-1">
                Relative Workspace Path
              </label>
              <input
                id="p-path"
                type="text"
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="projects/tejaura-docs"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="p-url" className="block text-xs text-slate-300 mb-1">
                Domain / Preview URL (Optional)
              </label>
              <input
                id="p-url"
                type="url"
                value={domainUrl}
                onChange={(e) => setDomainUrl(e.target.value)}
                placeholder="https://staging.example.com"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="sm:col-span-2 lg:col-span-3">
              <label htmlFor="p-desc" className="block text-xs text-slate-300 mb-1">
                Description
              </label>
              <input
                id="p-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Customer-facing documentation and landing portal."
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-300">
              Assign Active Agents ({selectedAgents.length} selected)
            </div>
            {agents.length === 0 ? (
              <p className="text-xs text-slate-500">
                No managed agents exist yet. Create agents in Agent Management to assign them here.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {agents
                  .filter((a) => a.status !== 'retired')
                  .map((agent) => (
                    <label
                      key={agent.id}
                      className="min-h-[44px] flex items-center gap-2 rounded-xl border border-slate-800 bg-[#030712] px-3 py-2 text-xs text-slate-200 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAgents.includes(agent.id)}
                        onChange={() => toggleAgentSelection(agent.id)}
                        className="h-4 w-4 rounded border-slate-600"
                      />
                      <span className="truncate">
                        {agent.name} ({agent.department})
                      </span>
                    </label>
                  ))}
              </div>
            )}
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
              {busy ? 'Saving…' : editingId ? 'Save Project' : 'Create Project'}
            </button>
          </div>
        </form>
      )}

      {loading && projects.length === 0 ? (
        <div className="h-44 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-6 text-center space-y-3">
          <p className="text-sm text-slate-300">No managed projects in this environment.</p>
          <button
            type="button"
            onClick={openCreateForm}
            className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500"
          >
            Create First Project
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => {
            const targetEnv = deployTargets[project.project_id] ?? project.environment;
            return (
              <article
                key={project.project_id}
                className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 space-y-3"
              >
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                      <FolderGit2 className="h-4 w-4 text-indigo-400 shrink-0" aria-hidden="true" />
                      <span>{project.name}</span>
                      <span className="font-mono text-xs text-slate-400">
                        ({project.slug})
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 font-mono">
                      Type: {project.project_type} · Env: {project.environment} · Deploy:{' '}
                      <span
                        className={
                          project.deployment_status === 'deployed'
                            ? 'text-emerald-400'
                            : project.deployment_status === 'pending_approval'
                              ? 'text-amber-300'
                              : 'text-slate-200'
                        }
                      >
                        {project.deployment_status}
                      </span>{' '}
                      · Health: {project.health_status}
                    </div>
                    <p className="text-xs text-slate-300">{project.description}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <select
                      aria-label={`Target deploy environment for ${project.name}`}
                      value={targetEnv}
                      onChange={(e) =>
                        setDeployTargets((prev) => ({
                          ...prev,
                          [project.project_id]: e.target.value as ExecutionEnvironment,
                        }))
                      }
                      className="min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                    >
                      {ENVIRONMENTS.map((env) => (
                        <option key={env} value={env}>
                          Deploy → {env}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleDeploy(project)}
                      className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {targetEnv === 'production' ? 'Request Prod Approval' : 'Deploy'}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => openEditForm(project)}
                      className="min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded-xl border border-slate-700 bg-[#030712] text-xs font-medium text-slate-200 hover:bg-slate-800"
                    >
                      <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Edit</span>
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Delete project ${project.name}`}
                      onClick={() => void handleDelete(project.project_id)}
                      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-rose-500/40 bg-rose-950/30 px-3 text-rose-200 hover:bg-rose-900/40 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-mono pt-2.5 border-t border-slate-800/80 tabular-nums">
                  <div>
                    <dt className="text-slate-400">Workspace & URL</dt>
                    <dd className="text-slate-200 mt-0.5 truncate">
                      {project.workspace_path} {project.domain_url ? `· ${project.domain_url}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Assigned Agents</dt>
                    <dd className="text-slate-200 mt-0.5 truncate">
                      {project.assigned_agent_ids.length > 0
                        ? project.assigned_agent_ids.join(', ')
                        : 'Unassigned'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Last Deployment</dt>
                    <dd className="text-slate-200 mt-0.5">
                      {formatTimestamp(project.last_deployed_at)}
                    </dd>
                  </div>
                </dl>

                {project.pending_approval_id && (
                  <div className="rounded-lg border border-amber-500/35 bg-amber-950/20 p-2.5 text-xs text-amber-200 flex items-center justify-between gap-2">
                    <span>
                      Pending owner production approval: <span className="font-mono">{project.pending_approval_id}</span>
                    </span>
                    {onOpenApprovals && (
                      <button
                        type="button"
                        onClick={onOpenApprovals}
                        className="text-cyan-300 hover:text-white font-medium shrink-0"
                      >
                        Review in Approvals
                      </button>
                    )}
                  </div>
                )}

                {project.recent_changes.length > 0 && (
                  <div className="text-xs text-slate-400 font-mono">
                    Latest change: {project.recent_changes[0]!.summary} (
                    {formatTimestamp(project.recent_changes[0]!.created_at)})
                  </div>
                )}

                {project.recent_errors.length > 0 && (
                  <div className="text-xs text-rose-300 font-mono">
                    Latest notice: {project.recent_errors[0]!.message}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
