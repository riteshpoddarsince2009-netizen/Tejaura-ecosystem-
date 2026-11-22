import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Activity, CheckCircle2, Cpu, Plus, Server, ShieldAlert, Trash2 } from 'lucide-react';
import { ApiError, controlPlaneApi } from '../api/client.ts';
import type {
  ComputeNodeItem,
  ManagedWorkerItem,
  ModelInventoryItem,
  ModelSource,
  SystemOverviewResponse,
} from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface ModelsRuntimesViewProps {
  primaryRuntime: string;
  models: ModelInventoryItem[];
  computeNodes: ComputeNodeItem[];
  trustedEndpoints: SystemOverviewResponse['trusted_endpoints'];
  loading: boolean;
  onRefresh?: () => Promise<void>;
}

const RUNTIME_OPTIONS = [
  'airllm',
  'ollama',
  'llama_cpp',
  'vllm',
  'sglang',
  'openai_compatible_local',
] as const;

const SOURCE_OPTIONS: Array<{ value: ModelSource; label: string }> = [
  { value: 'modelscope', label: 'ModelScope (Primary Open Weights)' },
  { value: 'huggingface', label: 'HuggingFace Mirror' },
  { value: 'local_mirror', label: 'Owner Local Mirror' },
  { value: 'owner_archive', label: 'Owner Verified Archive' },
];

