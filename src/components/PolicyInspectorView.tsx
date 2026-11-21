import type { SystemOverviewResponse } from '../types/controlPlane.ts';

interface PolicyInspectorViewProps {
  overview: SystemOverviewResponse | null;
}

export function PolicyInspectorView({ overview }: PolicyInspectorViewProps) {
  if (!overview) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-5 text-sm text-slate-400">
        System policy configuration is unavailable.
      </div>
    );
  }

  const gov = overview.system_governance?.governance;
  const levels = gov?.autonomyLevels;
  const gates = overview.system_governance?.approval_gates;
  const rbacRoles = overview.rbac_roles ?? {};

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-50">
          System & Policy Inspector
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Read-only view of constitutional autonomy boundaries, approval gates, RBAC permissions, and closed policy actions. Governance rules cannot be modified from UI controls.
        </p>
      </div>

      <section className="rounded-xl border border-slate-800 bg-[#0B1120] p-4 sm:p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-100">
          Constitutional Governance Flags
        </h3>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          <div>
            <dt className="text-slate-400">Human Owner Control</dt>
            <dd className="text-emerald-400 font-mono mt-0.5">
              {String(gov?.humanOwnerControl ?? true)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Agent Self-Permission</dt>
            <dd className="text-emerald-400 font-mono mt-0.5">
              {String(gov?.allowAgentSelfPermission ?? false)} (forbidden)
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Agent Self-Approval</dt>
            <dd className="text-emerald-400 font-mono mt-0.5">
              {String(gov?.allowAgentSelfApproval ?? false)} (forbidden)
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Max Autonomous Level</dt>
            <dd className="text-cyan-300 font-mono mt-0.5">
              {gov?.maxAutonomousLevel ?? 'L2'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Default Autonomy Level</dt>
            <dd className="text-slate-200 font-mono mt-0.5">
              {gov?.defaultAutonomyLevel ?? 'L1'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400">Fail Closed on Policy Error</dt>
            <dd className="text-emerald-400 font-mono mt-0.5">
              {String(gov?.failClosedOnPolicyError ?? true)}
            </dd>
          </div>
        </dl>
      </section>

      {levels && (
        <section className="space-y-2.5">
          <h3 className="text-sm font-semibold text-slate-200">
            Autonomy Levels (L0–L4)
          </h3>
          <div className="rounded-xl border border-slate-800 bg-[#0B1120] divide-y divide-slate-800/80">
            {(['L0', 'L1', 'L2', 'L3', 'L4'] as const).map((lvl) => {
              const info = levels[lvl];
              if (!info) return null;
              return (
                <div key={lvl} className="p-3.5 text-xs space-y-0.5">
                  <div className="font-mono font-semibold text-indigo-300">
                    {lvl} · {info.id}
                  </div>
                  <div className="text-slate-300">{info.description}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {gates && (
        <section className="space-y-2.5">
          <h3 className="text-sm font-semibold text-slate-200">
            Mandatory Owner Approval Gates
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Object.entries(gates).map(([gateName, gate]) => (
              <div
                key={gateName}
                className="rounded-xl border border-slate-800 bg-[#0B1120] p-3.5 text-xs space-y-1"
              >
                <div className="font-mono font-medium text-slate-100">
                  {gateName}
                </div>
                <div className="text-slate-400 font-mono">
                  Level: {gate.autonomyLevel} · Required: {String(gate.required)} · Auto-approve:{' '}
                  {String(gate.allowAutoApprove)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2.5">
        <h3 className="text-sm font-semibold text-slate-200">
          RBAC Role Permission Boundaries
        </h3>
        <div className="rounded-xl border border-slate-800 bg-[#0B1120] divide-y divide-slate-800/80">
          {Object.entries(rbacRoles).map(([role, perms]) => (
            <div key={role} className="p-3.5 text-xs space-y-1">
              <div className="font-mono font-semibold text-cyan-300">{role}</div>
              <div className="font-mono text-slate-400 break-words">
                {perms.join(', ')}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2.5">
        <h3 className="text-sm font-semibold text-slate-200 tabular-nums">
          Closed Policy Action Catalog ({overview.action_catalog.length})
        </h3>
        <div className="rounded-xl border border-slate-800 bg-[#0B1120] divide-y divide-slate-800/80">
          {overview.action_catalog.map((spec) => (
            <div key={spec.action} className="p-3.5 text-xs space-y-1">
              <div className="flex items-center justify-between gap-2 font-mono">
                <span className="text-slate-100 font-medium">{spec.action}</span>
                <span className="text-indigo-300">
                  {spec.required_autonomy}
                  {spec.owner_exclusive ? ' · owner-exclusive' : ''}
                </span>
              </div>
              <div className="text-slate-300">{spec.description}</div>
              <div className="text-slate-500 font-mono">
                Scope: {spec.required_scope} · Envs: {spec.allowed_environments.join(', ')}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
