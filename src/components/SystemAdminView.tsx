import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArchiveRestore, Database, HardDrive, RefreshCw, Save, ScrollText } from 'lucide-react';
import { controlPlaneApi } from '../api/client.ts';
import type {
  ModelSource,
  SystemAdminOverview,
  UnifiedLogEntry,
} from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface SystemAdminViewProps {
  initialAdmin?: SystemAdminOverview | null;
  initialLogs?: UnifiedLogEntry[];
  onRefreshAll?: () => Promise<void>;
}

const LOG_PAGE_SIZE = 20;

export function SystemAdminView({
  initialAdmin,
  initialLogs,
  onRefreshAll,
}: SystemAdminViewProps) {
  const [admin, setAdmin] = useState<SystemAdminOverview | null>(initialAdmin ?? null);
  const [logs, setLogs] = useState<UnifiedLogEntry[]>(initialLogs ?? []);
  const [logsTotal, setLogsTotal] = useState<number>(initialLogs?.length ?? 0);
  const [logSource, setLogSource] = useState<'all' | 'audit' | 'task_event' | 'agent_execution'>('all');
  const [logSeverity, setLogSeverity] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [logOffset, setLogOffset] = useState(0);

  // Config controls
  const [maintenanceMode, setMaintenanceMode] = useState(
    initialAdmin?.config.maintenance_mode ?? false,
  );
  const [autoRecoverLeases, setAutoRecoverLeases] = useState(
    initialAdmin?.config.auto_recover_leases ?? true,
  );
  const [maxQueueDepth, setMaxQueueDepth] = useState(
    String(initialAdmin?.config.max_queue_depth ?? 20),
  );
  const [preferredSource, setPreferredSource] = useState<ModelSource>(
    initialAdmin?.config.preferred_model_source ?? 'modelscope',
  );

  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialAdmin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAdminAndLogs = useCallback(async () => {
    setLoading(true);
    try {
      const [adminRes, logsRes] = await Promise.all([
        controlPlaneApi.getSystemAdmin(),
        controlPlaneApi.listSystemLogs({
          source: logSource,
          severity: logSeverity,
          limit: LOG_PAGE_SIZE,
          offset: logOffset,
        }),
      ]);
      setAdmin(adminRes.admin);
      setMaintenanceMode(adminRes.admin.config.maintenance_mode);
      setAutoRecoverLeases(adminRes.admin.config.auto_recover_leases);
      setMaxQueueDepth(String(adminRes.admin.config.max_queue_depth));
      setPreferredSource(adminRes.admin.config.preferred_model_source);
      setLogs(logsRes.logs);
      setLogsTotal(logsRes.total);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load system administration telemetry.',
      );
    } finally {
      setLoading(false);
    }
  }, [logSource, logSeverity, logOffset]);

  useEffect(() => {
    if (!initialAdmin) {
      void loadAdminAndLogs();
    }
  }, [initialAdmin, loadAdminAndLogs]);

  async function handleSaveConfig(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await controlPlaneApi.updateSystemConfig({
        maintenance_mode: maintenanceMode,
        auto_recover_leases: autoRecoverLeases,
        max_queue_depth: Number(maxQueueDepth) || 20,
        preferred_model_source: preferredSource,
      });
      setNotice('Persisted runtime system configuration to SQLite.');
      await loadAdminAndLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save system config.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateBackup() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await controlPlaneApi.createBackup();
      setNotice(
        `Created SHA-256 verified backup ${res.backup.filename} (${res.backup.size_bytes} bytes).`,
      );
      await loadAdminAndLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create backup.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreBackup(backupId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await controlPlaneApi.restoreBackup(backupId);
      setConfirmRestoreId(null);
      setNotice(`Restored management state from verified backup ${res.backup.filename}.`);
      await loadAdminAndLogs();
      if (onRefreshAll) await onRefreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore backup.');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !admin) {
    return <div className="h-44 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            System Administration
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            SQLite integrity checks, storage telemetry, persistent queue configuration, SHA-256 backups, and redacted log explorer.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAdminAndLogs()}
          className="min-h-[44px] inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#0B1120] px-4 text-xs font-medium text-slate-200 hover:bg-slate-800 self-start"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Refresh Diagnostics</span>
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

      {admin && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-indigo-400" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-100">
                  SQLite Database & Integrity
                </h3>
              </div>

              <dl className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
                <div>
                  <dt className="text-slate-400">Integrity Check</dt>
                  <dd
                    className={
                      admin.database.integrity_ok ? 'text-emerald-400 mt-0.5' : 'text-rose-400 mt-0.5'
                    }
                  >
                    {admin.database.integrity_ok ? 'PASS (ok)' : admin.database.integrity_message}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Estimated DB Size</dt>
                  <dd className="text-slate-200 mt-0.5">
                    {(admin.database.estimated_bytes / 1024).toFixed(1)} KB ({admin.database.page_count} pages)
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">State Directory</dt>
                  <dd className="text-slate-200 mt-0.5">
                    {(admin.storage.state_dir_bytes / 1024).toFixed(1)} KB
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Schema Migrations</dt>
                  <dd className="text-cyan-300 mt-0.5">
                    v{admin.migrations[admin.migrations.length - 1]?.version ?? 0} applied
                  </dd>
                </div>
              </dl>

              <div className="pt-2 border-t border-slate-800/80 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs font-mono tabular-nums">
                {Object.entries(admin.database.table_counts).map(([table, count]) => (
                  <div key={table} className="text-slate-400 truncate">
                    {table}: <span className="text-slate-200">{count}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-100">
                  Queue & Worker Health
                </h3>
              </div>

              <dl className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
                <div>
                  <dt className="text-slate-400">Queued Tasks / Jobs</dt>
                  <dd className="text-slate-200 mt-0.5">
                    {admin.queue_health.queued_tasks} tasks · {admin.queue_health.queued_agent_jobs} agent jobs
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Active Leases</dt>
                  <dd className="text-cyan-300 mt-0.5">{admin.queue_health.active_leases}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Recent Failures</dt>
                  <dd className="text-slate-200 mt-0.5">
                    {admin.queue_health.recent_failed_tasks} task(s) · {admin.queue_health.recent_failed_jobs} job(s)
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Workers</dt>
                  <dd className="text-slate-200 mt-0.5">
                    {admin.workers_summary.online} online / {admin.workers_summary.total} registered
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          {/* System Config */}
          <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
            <h3 className="text-sm font-semibold text-slate-100">
              Persistent Runtime Configuration
            </h3>
            <form onSubmit={handleSaveConfig} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
              <label className="min-h-[44px] flex items-center gap-2 rounded-xl border border-slate-800 bg-[#030712] px-3 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={maintenanceMode}
                  onChange={(e) => setMaintenanceMode(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600"
                />
                <span>Maintenance Mode</span>
              </label>

              <label className="min-h-[44px] flex items-center gap-2 rounded-xl border border-slate-800 bg-[#030712] px-3 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRecoverLeases}
                  onChange={(e) => setAutoRecoverLeases(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600"
                />
                <span>Auto-Recover Expired Leases</span>
              </label>

              <div>
                <label htmlFor="cfg-queue" className="block text-xs text-slate-300 mb-1">
                  Max Queue Depth (5–500)
                </label>
                <input
                  id="cfg-queue"
                  type="number"
                  min={5}
                  max={500}
                  value={maxQueueDepth}
                  onChange={(e) => setMaxQueueDepth(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 font-mono text-xs tabular-nums text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="cfg-source" className="block text-xs text-slate-300 mb-1">
                  Preferred Model Source
                </label>
                <select
                  id="cfg-source"
                  value={preferredSource}
                  onChange={(e) => setPreferredSource(e.target.value as ModelSource)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="modelscope">ModelScope</option>
                  <option value="huggingface">HuggingFace Mirror</option>
                  <option value="local_mirror">Local Mirror</option>
                  <option value="owner_archive">Owner Archive</option>
                </select>
              </div>

              <div className="sm:col-span-2 lg:col-span-4 flex items-center justify-between gap-2 pt-1">
                <span className="text-xs font-mono text-slate-400">
                  Default model: {admin.config.default_model_id ?? 'Unset'} · Backup model:{' '}
                  {admin.config.backup_model_id ?? 'Unset'}
                </span>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Save System Config</span>
                </button>
              </div>
            </form>
          </section>

          {/* Confined SHA-256 Backups */}
          <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Management State Backups & Integrity Restore
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Snapshots exclude raw passwords/secrets, stay confined inside the state backup directory, and require SHA-256 match on restore.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleCreateBackup()}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 shrink-0"
              >
                <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                <span>Create Backup</span>
              </button>
            </div>

            {admin.backups.length === 0 ? (
              <p className="text-xs text-slate-400">No configuration backups created yet.</p>
            ) : (
              <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800/80">
                {admin.backups.map((bkp) => (
                  <div
                    key={bkp.backup_id}
                    className="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-mono text-slate-100">
                        {bkp.filename} ({bkp.size_bytes} bytes)
                      </div>
                      <div className="font-mono text-slate-400 tabular-nums truncate">
                        SHA-256: {bkp.sha256.slice(0, 16)}… · {bkp.summary.agents} agents ·{' '}
                        {bkp.summary.models} models · {bkp.summary.workers} workers ·{' '}
                        {bkp.summary.projects} projects
                      </div>
                      <div className="font-mono text-slate-500 tabular-nums">
                        Created {formatTimestamp(bkp.created_at)}
                        {bkp.restored_at ? ` · Last restored ${formatTimestamp(bkp.restored_at)}` : ''}
                      </div>
                    </div>

                    {confirmRestoreId === bkp.backup_id ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRestoreBackup(bkp.backup_id)}
                          className="min-h-[44px] px-3 rounded-xl bg-amber-600 text-xs font-medium text-white hover:bg-amber-500"
                        >
                          Confirm Restore
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRestoreId(null)}
                          className="min-h-[44px] px-3 rounded-xl border border-slate-700 text-xs text-slate-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmRestoreId(bkp.backup_id)}
                        className="min-h-[44px] px-3.5 rounded-xl border border-slate-700 text-xs font-medium text-slate-200 hover:bg-slate-800 shrink-0"
                      >
                        Restore Snapshot
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* Redacted Unified Log Explorer */}
      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-cyan-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-100 tabular-nums">
              Unified Logs & Error Monitor ({logsTotal})
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Filter log source"
              value={logSource}
              onChange={(e) => {
                setLogSource(
                  e.target.value as 'all' | 'audit' | 'task_event' | 'agent_execution',
                );
                setLogOffset(0);
              }}
              className="min-h-[40px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-200"
            >
              <option value="all">All Sources</option>
              <option value="audit">Security Audit</option>
              <option value="task_event">Task Events</option>
              <option value="agent_execution">Agent Executions</option>
            </select>
            <select
              aria-label="Filter log severity"
              value={logSeverity}
              onChange={(e) => {
                setLogSeverity(e.target.value as 'all' | 'info' | 'warn' | 'error');
                setLogOffset(0);
              }}
              className="min-h-[40px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-200"
            >
              <option value="all">All Severities</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error / Denied</option>
            </select>
          </div>
        </div>

        {logs.length === 0 ? (
          <p className="text-xs text-slate-400">No redacted log entries match the active filters.</p>
        ) : (
          <div className="divide-y divide-slate-800/80 border-t border-slate-800/80">
            {logs.map((entry) => (
              <div
                key={`${entry.source}:${entry.log_id}`}
                className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-mono text-slate-200 truncate">
                    <span
                      className={
                        entry.severity === 'error'
                          ? 'text-rose-400'
                          : entry.severity === 'warn'
                            ? 'text-amber-300'
                            : 'text-cyan-300'
                      }
                    >
                      [{entry.severity}]
                    </span>{' '}
                    {entry.source} · {entry.action} · {entry.resource_id}
                  </div>
                  <div className="text-slate-400 truncate">{entry.message}</div>
                </div>
                <span className="font-mono text-slate-500 tabular-nums shrink-0">
                  {entry.actor_id} · {formatTimestamp(entry.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}

        {logsTotal > LOG_PAGE_SIZE && (
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              disabled={logOffset === 0}
              onClick={() => setLogOffset((o) => Math.max(0, o - LOG_PAGE_SIZE))}
              className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-200 disabled:opacity-40"
            >
              Newer Logs
            </button>
            <span className="text-xs font-mono text-slate-400 tabular-nums">
              Showing {logOffset + 1}–{Math.min(logsTotal, logOffset + LOG_PAGE_SIZE)} of {logsTotal}
            </span>
            <button
              type="button"
              disabled={logOffset + LOG_PAGE_SIZE >= logsTotal}
              onClick={() => setLogOffset((o) => o + LOG_PAGE_SIZE)}
              className="min-h-[44px] px-4 rounded-xl border border-slate-700 text-xs font-medium text-slate-200 disabled:opacity-40"
            >
              Older Logs
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
