/** Turn Sable's records into triage inputs and run them through triage with a cache. */
import type { InboxItem } from "../jobs/types.ts";
import type { ProactiveStore, ItemState } from "./store.ts";
import { BUCKET_RANK, URGENCY_RANK, triageOne, type TriageDeps, type TriageInput, type TriageResult } from "./triage.ts";

export type TriagedItem = { input: TriageInput; result: TriageResult; state: ItemState | null; snoozed: boolean };

export function fromInbox(item: InboxItem): TriageInput {
  return {
    id: item.id,
    source: item.routineId ? "routine" : "inbox",
    title: item.title,
    body: item.snippet,
    at: item.createdAt,
    meta: {
      kind: item.kind === "approval" ? "approval" : "result",
      status: item.status,
      approvalId: item.approvalId,
      jobId: item.jobId || undefined,
      routineId: item.routineId,
    },
  };
}

/** Cache key: re-triage only when what the rules / model see changes. */
export function keyOf(input: TriageInput) {
  const s = `${input.meta?.kind ?? ""}|${input.meta?.status ?? ""}|${input.title}|${input.body}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function buildFeed(inputs: TriageInput[], store: ProactiveStore, deps: TriageDeps = {}, now = Date.now()): Promise<TriagedItem[]> {
  const out: TriagedItem[] = [];
  for (const input of inputs) {
    const key = keyOf(input);
    let result: TriageResult | undefined = store.verdict(input.id, key);
    if (!result) {
      result = await triageOne(input, deps);
      store.putVerdict(input.id, key, result, now);
    }
    const state = store.state(input.id) ?? null;
    out.push({ input, result: { bucket: result.bucket, urgency: result.urgency, reason: result.reason, decidedBy: result.decidedBy }, state, snoozed: Boolean(state?.snoozedUntil && state.snoozedUntil > now) });
  }
  return out.sort(
    (a, b) =>
      BUCKET_RANK[a.result.bucket] - BUCKET_RANK[b.result.bucket] ||
      URGENCY_RANK[a.result.urgency] - URGENCY_RANK[b.result.urgency] ||
      b.input.at - a.input.at,
  );
}

export function counts(items: TriagedItem[]) {
  const c = { needs_reply: 0, needs_approval: 0, fyi: 0, ignore: 0 } as Record<string, number>;
  for (const it of items) if (!it.state?.done && !it.snoozed) c[it.result.bucket]++;
  return c;
}
