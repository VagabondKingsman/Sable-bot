/**
 * Job events for outside channels, without an import cycle between
 * jobs.server and channels.server. Listeners must never throw into the runner.
 */
import type { Job, JobApproval } from "@/lib/agent/jobs/types";

type Listener = {
  finish?: (job: Job) => void;
  waiting?: (job: Job, approval: JobApproval) => void;
  settled?: (job: Job, approval: JobApproval) => void;
};

const KEY = Symbol.for("sable.channel.bus.v1");

function listeners(): Map<string, Listener> {
  const scope = globalThis as unknown as Record<symbol, Map<string, Listener> | undefined>;
  return (scope[KEY] ??= new Map());
}

export function onJobEvents(name: string, listener: Listener) {
  listeners().set(name, listener);
}

export function emitJobEvent<K extends keyof Listener>(kind: K, ...args: Parameters<NonNullable<Listener[K]>>) {
  for (const listener of listeners().values()) {
    try {
      (listener[kind] as ((...a: unknown[]) => void) | undefined)?.(...args);
    } catch (error) {
      console.warn(`[sable-channels] ${kind} listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
