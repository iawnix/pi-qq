export class QueueFullError extends Error {}
export class StoppedError extends Error {}

interface Job {
  key: string;
  owner: string;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Hold the conversation lock until the job actually settles, including on abort. */
export class Scheduler {
  private pending: Job[] = [];
  private active = new Map<string, Job>();
  private stopped = false;
  private drainWaiters: Array<() => void> = [];

  constructor(private concurrency = 4, private perChat = 3, private total = 64) {}

  submit(key: string, owner: string, run: Job["run"]): Promise<void> {
    if (this.stopped) return Promise.reject(new StoppedError("服务已停止"));
    if (this.pending.length >= this.total || this.pending.filter(j => j.key === key).length >= this.perChat) {
      return Promise.reject(new QueueFullError("队列已满"));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ key, owner, run, resolve, reject, controller: new AbortController() });
      this.pump();
    });
  }

  cancel(key: string, owner?: string): boolean {
    const matches = (j: Job) => j.key === key && (owner === undefined || j.owner === owner);
    let cancelled = false;
    this.pending = this.pending.filter(j => {
      if (!matches(j)) return true;
      cancelled = true;
      j.reject(new StoppedError("请求已取消"));
      return false;
    });
    const active = this.active.get(key);
    if (active && matches(active)) {
      cancelled = true;
      active.controller.abort(new StoppedError("请求已取消"));
    }
    return cancelled;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const job of this.pending.splice(0)) job.reject(new StoppedError("服务已停止"));
    for (const job of this.active.values()) job.controller.abort(new StoppedError("服务已停止"));
    if (this.active.size) await new Promise<void>(resolve => this.drainWaiters.push(resolve));
  }

  private pump(): void {
    while (!this.stopped && this.active.size < this.concurrency) {
      const index = this.pending.findIndex(j => !this.active.has(j.key));
      if (index < 0) break;
      const job = this.pending.splice(index, 1)[0]!;
      this.active.set(job.key, job);
      void Promise.resolve().then(() => job.run(job.controller.signal)).then(job.resolve, job.reject).finally(() => {
        this.active.delete(job.key);
        this.pump();
        if (!this.active.size && !this.pending.length) {
          for (const resolve of this.drainWaiters.splice(0)) resolve();
        }
      });
    }
  }
}
