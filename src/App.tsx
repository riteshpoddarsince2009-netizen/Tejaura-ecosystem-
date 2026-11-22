import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  CalendarClock,
  CheckSquare,
  Cpu,
  FileText,
  FolderGit2,
  ListTodo,
  Lock,
  LogOut,
  ServerCog,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import { ApiError, controlPlaneApi } from './api/client.ts';
import { AgentsManagementView } from './components/AgentsManagementView.tsx';
import { ApprovalInboxView } from './components/ApprovalInboxView.tsx';
import { AuditCenterView } from './components/AuditCenterView.tsx';
import { AuthScreen } from './components/AuthScreen.tsx';
import { ModelsRuntimesView } from './components/ModelsRuntimesView.tsx';
import { OverviewView } from './components/OverviewView.tsx';
import { PolicyInspectorView } from './components/PolicyInspectorView.tsx';
import { ProjectsManagementView } from './components/ProjectsManagementView.tsx';
import { SchedulesView } from './components/SchedulesView.tsx';
import { SecuritySettingsView } from './components/SecuritySettingsView.tsx';
import { SystemAdminView } from './components/SystemAdminView.tsx';
import { TaskCenterView } from './components/TaskCenterView.tsx';
import type {
  ApprovalItem,
  AuditLogItem,
  ComputeNodeItem,
  ManagedAgentItem,
  ModelInventoryItem,
  OrchestratedTask,
  OwnerSessionInfo,
  ScheduleItem,
  SystemOverviewResponse,
  TrustedEndpointItem,
} from './types/controlPlane.ts';

type ViewTab =
  | 'overview'
  | 'tasks'
  | 'approvals'
  | 'schedules'
  | 'agents'
  | 'projects'
  | 'models'
  | 'policy'
  | 'audit'
  | 'security'
  | 'admin';

const NAV_ITEMS: Array<{
  id: ViewTab;
  label: string;
  mobileLabel: string;
  icon: typeof Activity;
}> = [
  { id: 'overview', label: 'Overview', mobileLabel: 'Overview', icon: Activity },
  { id: 'tasks', label: 'Task Center', mobileLabel: 'Tasks', icon: ListTodo },
  { id: 'approvals', label: 'Approval Inbox', mobileLabel: 'Approvals', icon: CheckSquare },
  { id: 'schedules', label: 'Schedules', mobileLabel: 'Schedules', icon: CalendarClock },
  { id: 'agents', label: 'Agents', mobileLabel: 'Agents', icon: Bot },
  { id: 'projects', label: 'Projects & Sites', mobileLabel: 'Projects', icon: FolderGit2 },
  { id: 'models', label: 'Models & Workers', mobileLabel: 'Runtimes', icon: Cpu },
  { id: 'policy', label: 'Policy Inspector', mobileLabel: 'Policy', icon: Shield },
  { id: 'audit', label: 'Audit Center', mobileLabel: 'Audit', icon: FileText },
  { id: 'security', label: 'Profile & Security', mobileLabel: 'Security', icon: Lock },
  { id: 'admin', label: 'System Admin', mobileLabel: 'Admin', icon: ServerCog },
];

