/**
 * Server-side desk storage (threads + presets) shared by every tab and device.
 * Pure functions, no I/O: the server keeps one DeskDoc, clients push changed
 * threads with a modification time (last writer wins per thread) and pull
 * everything changed since the revision they last saw. Deletions are
 * tombstones so a device that was offline cannot resurrect a deleted chat by
 * accident (a later edit, mtime > deletion, does bring it back on purpose).
 */
import type { ApprovalRequest, ChatMessage, Thread } from "../types.ts";
import type { PresetState, PromptPreset } from "../presets.ts";

export const DESK_CAPS = {
  maxThreads: 200,
  maxThreadBytes: 2_000_000,
  maxMessages: 600,
  maxContent: 400_000,
  maxDocBytes: 30_000_000,
  maxPresets: 100,
  maxPresetBody: 40_000,
  tombstoneDays: 60,
  maxPushThreads: 60,
};

export type StoredThread = { thread: Thread; mtime: number; rev: number };
export type Tombstone = { at: number; rev: number };
export type StoredPresets = { state: PresetState; mtime: number; rev: number };
export type DeskDoc = {
  v: 1;
  rev: number;
  threads: Record<string, StoredThread>;
  tombstones: Record<string, Tombstone>;
  presets: StoredPresets | null;
};

export type DeskPush = {
  threads?: { thread: unknown; mtime: number }[];
  deleted?: { id: string; at: number }[];
  presets?: { state: unknown; mtime: number } | null;
};

export type DeskChanges = {
  rev: number;
  threads: { thread: Thread; mtime: number }[];
  deleted: { id: string; at: number }[];
  presets: { state: PresetState; mtime: number } | null;
  full: boolean;
};

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function emptyDoc(): DeskDoc {
  return { v: 1, rev: 0, threads: {}, tombstones: {}, presets: null };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function cleanApproval(raw: unknown): ApprovalRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const id = str(a.id, 120);
  if (!id) return null;
  const state = a.state === "approved" || a.state === "rejected" ? a.state : "expired";
  // A pending approval only means something to the tab that is streaming; on the server it is dead.
  return { id, tool: str(a.tool, 80) ?? "", summary: str(a.summary, 500) ?? "", preview: str(a.preview, 4000), state };
}

function cleanMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.id, 120);
  if (!id || (m.role !== "user" && m.role !== "assistant")) return null;
  const out: ChatMessage = { id, role: m.role, content: str(m.content, DESK_CAPS.maxContent) ?? "" };
  const notice = str(m.notice, 2000);
  if (notice) out.notice = notice;
  if (m.media && typeof m.media === "object") {
    const media = m.media as Record<string, unknown>;
    const src = str(media.src, 200_000);
    if ((media.type === "image" || media.type === "video") && src && !(src.startsWith("data:") && src.length > 120_000)) out.media = { type: media.type, src };
  }
  if (Array.isArray(m.steps))
    out.steps = m.steps.slice(0, 200).flatMap((s) => {
      if (!s || typeof s !== "object") return [];
      const step = s as Record<string, unknown>;
      const sid = str(step.id, 120);
      const kind = step.kind;
      if (!sid || !["think", "web", "x", "code", "image", "tool"].includes(kind as string)) return [];
      return [{
        id: sid,
        kind: kind as "tool",
        label: str(step.label, 400) ?? "",
        detail: str(step.detail, 20_000),
        state: "done" as const,
        parent: str(step.parent, 300),
        sources: Array.isArray(step.sources) ? step.sources.filter((x): x is string => typeof x === "string").slice(0, 50).map((x) => x.slice(0, 2000)) : undefined,
      }];
    });
  if (Array.isArray(m.citations)) out.citations = m.citations.filter((x): x is string => typeof x === "string").slice(0, 100).map((x) => x.slice(0, 2000));
  if (Array.isArray(m.approvals)) out.approvals = m.approvals.slice(0, 50).map(cleanApproval).filter((a): a is ApprovalRequest => !!a);
  const startedAt = num(m.startedAt);
  const finishedAt = num(m.finishedAt);
  if (startedAt) out.startedAt = startedAt;
  if (finishedAt) out.finishedAt = finishedAt;
  return out;
}

