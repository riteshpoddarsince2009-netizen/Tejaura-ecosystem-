import type { TaskStatus } from '../types/controlPlane.ts';

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatTaskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'waiting_for_approval':
      return 'Waiting Approval';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function getTaskStatusTextClass(status: TaskStatus): string {
  switch (status) {
    case 'succeeded':
      return 'text-emerald-400';
    case 'running':
      return 'text-cyan-400';
    case 'waiting_for_approval':
      return 'text-amber-300';
    case 'queued':
      return 'text-indigo-300';
    case 'failed':
      return 'text-rose-400';
    case 'cancelled':
      return 'text-slate-400';
  }
}

export function getApprovalStatusTextClass(
  status: 'pending' | 'approved' | 'rejected' | 'expired',
): string {
  switch (status) {
    case 'pending':
      return 'text-amber-300';
    case 'approved':
      return 'text-emerald-400';
    case 'rejected':
      return 'text-rose-400';
    case 'expired':
      return 'text-slate-400';
  }
}
