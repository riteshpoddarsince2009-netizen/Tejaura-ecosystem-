import type { ModelWorkerClient } from './model-worker-types.ts';

interface PendingJob<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class ModelWorkerPool {
  private readonly maxConcurrent: number;
  private readonly queue: Array<PendingJob<unknown>> = [];
  private active = 0;

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = Math.max(1, Math.min(8, Math.trunc(maxConcurrent)));
  }

  get activeJobs(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  async submit<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: PendingJob<T> = { run, resolve, reject };
      this.queue.push(job as PendingJob<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active += 1;
      void next
        .run()
        .then((value) => next.resolve(value))
        .catch((err) => next.reject(err))
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

export interface WorkerAvailability {
  worker_id: string;
  runtime_type: string;
  healthy: boolean;
  latency_ms: number;
  models: string[];
  error?: string;
}

export async function probeWorker(
  worker: ModelWorkerClient,
  timeoutMs = 5_000,
): Promise<WorkerAvailability> {
  try {
    const health = await worker.health(timeoutMs);
    return {
      worker_id: worker.worker_id,
      runtime_type: worker.runtime_type,
      healthy: health.healthy,
      latency_ms: health.latency_ms,
      models: health.models,
      error: health.error,
    };
  } catch (err) {
    return {
      worker_id: worker.worker_id,
      runtime_type: worker.runtime_type,
      healthy: false,
      latency_ms: 0,
      models: [],
      error: err instanceof Error ? err.message : 'Worker health probe failed.',
    };
  }
}