/** Validate + strip a thread coming from a client; null = refuse it. */
export function cleanThread(raw: unknown): Thread | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const id = typeof t.id === "string" && ID_RE.test(t.id) ? t.id : null;
  if (!id || !Array.isArray(t.messages)) return null;
  const messages = t.messages.slice(-DESK_CAPS.maxMessages).map(cleanMessage).filter((m): m is ChatMessage => !!m);
  const thread: Thread = { id, title: str(t.title, 200) || "Cuộc mới", updatedAt: num(t.updatedAt) ?? Date.now(), messages };
  if (t.noMemory === true) thread.noMemory = true;
  if (JSON.stringify(thread).length > DESK_CAPS.maxThreadBytes) return null;
  return thread;
}

export function cleanPresets(raw: unknown): PresetState | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.presets)) return null;
  const presets: PromptPreset[] = p.presets.slice(0, DESK_CAPS.maxPresets).flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const r = x as Record<string, unknown>;
    const id = str(r.id, 120);
    if (!id) return [];
    return [{ id, name: str(r.name, 120) ?? "", body: str(r.body, DESK_CAPS.maxPresetBody) ?? "", updatedAt: num(r.updatedAt) ?? 0 }];
  });
  const ids = new Set(presets.map((x) => x.id));
  const activePresetId = typeof p.activePresetId === "string" && ids.has(p.activePresetId) ? p.activePresetId : null;
  const modelBindings: Record<string, string> = {};
  if (p.modelBindings && typeof p.modelBindings === "object")
    for (const [model, pid] of Object.entries(p.modelBindings as Record<string, unknown>).slice(0, 200))
      if (typeof pid === "string" && ids.has(pid) && model.length <= 200) modelBindings[model] = pid;
  return { presets, activePresetId, modelBindings };
}

function docBytes(doc: DeskDoc) {
  return JSON.stringify(doc).length;
}

/** Enforce thread count, doc size and tombstone age caps (oldest first). */
export function enforceCaps(doc: DeskDoc, now = Date.now()): DeskDoc {
  const cutoff = now - DESK_CAPS.tombstoneDays * 86_400_000;
  for (const [id, t] of Object.entries(doc.tombstones)) if (t.at < cutoff) delete doc.tombstones[id];
  const ids = Object.keys(doc.threads).sort((a, b) => doc.threads[a].mtime - doc.threads[b].mtime);
  while (ids.length > DESK_CAPS.maxThreads) delete doc.threads[ids.shift() as string];
  while (ids.length > 1 && docBytes(doc) > DESK_CAPS.maxDocBytes) delete doc.threads[ids.shift() as string];
  return doc;
}

/** Apply one client push. Returns how many items changed the doc. */
export function applyPush(doc: DeskDoc, push: DeskPush, now = Date.now()): { changed: number; rejected: number } {
  let changed = 0;
  let rejected = 0;
  const next = doc.rev + 1;
  const clampTime = (t: number) => Math.min(t, now + 60_000);
  for (const item of (push.deleted ?? []).slice(0, 500)) {
    if (!item || typeof item.id !== "string" || !ID_RE.test(item.id) || !num(item.at)) { rejected++; continue; }
    const at = clampTime(item.at);
    const cur = doc.threads[item.id];
    if (cur && cur.mtime > at) continue;
    const prev = doc.tombstones[item.id];
    if (prev && prev.at >= at && !cur) continue;
    delete doc.threads[item.id];
    doc.tombstones[item.id] = { at: Math.max(at, prev?.at ?? 0), rev: next };
    changed++;
  }
  for (const item of (push.threads ?? []).slice(0, DESK_CAPS.maxPushThreads)) {
    const thread = cleanThread(item?.thread);
    const mtime = num(item?.mtime);
    if (!thread || !mtime) { rejected++; continue; }
    const m = clampTime(mtime);
    const cur = doc.threads[thread.id];
    if (cur && cur.mtime >= m) continue;
    const tomb = doc.tombstones[thread.id];
    if (tomb && tomb.at >= m) continue;
    if (tomb) delete doc.tombstones[thread.id];
    doc.threads[thread.id] = { thread, mtime: m, rev: next };
    changed++;
  }
  if (push.presets) {
    const state = cleanPresets(push.presets.state);
    const mtime = num(push.presets.mtime);
    if (!state || !mtime) rejected++;
    else if (!doc.presets || doc.presets.mtime < mtime) {
      doc.presets = { state, mtime: clampTime(mtime), rev: next };
      changed++;
    }
  }
  if (changed) {
    doc.rev = next;
    enforceCaps(doc, now);
  }
  return { changed, rejected };
}

