/**
 * W7: owner messages steered into a running background job (Telegram/webhook: a new message while
 * the chat's job runs). The job loop drains them at its next safe point. In memory only.
 */
import { steerText } from "@/lib/agent/turns/reply";

const KEY = Symbol.for("sable.job.steer.v1");

function inbox(): Map<string, string[]> {
  const scope = globalThis as unknown as Record<symbol, Map<string, string[]> | undefined>;
  return (scope[KEY] ??= new Map());
}

export function steerJob(jobId: string, content: string) {
  const box = inbox();
  const list = box.get(jobId) ?? [];
  if (list.length >= 20) return false;
  list.push(content);
  box.set(jobId, list);
  return true;
}

export function takeJobSteer(jobId: string): string[] {
  const list = inbox().get(jobId);
  if (!list?.length) return [];
  inbox().delete(jobId);
  return list.map(steerText);
}

/** Messages that never reached a safe point (job ended): the caller turns them into a new job. */
export function leftoverJobSteer(jobId: string): string[] {
  const list = inbox().get(jobId) ?? [];
  inbox().delete(jobId);
  return list;
}
