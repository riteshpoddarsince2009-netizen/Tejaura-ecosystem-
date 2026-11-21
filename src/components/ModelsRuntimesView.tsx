import { useState } from 'react';
import { Activity, Cpu, Server } from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type {
  ComputeNodeItem,
  ModelInventoryItem,
  SystemOverviewResponse,
} from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface ModelsRuntimesViewProps {
  primaryRuntime: string;
  models: ModelInventoryItem[];
  computeNodes: ComputeNodeItem[];
  trustedEndpoints: SystemOverviewResponse['trusted_endpoints'];
  loading: boolean;
}

export function ModelsRuntimesView({
  primaryRuntime,
  models,
  computeNodes,
  trustedEndpoints,
  loading,
}: ModelsRuntimesViewProps) {
  const [probeResults, setProbeResults] = useState<
    Record<
      string,
      { available: boolean; status: string; code: string; reason: string }
    >
  >({});
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  async function handleProbe(modelId: string) {
    setProbingId(modelId);
    setProbeError(null);
    try {
      const res = await controlPlaneApi.probeModel(modelId);
      setProbeResults((prev) => ({ ...prev, [modelId]: res.probe }));
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'Runtime probe failed.');
    } finally {
      setProbingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-50">
          Model & Runtime Center
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Primary runtime: <span className="font-mono text-cyan-300">{primaryRuntime}</span> · Local/owner-controlled inference only · Paid third-party API fallback is disabled.
        </p>
      </div>

      {probeError && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200"
        >
          {probeError}
        </div>
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
                No models are registered in <span className="font-mono">intelligence/model-registry/local-models.json</span> yet. Only owner-verified open-weight text models can be enabled.
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
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-slate-100">
                            {model.model_name}{' '}
                            <span className="font-mono text-xs text-slate-400">
                              ({model.model_id})
                            </span>
                          </div>
                          <div className="text-xs text-slate-400 font-mono mt-0.5">
                            Runtime: {model.runtime_type} · Modality: {model.modality} · Quantization:{' '}
                            {model.quantization} · Context: {model.context_length}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={probingId === model.model_id}
                          onClick={() => handleProbe(model.model_id)}
                          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#030712] px-4 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 shrink-0"
                        >
                          <Activity className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                          <span>
                            {probingId === model.model_id ? 'Probing…' : 'Probe Availability'}
                          </span>
                        </button>
                      </div>

                      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs border-t border-slate-800/80 pt-2.5">
                        <div>
                          <dt className="text-slate-400">Compatibility & Enablement</dt>
                          <dd
                            className={`font-mono mt-0.5 ${
                              model.compatibility_status === 'verified'
                                ? 'text-emerald-400'
                                : 'text-amber-300'
                            }`}
                          >
                            {model.compatibility_status} · {model.enabled ? 'Enabled' : 'Disabled'}
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