export function changesSince(doc: DeskDoc, since: number): DeskChanges {
  const full = !(since > 0) || since > doc.rev;
  const after = full ? 0 : since;
  return {
    rev: doc.rev,
    full,
    threads: Object.values(doc.threads).filter((t) => t.rev > after).map((t) => ({ thread: t.thread, mtime: t.mtime })),
    deleted: Object.entries(doc.tombstones).filter(([, t]) => t.rev > after).map(([id, t]) => ({ id, at: t.at })),
    presets: doc.presets && doc.presets.rev > after ? { state: doc.presets.state, mtime: doc.presets.mtime } : null,
  };
}

/** Parse a stored doc defensively (unknown → empty). */
export function parseDoc(raw: unknown): DeskDoc {
  const doc = emptyDoc();
  if (!raw || typeof raw !== "object") return doc;
  const r = raw as Record<string, unknown>;
  doc.rev = num(r.rev) ?? 0;
  if (r.threads && typeof r.threads === "object")
    for (const v of Object.values(r.threads as Record<string, unknown>)) {
      const s = v as Partial<StoredThread>;
      const thread = cleanThread(s?.thread);
      if (thread && num(s?.mtime)) doc.threads[thread.id] = { thread, mtime: s.mtime as number, rev: num(s.rev) ?? doc.rev };
    }
  if (r.tombstones && typeof r.tombstones === "object")
    for (const [id, v] of Object.entries(r.tombstones as Record<string, Partial<Tombstone>>))
      if (ID_RE.test(id) && num(v?.at)) doc.tombstones[id] = { at: v.at as number, rev: num(v.rev) ?? doc.rev };
  const p = r.presets as Partial<StoredPresets> | null | undefined;
  const state = p ? cleanPresets(p.state) : null;
  if (p && state && num(p.mtime)) doc.presets = { state, mtime: p.mtime as number, rev: num(p.rev) ?? doc.rev };
  return doc;
}

/** Portable export (no revs). */
export function exportDoc(doc: DeskDoc) {
  return {
    kind: "sable-desk",
    version: 1,
    exportedAt: new Date().toISOString(),
    threads: Object.values(doc.threads).sort((a, b) => b.mtime - a.mtime).map((t) => t.thread),
    presets: doc.presets?.state ?? null,
  };
}

/** Import = a merge push with "now" as mtime for anything not already newer; never deletes. */
export function importFile(doc: DeskDoc, raw: unknown, now = Date.now()) {
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).kind !== "sable-desk") return null;
  const r = raw as Record<string, unknown>;
  const threads = Array.isArray(r.threads) ? r.threads : [];
  let changed = 0;
  let rejected = 0;
  for (let i = 0; i < threads.length; i += DESK_CAPS.maxPushThreads) {
    const res = applyPush(doc, { threads: threads.slice(i, i + DESK_CAPS.maxPushThreads).map((thread) => ({ thread, mtime: now })) }, now);
    changed += res.changed;
    rejected += res.rejected;
  }
  if (r.presets) {
    const incoming = cleanPresets(r.presets);
    if (incoming) {
      const cur = doc.presets?.state;
      const merged: PresetState = cur
        ? {
            presets: [...cur.presets, ...incoming.presets.filter((p) => !cur.presets.some((c) => c.id === p.id))].slice(0, DESK_CAPS.maxPresets),
            activePresetId: cur.activePresetId,
            modelBindings: { ...incoming.modelBindings, ...cur.modelBindings },
          }
        : incoming;
      const res = applyPush(doc, { presets: { state: merged, mtime: now + 1 } }, now + 1);
      changed += res.changed;
    }
  }
  return { changed, rejected };
}
