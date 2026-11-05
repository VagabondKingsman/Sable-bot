/**
 * W3 (D7): at most N (≤2) heavy agents at once — desktop vision runs and
 * spawned subagents share these slots. In-memory, one server process.
 */
export type Heavy = {
  acquire(label: string, opts?: { signal?: AbortSignal; waitMs?: number }): Promise<(() => void) | null>;
  active(): string[];
  max(): number;
};

export function createHeavy(max: () => number): Heavy {
  const running = new Map<number, string>();
  const waiters: (() => void)[] = [];
  let seq = 0;
  const wake = () => {
    const w = waiters.shift();
    if (w) w();
  };
  const take = (label: string) => {
    const id = ++seq;
    running.set(id, label);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      running.delete(id);
      wake();
    };
  };
  return {
    async acquire(label, opts = {}) {
      if (running.size < max()) return take(label);
      const waitMs = opts.waitMs ?? 0;
      if (waitMs <= 0 || opts.signal?.aborted) return null;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          const i = waiters.indexOf(onWake);
          if (i >= 0) waiters.splice(i, 1);
          resolve(ok ? take(label) : null);
        };
        const onWake = () => (running.size < max() ? finish(true) : waiters.unshift(onWake));
        const onAbort = () => finish(false);
        const timer = setTimeout(() => finish(false), waitMs);
        (timer as { unref?: () => void }).unref?.();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(onWake);
      });
    },
    active: () => [...running.values()],
    max,
  };
}
