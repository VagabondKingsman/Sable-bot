/**
 * W2a proactive core, server side: triage feed over the in-app inbox
 * (job / routine results, approval asks) plus incoming channel events, and the
 * morning brief. Kill switches: SABLE_PROACTIVE=0 (all), SABLE_TRIAGE=0,
 * SABLE_BRIEF=0. Owner-only like every /api route; nothing here sends a
 * message except the opt-in brief to the owner's own inbox / Telegram.
 */
import { ProactiveStore } from "@/lib/agent/proactive/store";
import { buildFeed, counts, fromInbox, type TriagedItem } from "@/lib/agent/proactive/feed";
import type { TriageDeps, TriageInput } from "@/lib/agent/proactive/triage";
import type { ChatRequest } from "@/lib/agent/types";
import { dataDir } from "@/server/paths";
import { jobService } from "@/server/jobs.server";
import { prepareTurn } from "@/server/chat.server";
import { completerFor } from "@/server/memory.server";

const KEY = Symbol.for("sable.proactive.store");
type G = typeof globalThis & { [KEY]?: ProactiveStore };

export function proactiveOn() {
  return process.env.SABLE_PROACTIVE !== "0";
}
export function triageOn() {
  return proactiveOn() && process.env.SABLE_TRIAGE !== "0";
}
export function briefOn() {
  return proactiveOn() && process.env.SABLE_BRIEF !== "0";
}

export function proactiveStore(): ProactiveStore {
  const g = globalThis as G;
  return (g[KEY] ??= new ProactiveStore(dataDir()));
}

/** Light model completer, only when SABLE_MODEL_LIGHT names a model we can reach. */
export function lightTriageDeps(): TriageDeps {
  const model = process.env.SABLE_MODEL_LIGHT?.trim();
  const person = { name: process.env.SABLE_OWNER_NAME?.trim() || "the owner" };
  if (!model) return { person };
  const req: ChatRequest = {
    model,
    effort: "low",
    instructions: "",
    memory: "",
    messages: [],
    tools: { web: false, x: false, code: false, image: false },
    remember: false,
  };
  const complete = completerFor(() => prepareTurn({ ...req, messages: [{ role: "user", content: "triage" }] }));
  return {
    person,
    model,
    complete: (prompt, signal) => complete("You sort incoming items. Reply with one JSON object only.", prompt, signal),
  };
}

/** Record an incoming channel event so triage sees it. No-op when triage is off. */
export function recordIncoming(input: TriageInput) {
  if (!triageOn()) return;
  try {
    proactiveStore().addEvent(input);
  } catch {
    /* never break the channel on a store error */
  }
}

export function triageInputs(): TriageInput[] {
  const inbox = jobService().db.inbox().slice(0, 200).map(fromInbox);
  return [...inbox, ...proactiveStore().events().slice(0, 200)];
}

let lastFeed: { at: number; items: TriagedItem[] } | null = null;

export async function triageFeed(opts: { includeDone?: boolean } = {}) {
  if (!triageOn()) return { enabled: false, items: [] as TriagedItem[], counts: counts([]) };
  const items = await buildFeed(triageInputs(), proactiveStore(), lightTriageDeps());
  lastFeed = { at: Date.now(), items };
  const shown = opts.includeDone ? items : items.filter((it) => !it.state?.done);
  return { enabled: true, items: shown, counts: counts(items), model: process.env.SABLE_MODEL_LIGHT?.trim() || null };
}

export function lastTriage() {
  return lastFeed;
}

export function setItemState(id: string, action: "snooze" | "unsnooze" | "done" | "undone", untilMs?: number) {
  const store = proactiveStore();
  if (action === "snooze") return store.setState(id, { snoozedUntil: Date.now() + Math.min(Math.max(untilMs ?? 3_600_000, 60_000), 7 * 86_400_000) });
  if (action === "unsnooze") return store.setState(id, { snoozedUntil: undefined });
  if (action === "done") return store.setState(id, { done: true });
  return store.setState(id, { done: false });
}