export function ModelsRuntimesView({
  primaryRuntime,
  models,
  computeNodes,
  trustedEndpoints,
  loading,
  onRefresh,
}: ModelsRuntimesViewProps) {
  const [workers, setWorkers] = useState<ManagedWorkerItem[]>([]);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<
    Record<
      string,
      { available: boolean; status: string; code: string; reason: string }
    >
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [pendingWorkerApprovals, setPendingWorkerApprovals] = useState<
    Record<string, string>
  >({});

  // Add model drawer
  const [showAddModel, setShowAddModel] = useState(false);
  const [modelId, setModelId] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelFamily, setModelFamily] = useState('qwen2.5');
  const [modelVersion, setModelVersion] = useState('7b-instruct');
  const [modelSource, setModelSource] = useState<ModelSource>('modelscope');
  const [repoId, setRepoId] = useState('');
  const [runtimeType, setRuntimeType] = useState<string>('airllm');
  const [format, setFormat] = useState('safetensors');
  const [sizeMb, setSizeMb] = useState('4200');
  const [localModelPath, setLocalModelPath] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [compatibilityStatus, setCompatibilityStatus] = useState<'verified' | 'untested'>('untested');

  // Register worker drawer
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [workerId, setWorkerId] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [workerRuntime, setWorkerRuntime] = useState<string>('airllm');
  const [workerNodeId, setWorkerNodeId] = useState(
    computeNodes[0]?.node_id ?? 'local_host_airllm',
  );
  const [workerBaseUrl, setWorkerBaseUrl] = useState('http://127.0.0.1:8787');
  const [workerRequiresAuth, setWorkerRequiresAuth] = useState(true);
  const [workerTokenEnvVar, setWorkerTokenEnvVar] = useState('');

  const loadWorkers = useCallback(async () => {
    try {
      const res = await controlPlaneApi.listWorkers();
      setWorkers(res.workers);
      setWorkersError(null);
    } catch (err) {
      setWorkersError(
        err instanceof Error ? err.message : 'Unable to load worker inventory.',
      );
    }
  }, []);

  useEffect(() => {
    void loadWorkers();
  }, [loadWorkers]);

  async function refreshParent() {
    if (onRefresh) {
      await onRefresh();
    }
    await loadWorkers();
  }

  async function handleProbe(id: string) {
    setBusyId(`probe:${id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await controlPlaneApi.probeModel(id);
      setProbeResults((prev) => ({ ...prev, [id]: res.probe }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Runtime probe failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCreateModel(e: FormEvent) {
    e.preventDefault();
    setBusyId('create-model');
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await controlPlaneApi.createModel({
        model_id: modelId.trim(),
        model_name: modelName.trim(),
        model_family: modelFamily.trim() || 'qwen2.5',
        model_version: modelVersion.trim() || '1.0',
        source: modelSource,
        repo_id: repoId.trim() || modelId.trim(),
        runtime_type: runtimeType,
        format: format.trim() || 'safetensors',
        size_mb: Number(sizeMb) || 0,
        compatibility_status: compatibilityStatus,
        local_model_path: localModelPath.trim() || null,
        controlled_runtime_endpoint: endpointUrl.trim() || null,
        enabled: false,
      });
      setActionNotice(
        `Registered "${res.model.model_name}" (${res.model.source ?? modelSource}). Verify local installation before enabling in production.`,
      );
      setModelId('');
      setModelName('');
      setRepoId('');
      setLocalModelPath('');
      setEndpointUrl('');
      setShowAddModel(false);
      await refreshParent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to register model.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleVerifyInstall(id: string) {
    setBusyId(`verify:${id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await controlPlaneApi.verifyModelInstall(id);
      setActionNotice(
        res.model.verified_on_disk
          ? `Model "${res.model.model_id}" verified on disk.`
          : `Model "${res.model.model_id}" checked honestly: ${res.model.last_error ?? res.model.install_status}.`,
      );
      await refreshParent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Install verification failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleModel(model: ModelInventoryItem) {
    setBusyId(`toggle:${model.model_id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await controlPlaneApi.toggleModel(model.model_id, !model.enabled);
      setActionNotice(
        `Model "${model.model_id}" ${!model.enabled ? 'enabled' : 'disabled'}.`,
      );
      await refreshParent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update model state.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetModelRole(id: string, role: 'default' | 'backup') {
    setBusyId(`role:${id}:${role}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await controlPlaneApi.setModelRole(id, role);
      setActionNotice(`Assigned "${id}" as ${role} model.`);
      await refreshParent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to assign ${role} model.`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteModel(id: string) {
    setBusyId(`delete-model:${id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await controlPlaneApi.deleteModel(id);
      setActionNotice(`Removed model "${id}".`);
      await refreshParent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete model.');
    } finally {
      setBusyId(null);
    }
  }

  function describeWorkerActionError(err: unknown, fallback: string): string {
    if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED') {
      return `${err.message}${err.approvalId ? ` Approval ID: ${err.approvalId}.` : ''} Approve it in the Owner Approval Inbox, then repeat this action.`;
    }
    return err instanceof Error ? err.message : fallback;
  }

  async function handleCreateWorker(e: FormEvent) {
    e.preventDefault();
    setBusyId('create-worker');
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await controlPlaneApi.createWorker({
        worker_id: workerId.trim() || undefined,
        name: workerName.trim(),
        runtime_type: workerRuntime,
        node_id: workerNodeId.trim() || 'local_host_airllm',
        base_url: workerBaseUrl.trim(),
        requires_auth: workerRequiresAuth,
        auth_token_env_var: workerRequiresAuth ? workerTokenEnvVar.trim() : null,
        enabled: true,
        approval_id: pendingWorkerApprovals.create,
      });
      setActionNotice(
        `Registered worker "${res.worker.name}" (${res.worker.runtime_type}). Run Probe Worker to check live health.`,
      );
      setPendingWorkerApprovals((prev) => {
        const next = { ...prev };
        delete next.create;
        return next;
      });
      setWorkerId('');
      setWorkerName('');
      setShowAddWorker(false);
      await refreshParent();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED' && err.approvalId) {
        setPendingWorkerApprovals((prev) => ({ ...prev, create: err.approvalId! }));
      }
      setActionError(describeWorkerActionError(err, 'Failed to register worker.'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleProbeWorker(id: string) {
    setBusyId(`probe-worker:${id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await controlPlaneApi.probeWorker(id);
      setActionNotice(
        `Worker "${res.worker.name}" probed: ${res.worker.health_status}${
          res.worker.latency_ms ? ` (${res.worker.latency_ms}ms)` : ''
        }.`,
      );
      await loadWorkers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Worker probe failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleWorker(worker: ManagedWorkerItem) {
    setBusyId(`toggle-worker:${worker.worker_id}`);
    setActionError(null);
    setActionNotice(null);
    const approvalKey = `toggle:${worker.worker_id}`;
    try {
      await controlPlaneApi.toggleWorker(
        worker.worker_id,
        !worker.enabled,
        pendingWorkerApprovals[approvalKey],
      );
      setPendingWorkerApprovals((prev) => {
        const next = { ...prev };
        delete next[approvalKey];
        return next;
      });
      await refreshParent();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED' && err.approvalId) {
        setPendingWorkerApprovals((prev) => ({ ...prev, [approvalKey]: err.approvalId! }));
      }
      setActionError(describeWorkerActionError(err, 'Failed to toggle worker.'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteWorker(id: string) {
    setBusyId(`delete-worker:${id}`);
    setActionError(null);
    setActionNotice(null);
    const approvalKey = `delete:${id}`;
    try {
      await controlPlaneApi.deleteWorker(id, pendingWorkerApprovals[approvalKey]);
      setPendingWorkerApprovals((prev) => {
        const next = { ...prev };
        delete next[approvalKey];
        return next;
      });
      setActionNotice(`Removed worker "${id}".`);
      await refreshParent();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED' && err.approvalId) {
        setPendingWorkerApprovals((prev) => ({ ...prev, [approvalKey]: err.approvalId! }));
      }
      setActionError(describeWorkerActionError(err, 'Failed to delete worker.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            Model & Worker Operations
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Primary runtime: <span className="font-mono text-cyan-300">{primaryRuntime}</span> · ModelScope preferred · Paid third-party API fallback is disabled.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowAddModel((v) => !v)}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>{showAddModel ? 'Close Model Form' : 'Add Model'}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowAddWorker((v) => !v)}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#0B1120] px-4 text-xs font-medium text-slate-200 hover:bg-slate-800"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>{showAddWorker ? 'Close Worker Form' : 'Register Worker'}</span>
          </button>
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200"
        >
          {actionError}
        </div>
      )}

      {actionNotice && (
        <div
          role="status"
          className="rounded-xl border border-cyan-500/35 bg-cyan-950/25 p-3 text-xs text-cyan-200"
        >
          {actionNotice}
        </div>
      )}

      {showAddModel && (
        <form
          onSubmit={handleCreateModel}
          className="rounded-xl border border-indigo-500/35 bg-[#0B1120] p-4 sm:p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              Register Open-Weight Local Model
            </h3>
            <span className="text-xs text-slate-400">No secrets stored</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label htmlFor="m-id" className="block text-xs text-slate-300 mb-1">
                Model ID
              </label>
              <input
                id="m-id"
                type="text"
                required
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="qwen2.5-7b-airllm"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="m-name" className="block text-xs text-slate-300 mb-1">
                Model Name
              </label>
              <input
                id="m-name"
                type="text"
                required
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="Qwen2.5-7B-Instruct"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="m-source" className="block text-xs text-slate-300 mb-1">
                Source Registry
              </label>
              <select
                id="m-source"
                value={modelSource}
                onChange={(e) => setModelSource(e.target.value as ModelSource)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                {SOURCE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="m-repo" className="block text-xs text-slate-300 mb-1">
                Repository ID
              </label>
              <input
                id="m-repo"
                type="text"
                required
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
                placeholder="Qwen/Qwen2.5-7B-Instruct"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="m-runtime" className="block text-xs text-slate-300 mb-1">
                Runtime Adapter
              </label>
              <select
                id="m-runtime"
                value={runtimeType}
                onChange={(e) => setRuntimeType(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                {RUNTIME_OPTIONS.map((rt) => (
                  <option key={rt} value={rt}>
                    {rt}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="m-compat" className="block text-xs text-slate-300 mb-1">
                Compatibility Status
              </label>
              <select
                id="m-compat"
                value={compatibilityStatus}
                onChange={(e) =>
                  setCompatibilityStatus(e.target.value as 'verified' | 'untested')
                }
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="untested">Untested (Safe Default)</option>
                <option value="verified">Verified Architecture</option>
              </select>
            </div>
            <div>
              <label htmlFor="m-family" className="block text-xs text-slate-300 mb-1">
                Family & Version
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  id="m-family"
                  type="text"
                  value={modelFamily}
                  onChange={(e) => setModelFamily(e.target.value)}
                  placeholder="qwen2.5"
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="text"
                  aria-label="Model version"
                  value={modelVersion}
                  onChange={(e) => setModelVersion(e.target.value)}
                  placeholder="7b"
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label htmlFor="m-format" className="block text-xs text-slate-300 mb-1">
                Format & Size (MB)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  id="m-format"
                  type="text"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  placeholder="safetensors"
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="number"
                  aria-label="Size in MB"
                  min={0}
                  value={sizeMb}
                  onChange={(e) => setSizeMb(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs tabular-nums text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label htmlFor="m-path" className="block text-xs text-slate-300 mb-1">
                Local Weight Path (Optional)
              </label>
              <input
                id="m-path"
                type="text"
                value={localModelPath}
                onChange={(e) => setLocalModelPath(e.target.value)}
                placeholder="models/qwen2.5-7b"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label htmlFor="m-endpoint" className="block text-xs text-slate-300 mb-1">
                Controlled Runtime Endpoint URL (Optional, loopback or private/owner host)
              </label>
              <input
                id="m-endpoint"
                type="url"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                placeholder="http://127.0.0.1:8787"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddModel(false)}
              className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busyId === 'create-model'}
              className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busyId === 'create-model' ? 'Saving…' : 'Save Model Entry'}
            </button>
          </div>
        </form>
      )}

      {showAddWorker && (
        <form
          onSubmit={handleCreateWorker}
          className="rounded-xl border border-cyan-500/35 bg-[#0B1120] p-4 sm:p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              Register Controlled Worker Endpoint
            </h3>
            <span className="text-xs text-slate-400">
              Token reference env var only — never paste raw secrets
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label htmlFor="w-name" className="block text-xs text-slate-300 mb-1">
                Worker Name
              </label>
              <input
                id="w-name"
                type="text"
                required
                value={workerName}
                onChange={(e) => setWorkerName(e.target.value)}
                placeholder="AirLLM GPU Workstation"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="w-id" className="block text-xs text-slate-300 mb-1">
                Worker ID (Optional)
              </label>
              <input
                id="w-id"
                type="text"
                value={workerId}
                onChange={(e) => setWorkerId(e.target.value)}
                placeholder="airllm_gpu_box"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="w-rt" className="block text-xs text-slate-300 mb-1">
                Runtime Type
              </label>
              <select
                id="w-rt"
                value={workerRuntime}
                onChange={(e) => setWorkerRuntime(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                {RUNTIME_OPTIONS.map((rt) => (
                  <option key={rt} value={rt}>
                    {rt}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="w-url" className="block text-xs text-slate-300 mb-1">
                Base URL
              </label>
              <input
                id="w-url"
                type="url"
                required
                value={workerBaseUrl}
                onChange={(e) => setWorkerBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:8787"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="w-node" className="block text-xs text-slate-300 mb-1">
                Compute Node ID
              </label>
              <input
                id="w-node"
                type="text"
                required
                value={workerNodeId}
                onChange={(e) => setWorkerNodeId(e.target.value)}
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="w-envvar" className="block text-xs text-slate-300 mb-1">
                Auth Token Env Var Name
              </label>
              <input
                id="w-envvar"
                type="text"
                disabled={!workerRequiresAuth}
                value={workerTokenEnvVar}
                onChange={(e) => setWorkerTokenEnvVar(e.target.value.toUpperCase())}
                placeholder="WORKER_AUTH_TOKEN_ENV"
                className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs text-slate-100 disabled:opacity-50 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={workerRequiresAuth}
              onChange={(e) => setWorkerRequiresAuth(e.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-[#030712]"
            />
            <span>Worker requires Bearer authentication from server-side env var</span>
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddWorker(false)}
              className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busyId === 'create-worker'}
              className="min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busyId === 'create-worker' ? 'Registering…' : 'Register Worker'}
            </button>
          </div>
        </form>
      )}

      {loading && models.length === 0 && computeNodes.length === 0 ? (
        <div className="h-40 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />
      ) : (
        <>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 tabular-nums flex items-center gap-2">
              <Cpu className="h-4 w-4 text-cyan-400" aria-hidden="true" />
              <span>Registered Local Models ({models.length})</span>
            </h3>

            {models.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-5 text-sm text-slate-400">
                No models are registered yet. Add an open-weight model from ModelScope or local storage.
              </div>
            ) : (
              <div className="space-y-3">
                {models.map((model) => {
                  const probe = probeResults[model.model_id];
                  return (
                    <article
                      key={model.model_id}
                      className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 space-y-3"
                    >
                      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-100">
                            {model.model_name}{' '}
                            <span className="font-mono text-xs text-slate-400">
                              ({model.model_id})
                            </span>
                            {model.is_default && (
                              <span className="ml-2 text-xs font-mono text-cyan-300">
                                · Default
                              </span>
                            )}
                            {model.is_backup && (
                              <span className="ml-2 text-xs font-mono text-indigo-300">
                                · Backup
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-400 font-mono mt-0.5 tabular-nums">
                            Source: {model.source ?? 'local_mirror'} · Runtime: {model.runtime_type} · Format:{' '}
                            {model.format ?? 'safetensors'} · Size: {model.size_mb ?? 0} MB ·{' '}
                            {model.quantization} · Context: {model.context_length}
                          </div>
                          {model.repo_id && (
                            <div className="text-xs text-slate-400 font-mono mt-0.5 truncate">
                              Repo: {model.repo_id}
                              {model.local_model_path ? ` · Path: ${model.local_model_path}` : ''}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-2 shrink-0">
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void handleVerifyInstall(model.model_id)}
                            className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                            <span>
                              {busyId === `verify:${model.model_id}` ? 'Checking…' : 'Verify Install'}
                            </span>
                          </button>

                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void handleProbe(model.model_id)}
                            className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                          >
                            <Activity className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                            <span>
                              {busyId === `probe:${model.model_id}` ? 'Probing…' : 'Probe Availability'}
                            </span>
                          </button>

                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void handleToggleModel(model)}
                            className="min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                          >
                            {model.enabled ? 'Disable' : 'Enable'}
                          </button>

                          <button
                            type="button"
                            disabled={busyId !== null || model.is_default}
                            onClick={() => void handleSetModelRole(model.model_id, 'default')}
                            className="min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                          >
                            Set Default
                          </button>

                          <button
                            type="button"
                            disabled={busyId !== null || model.is_backup}
                            onClick={() => void handleSetModelRole(model.model_id, 'backup')}
                            className="min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                          >
                            Set Backup
                          </button>

                          <button
                            type="button"
                            disabled={busyId !== null}
                            aria-label={`Remove model ${model.model_name}`}
                            onClick={() => void handleDeleteModel(model.model_id)}
                            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-rose-500/40 bg-rose-950/30 px-3 text-rose-200 hover:bg-rose-900/40 disabled:opacity-50"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs border-t border-slate-800/80 pt-2.5">
                        <div>
                          <dt className="text-slate-400">Compatibility & Disk Install</dt>
                          <dd
                            className={`font-mono mt-0.5 ${
                              model.verified_on_disk ? 'text-emerald-400' : 'text-amber-300'
                            }`}
                          >
                            {model.compatibility_status} · {model.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                            {model.verified_on_disk
                              ? 'Verified on Disk'
                              : model.install_status ?? 'not_installed'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-400">Hardware Fit</dt>
                          <dd
                            className={`mt-0.5 ${
                              model.best_node_fit.fits ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {model.best_node_fit.fits ? 'Fits node' : model.best_node_fit.code} —{' '}
                            {model.best_node_fit.reason}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-400">Reported Status / Breaker</dt>
                          <dd className="text-slate-200 font-mono mt-0.5">
                            {model.availability} ·{' '}
                            {model.breaker.circuit_open
                              ? 'Circuit OPEN'
                              : `${model.breaker.consecutive_failures} failure(s)`}
                          </dd>
                        </div>
                      </dl>

                      {model.last_error && (
                        <div className="text-xs text-amber-300 flex items-start gap-2 pt-1">
                          <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                          <span>{model.last_error}</span>
                        </div>
                      )}

                      {probe && (
                        <div
                          className={`rounded-lg border p-2.5 text-xs ${
                            probe.available
                              ? 'border-emerald-500/35 bg-emerald-950/20 text-emerald-200'
                              : 'border-amber-500/35 bg-amber-950/20 text-amber-200'
                          }`}
                        >
                          Live probe ({probe.status} / {probe.code}): {probe.reason}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* D. Worker & Compute Management */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 tabular-nums flex items-center gap-2">
              <Activity className="h-4 w-4 text-indigo-400" aria-hidden="true" />
              <span>Managed Inference Workers ({workers.length})</span>
            </h3>

            {workersError && (
              <p className="text-xs text-rose-300">{workersError}</p>
            )}

            {workers.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 text-xs text-slate-400">
                No managed worker endpoints persisted yet. Register your remote or local AirLLM / Ollama / vLLM worker above.
              </div>
            ) : (
              <div className="space-y-3">
                {workers.map((worker) => (
                  <article
                    key={worker.worker_id}
                    className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 space-y-2.5"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-100">
                          {worker.name}{' '}
                          <span className="font-mono text-xs text-slate-400">
                            ({worker.worker_id})
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 font-mono mt-0.5 break-all">
                          {worker.runtime_type} · {worker.base_url} · Node: {worker.node_id} · Token env:{' '}
                          {worker.auth_token_env_var ?? 'None'}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void handleProbeWorker(worker.worker_id)}
                          className="min-h-[44px] px-3 rounded-xl border border-slate-700 bg-[#030712] text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                        >
                          {busyId === `probe-worker:${worker.worker_id}` ? 'Probing…' : 'Probe Worker'}
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void handleToggleWorker(worker)}
                          className="min-h-[44px] px-3 rounded-xl border border-slate-700 bg-[#030712] text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                        >
                          {worker.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          aria-label={`Delete worker ${worker.name}`}
                          onClick={() => void handleDeleteWorker(worker.worker_id)}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-rose-500/40 bg-rose-950/30 px-3 text-rose-200 hover:bg-rose-900/40 disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono tabular-nums pt-2 border-t border-slate-800/80">
                      <div>
                        <dt className="text-slate-400">Health</dt>
                        <dd
                          className={
                            worker.health_status === 'online'
                              ? 'text-emerald-400'
                              : worker.health_status === 'degraded'
                                ? 'text-amber-300'
                                : 'text-rose-400'
                          }
                        >
                          {worker.health_status} {worker.latency_ms ? `(${worker.latency_ms}ms)` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Current Model</dt>
                        <dd className="text-slate-200 truncate">
                          {worker.current_model_id ?? 'None loaded'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Jobs / Queue</dt>
                        <dd className="text-slate-200">
                          {worker.active_jobs} active · {worker.queue_length} queued
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-400">Last Check</dt>
                        <dd className="text-slate-300">{formatTimestamp(worker.last_checked_at)}</dd>
                      </div>
                    </dl>

                    {worker.discovered_models.length > 0 && (
                      <div className="text-xs font-mono text-cyan-300">
                        Discovered models: {worker.discovered_models.join(', ')}
                      </div>
                    )}

                    {worker.last_error && (
                      <div className="text-xs text-amber-300">{worker.last_error}</div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 tabular-nums flex items-center gap-2">
              <Server className="h-4 w-4 text-indigo-400" aria-hidden="true" />
              <span>Owner Compute Nodes ({computeNodes.length})</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {computeNodes.map((node) => (
                <article
                  key={node.node_id}
                  className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-100">
                      {node.name}
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        node.online ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {node.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 font-mono tabular-nums">
                    {node.node_id} · Location: {node.location} · GPU: {node.has_gpu ? 'Yes' : 'CPU-only'}
                  </div>
                  <div className="text-xs text-slate-300 font-mono tabular-nums">
                    RAM: {node.available_ram_mb} / {node.total_ram_mb} MB · VRAM: {node.available_vram_mb} /{' '}
                    {node.total_vram_mb} MB
                  </div>
                  <div className="text-xs text-slate-400 font-mono">
                    Runtimes: {node.supported_runtimes.join(', ')} · Seen {formatTimestamp(node.last_seen_at)}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-200 tabular-nums">
              Trusted Runtime Endpoints ({trustedEndpoints.length})
            </h3>
            {trustedEndpoints.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 text-xs text-slate-400">
                No external worker URL configured in <span className="font-mono">TEJAURA_AIRLLM_WORKER_URL</span>. Credentials are never exposed to the frontend.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-[#0B1120] divide-y divide-slate-800/80">
                {trustedEndpoints.map((ep) => (
                  <div key={ep.endpoint_id} className="p-4 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2 font-mono">
                      <span className="text-slate-100">{ep.endpoint_id}</span>
                      <span className="text-cyan-300">{ep.runtime_type}</span>
                    </div>
                    <div className="text-slate-400 font-mono">
                      {ep.base_url} · Node: {ep.node_id} · {ep.enabled ? 'Enabled' : 'Disabled'} · Token env var:{' '}
                      {ep.auth_token_env_var ?? 'None'}
                    </div>
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
