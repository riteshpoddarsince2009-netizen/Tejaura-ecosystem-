import { useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { AuditLogItem } from '../types/controlPlane.ts';
import { formatTimestamp } from './formatters.ts';

interface AuditCenterViewProps {
  events: AuditLogItem[];
  loading: boolean;
  onRefresh: () => Promise<void>;
}

const OUTCOME_FILTERS = ['all', 'success', 'denied', 'failure', 'cancelled', 'pending'] as const;

function getOutcomeTextClass(outcome: string): string {
  switch (outcome) {
    case 'success':
      return 'text-emerald-400';
    case 'denied':
      return 'text-amber-300';
    case 'failure':
      return 'text-rose-400';
    case 'pending':
      return 'text-cyan-400';
    default:
      return 'text-slate-400';
  }
}

export function AuditCenterView({ events, loading, onRefresh }: AuditCenterViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all');
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('all');

  const eventTypes = useMemo(() => {
    const unique = new Set<string>();
    for (const evt of events) {
      if (evt.event_type) unique.add(evt.event_type);
    }
    return ['all', ...Array.from(unique).sort()];
  }, [events]);

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return events.filter((evt) => {
      if (outcomeFilter !== 'all' && evt.outcome !== outcomeFilter) {
        return false;
      }
      if (eventTypeFilter !== 'all' && evt.event_type !== eventTypeFilter) {
        return false;
      }
      if (!q) return true;
      return (
        evt.actor_id.toLowerCase().includes(q) ||
        evt.actor_type.toLowerCase().includes(q) ||
        evt.action.toLowerCase().includes(q) ||
        evt.resource_type.toLowerCase().includes(q) ||
        evt.resource_id.toLowerCase().includes(q) ||
        evt.event_type.toLowerCase().includes(q) ||
        evt.id.toLowerCase().includes(q)
      );
    });
  }, [events, searchQuery, outcomeFilter, eventTypeFilter]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-50">
            Audit Center
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
            Read-only structured security and governance trail ({filteredEvents.length} of {events.length} recent records)
          </p>
        </div>

        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#0B1120] px-4 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap self-start sm:self-auto"
        >
          <RefreshCw className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
          <span>{loading ? 'Refreshing…' : 'Refresh Trail'}</span>
        </button>
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-3.5 space-y-3">
        <div className="relative">
          <Search
            className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Filter audit records"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by actor, action, resource, or event ID"
            className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] pl-10 pr-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="audit-outcome-filter" className="block text-xs text-slate-400 mb-1">
              Outcome
            </label>
            <select
              id="audit-outcome-filter"
              value={outcomeFilter}
              onChange={(e) => setOutcomeFilter(e.target.value)}
              className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
            >
              {OUTCOME_FILTERS.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {outcome === 'all' ? 'All outcomes' : outcome}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="audit-type-filter" className="block text-xs text-slate-400 mb-1">
              Event Type
            </label>
            <select
              id="audit-type-filter"
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="w-full min-h-[44px] rounded-xl border border-slate-700 bg-[#030712] px-3 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
            >
              {eventTypes.map((typeName) => (
                <option key={typeName} value={typeName}>
                  {typeName === 'all' ? 'All event types' : typeName}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loading && events.length === 0 ? (
        <div className="h-44 rounded-xl border border-slate-800 bg-[#0B1120] animate-pulse" />
      ) : filteredEvents.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#0B1120] p-6 text-center text-sm text-slate-400">
          No audit events match the active filters.
        </div>
      ) : (
        <>
          {/* Mobile stacked list */}
          <div className="md:hidden rounded-xl border border-slate-800 bg-[#0B1120] divide-y divide-slate-800/80">
            {filteredEvents.map((evt) => (
              <div key={evt.id} className="p-4 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium text-slate-100 font-mono break-all">
                    {evt.action}
                  </div>
                  <span
                    className={`text-xs font-medium capitalize shrink-0 ${getOutcomeTextClass(evt.outcome)}`}
                  >
                    {evt.outcome}
                  </span>
                </div>
                <div className="text-xs text-slate-300 font-mono break-all">
                  {evt.actor_type}:{evt.actor_id} · {evt.resource_type}:{evt.resource_id}
                </div>
                <div className="text-xs text-slate-400 font-mono tabular-nums">
                  {evt.event_type} · {formatTimestamp(evt.timestamp)}
                  {evt.approval_id ? ` · Approval ${evt.approval_id}` : ''}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop structured table */}
          <div className="hidden md:block rounded-xl border border-slate-800 bg-[#0B1120] overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-3 px-4 font-medium">Timestamp</th>
                  <th className="py-3 px-4 font-medium">Actor</th>
                  <th className="py-3 px-4 font-medium">Action</th>
                  <th className="py-3 px-4 font-medium">Resource</th>
                  <th className="py-3 px-4 font-medium">Event Type</th>
                  <th className="py-3 px-4 font-medium text-right">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredEvents.map((evt) => (
                  <tr key={evt.id} className="hover:bg-slate-900/40">
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {formatTimestamp(evt.timestamp)}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-200">
                      {evt.actor_type}:{evt.actor_id}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-100">
                      {evt.action}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-300 max-w-[260px] truncate">
                      {evt.resource_type}:{evt.resource_id}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-400">
                      {evt.event_type}
                    </td>
                    <td
                      className={`py-3 px-4 font-medium capitalize text-right whitespace-nowrap ${getOutcomeTextClass(evt.outcome)}`}
                    >
                      {evt.outcome}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