const MOBILE_PRIMARY_TABS: ViewTab[] = ['overview', 'tasks', 'approvals', 'models', 'security'];

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [embeddedFrame, setEmbeddedFrame] = useState(false);
  const [owner, setOwner] = useState<OwnerSessionInfo | null>(null);
  const [transportError, setTransportError] = useState<string | undefined>(undefined);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ViewTab>('overview');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);

  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [tickBusy, setTickBusy] = useState(false);
  const [tickNotice, setTickNotice] = useState<string | null>(null);

  const [overview, setOverview] = useState<SystemOverviewResponse | null>(null);
  const [tasks, setTasks] = useState<OrchestratedTask[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [agents, setAgents] = useState<ManagedAgentItem[]>([]);
  const [models, setModels] = useState<ModelInventoryItem[]>([]);
  const [computeNodes, setComputeNodes] = useState<ComputeNodeItem[]>([]);
  const [trustedEndpoints, setTrustedEndpoints] = useState<TrustedEndpointItem[]>([]);
  const [primaryRuntime, setPrimaryRuntime] = useState('airllm');
  const [auditEvents, setAuditEvents] = useState<AuditLogItem[]>([]);

  const checkAuthStatus = useCallback(async () => {
    setAuthLoading(true);
    try {
      const status = await controlPlaneApi.getAuthStatus();
      setInitialized(status.initialized);
      setEmbeddedFrame(status.embedded_frame === true);
      setTransportError(status.transport_error);
      setOwner(status.authenticated && status.owner ? status.owner : null);
    } catch (err) {
      setTransportError(
        err instanceof Error ? err.message : 'Unable to reach TEJAURA control plane.',
      );
      setOwner(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const loadAllControlPlaneData = useCallback(async () => {
    setDataLoading(true);
    setDataError(null);
    try {
      const [
        overviewRes,
        tasksRes,
        approvalsRes,
        schedulesRes,
        agentsRes,
        modelsRes,
        auditRes,
      ] = await Promise.all([
        controlPlaneApi.getOverview(),
        controlPlaneApi.listTasks(),
        controlPlaneApi.listApprovals(),
        controlPlaneApi.listSchedules(),
        controlPlaneApi.listAgents({ limit: 50, offset: 0 }),
        controlPlaneApi.listModels(),
        controlPlaneApi.listAuditEvents(),
      ]);

      setOverview(overviewRes);
      setOwner(overviewRes.owner);
      setTasks(tasksRes.tasks);
      setApprovals(approvalsRes.approvals);
      setSchedules(schedulesRes.schedules);
      setAgents(agentsRes.agents);
      setModels(modelsRes.models);
      setComputeNodes(modelsRes.compute_nodes);
      setTrustedEndpoints(modelsRes.trusted_endpoints);
      setPrimaryRuntime(modelsRes.primary_runtime);
      setAuditEvents(auditRes.events);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 426)) {
        setOwner(null);
        setSessionNotice(
          err.status === 426
            ? err.message
            : 'Your owner session expired or was revoked. Please sign in again.',
        );
        return;
      }
      setDataError(
        err instanceof Error ? err.message : 'Failed to load control plane state.',
      );
    } finally {
      setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkAuthStatus();
  }, [checkAuthStatus]);

  useEffect(() => {
    if (owner) {
      void loadAllControlPlaneData();
    }
  }, [owner?.session_id, loadAllControlPlaneData]);

  async function handleRunWorkerTick() {
    setTickBusy(true);
    setTickNotice(null);
    try {
      const res = await controlPlaneApi.runWorkerTick();
      const r = res.report;
      setTickNotice(
        `Worker tick completed: ${r.schedules_triggered} schedule(s) triggered, ${
          r.task_executed
            ? `executed ${r.executed_task_id} (${r.executed_status})`
            : 'no runnable task'
        }.`,
      );
      await loadAllControlPlaneData();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 426)) {
        setOwner(null);
        setSessionNotice('Session expired. Please authenticate again.');
        return;
      }
      setDataError(err instanceof Error ? err.message : 'Worker tick failed.');
    } finally {
      setTickBusy(false);
    }
  }

  async function handleQuickLogout() {
    try {
      await controlPlaneApi.logout();
    } finally {
      setOwner(null);
      setOverview(null);
      setSessionNotice('Signed out cleanly.');
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#030712] text-slate-100 flex items-center justify-center px-4">
        <div className="text-sm text-slate-400 font-mono">
          Verifying owner control plane session…
        </div>
      </div>
    );
  }

  if (!owner) {
    return (
      <AuthScreen
        initialized={initialized}
        transportError={transportError}
        sessionNotice={sessionNotice}
        embeddedFrame={embeddedFrame}
        onSetupCompleted={() => {
          setInitialized(true);
        }}
        onAuthenticated={(authenticatedOwner) => {
          setSessionNotice(null);
          setOwner(authenticatedOwner);
        }}
      />
    );
  }

  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;
  const activeNavItem = NAV_ITEMS.find((n) => n.id === activeTab) ?? NAV_ITEMS[0]!;

  function isMobileTabActive(tabId: ViewTab): boolean {
    if (tabId === activeTab) return true;
    if (tabId === 'overview' && (activeTab === 'agents' || activeTab === 'projects')) return true;
    if (tabId === 'tasks' && activeTab === 'schedules') return true;
    if (tabId === 'models' && activeTab === 'policy') return true;
    if (tabId === 'security' && (activeTab === 'audit' || activeTab === 'admin')) return true;
    return false;
  }

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 lg:grid lg:grid-cols-[240px_1fr]">
      {/* Desktop persistent left rail */}
      <aside className="hidden lg:flex lg:flex-col lg:sticky lg:top-0 lg:h-screen border-r border-slate-800 bg-[#050A17]">
        <div className="p-5 border-b border-slate-800/80 flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-slate-50">
              TEJAURA
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              Owner Control Plane
            </div>
          </div>
        </div>

        <nav aria-label="Control plane sections" className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full min-h-[44px] px-3 rounded-xl flex items-center justify-between gap-2.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-indigo-600/20 text-indigo-200 border border-indigo-500/40'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/70 border border-transparent'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'approvals' && pendingApprovalsCount > 0 && (
                  <span className="font-mono tabular-nums text-amber-300">
                    {pendingApprovalsCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3.5 border-t border-slate-800/80 space-y-2.5">
          <div className="px-1">
            <div className="text-xs font-medium text-slate-200 truncate">
              {owner.username}
            </div>
            <div className="text-[11px] font-mono text-slate-400 truncate">
              {owner.role} · {owner.owner_id}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleQuickLogout()}
            className="w-full min-h-[40px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-800 bg-[#0B1120] px-3 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main viewport */}
      <div className="min-w-0 flex flex-col min-h-screen">
        {/* Compact sticky mobile top bar (< lg, <= 48px) */}
        <header className="lg:hidden sticky top-0 z-20 h-12 px-4 border-b border-slate-800 bg-[#050A17]/95 backdrop-blur flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="h-4 w-4 text-indigo-400 shrink-0" aria-hidden="true" />
            <span className="text-sm font-semibold text-slate-50 truncate">
              {activeNavItem.label}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono text-slate-400 truncate max-w-[110px]">
              {owner.username}
            </span>
            <button
              type="button"
              onClick={() => void handleQuickLogout()}
              aria-label="Sign out"
              className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg border border-slate-800 text-slate-300 hover:text-white"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5 pb-24 lg:pb-8 space-y-4">
          {/* Mobile paired sub-switchers so all 11 sections are reachable within 1-2 taps */}
          {(activeTab === 'overview' || activeTab === 'agents' || activeTab === 'projects') && (
            <div className="lg:hidden flex items-center gap-1 p-1 rounded-xl bg-[#0B1120] border border-slate-800">
              <button
                type="button"
                onClick={() => setActiveTab('overview')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'overview'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Overview
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('agents')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'agents'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Agents
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('projects')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'projects'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Projects
              </button>
            </div>
          )}

          {(activeTab === 'tasks' || activeTab === 'schedules') && (
            <div className="lg:hidden flex items-center gap-1 p-1 rounded-xl bg-[#0B1120] border border-slate-800">
              <button
                type="button"
                onClick={() => setActiveTab('tasks')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'tasks'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Task Queue
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('schedules')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'schedules'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Schedules
              </button>
            </div>
          )}

          {(activeTab === 'models' || activeTab === 'policy') && (
            <div className="lg:hidden flex items-center gap-1 p-1 rounded-xl bg-[#0B1120] border border-slate-800">
              <button
                type="button"
                onClick={() => setActiveTab('models')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'models'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Models & Workers
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('policy')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'policy'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Policy Inspector
              </button>
            </div>
          )}

          {(activeTab === 'security' || activeTab === 'audit' || activeTab === 'admin') && (
            <div className="lg:hidden flex items-center gap-1 p-1 rounded-xl bg-[#0B1120] border border-slate-800">
              <button
                type="button"
                onClick={() => setActiveTab('security')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'security'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Profile & Security
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('audit')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'audit'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Audit
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('admin')}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'admin'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Admin
              </button>
            </div>
          )}

          {dataError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200"
            >
              {dataError}
            </div>
          )}

          {tickNotice && (
            <div
              role="status"
              className="rounded-xl border border-cyan-500/35 bg-cyan-950/25 p-3 text-xs text-cyan-200 flex items-center justify-between gap-2"
            >
              <span>{tickNotice}</span>
              <button
                type="button"
                onClick={() => setTickNotice(null)}
                className="text-cyan-300 hover:text-white text-xs font-medium shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeTab === 'overview' && (
            <OverviewView
              overview={overview}
              tasks={tasks}
              models={models}
              computeNodes={computeNodes}
              loading={dataLoading}
              tickBusy={tickBusy}
              onRefresh={() => void loadAllControlPlaneData()}
              onRunWorkerTick={() => void handleRunWorkerTick()}
              onOpenNewTask={() => {
                setSelectedTaskId(null);
                setShowNewTaskModal(true);
                setActiveTab('tasks');
              }}
              onSelectTask={(taskId) => {
                setSelectedTaskId(taskId);
                setActiveTab('tasks');
              }}
              onNavigateTab={(dest) => setActiveTab(dest)}
            />
          )}

          {activeTab === 'tasks' && (
            <TaskCenterView
              tasks={tasks}
              actionCatalog={overview?.action_catalog ?? []}
              selectedTaskId={selectedTaskId}
              loading={dataLoading}
              showNewTaskModal={showNewTaskModal}
              onCloseNewTaskModal={() => setShowNewTaskModal(false)}
              onOpenNewTaskModal={() => setShowNewTaskModal(true)}
              onSelectTask={(taskId) => setSelectedTaskId(taskId)}
              onRefresh={loadAllControlPlaneData}
            />
          )}

          {activeTab === 'approvals' && (
            <ApprovalInboxView
              approvals={approvals}
              loading={dataLoading}
              onRefresh={loadAllControlPlaneData}
              onSelectTask={(targetId) => {
                if (targetId.startsWith('proj_')) {
                  setActiveTab('projects');
                } else {
                  setSelectedTaskId(targetId);
                  setActiveTab('tasks');
                }
              }}
            />
          )}

          {activeTab === 'schedules' && (
            <SchedulesView
              schedules={schedules}
              actionCatalog={overview?.action_catalog ?? []}
              loading={dataLoading}
              onRefresh={loadAllControlPlaneData}
            />
          )}

          {activeTab === 'agents' && (
            <AgentsManagementView
              models={models}
              onRefresh={loadAllControlPlaneData}
            />
          )}

          {activeTab === 'projects' && (
            <ProjectsManagementView
              agents={agents}
              onRefresh={loadAllControlPlaneData}
              onOpenApprovals={() => setActiveTab('approvals')}
            />
          )}

          {activeTab === 'models' && (
            <ModelsRuntimesView
              primaryRuntime={primaryRuntime}
              models={models}
              computeNodes={computeNodes}
              trustedEndpoints={trustedEndpoints}
              loading={dataLoading}
              onRefresh={loadAllControlPlaneData}
            />
          )}

          {activeTab === 'policy' && <PolicyInspectorView overview={overview} />}

          {activeTab === 'audit' && (
            <AuditCenterView
              events={auditEvents}
              loading={dataLoading}
              onRefresh={loadAllControlPlaneData}
            />
          )}

          {activeTab === 'security' && (
            <SecuritySettingsView
              overview={overview}
              loading={dataLoading}
              onRefresh={loadAllControlPlaneData}
              onSignedOut={(notice) => {
                setOwner(null);
                setOverview(null);
                setSessionNotice(notice ?? null);
              }}
            />
          )}

          {activeTab === 'admin' && (
            <SystemAdminView onRefreshAll={loadAllControlPlaneData} />
          )}
        </main>
      </div>

      {/* Mobile bottom thumb bar (< lg, <= 58px) */}
      <nav
        aria-label="Primary mobile navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-20 border-t border-slate-800 bg-[#050A17]/95 backdrop-blur grid grid-cols-5"
      >
        {MOBILE_PRIMARY_TABS.map((tabId) => {
          const item = NAV_ITEMS.find((n) => n.id === tabId)!;
          const Icon = item.icon;
          const active = isMobileTabActive(tabId);
          return (
            <button
              key={tabId}
              type="button"
              onClick={() => setActiveTab(tabId)}
              className={`min-h-[54px] px-1 py-1.5 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                active ? 'text-indigo-300' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="relative inline-flex items-center justify-center">
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tabId === 'approvals' && pendingApprovalsCount > 0 && (
                  <span
                    className="ml-1 font-mono text-[10px] text-amber-300 tabular-nums"
                    aria-label={`${pendingApprovalsCount} pending approvals`}
                  >
                    {pendingApprovalsCount}
                  </span>
                )}
              </span>
              <span className="truncate max-w-full">{item.mobileLabel}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
