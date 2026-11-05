/**
 * Browser side of desk sync. localStorage stays the fast local cache; the
 * server copy (/api/desk) is the shared truth across tabs and devices.
 *
 * - First run on a browser: everything already in localStorage that the
 *   server does not have yet is uploaded (one-time migration, nothing lost).
 * - Every local change to a thread or the presets is pushed (debounced,
 *   max wait) with a modification time; the server keeps the newest copy.
 * - Pull: every few seconds while the tab is visible, on focus, and right
 *   after another tab of this browser synced (BroadcastChannel).
 * - A thread that is streaming in this tab is never overwritten by a pull.
 */
import { withPrefix } from "@/lib/agent/client";
import type { Thread } from "@/lib/agent/types";
import type { PresetState } from "@/lib/agent/presets";
import type { DeskChanges } from "./sync";

type Store = {
  getState: () => { threads: Thread[]; activeId: string } & PresetState;
  setState: (partial: Record<string, unknown>) => void;
  subscribe: (fn: (state: { threads: Thread[] } & PresetState, prev: { threads: Thread[] } & PresetState) => void) => () => void;
};

const META_KEY = "sable-desk-sync";
const LOCAL_MAX = 40;
const PUSH_DEBOUNCE = 1200;
const PUSH_MAX_WAIT = 5000;
const POLL_MS = 5000;

type Meta = { mtimes: Record<string, number>; presetsMtime: number; deleted: Record<string, number>; migratedAt?: number };

export type SyncStatus = { state: "off" | "idle" | "syncing" | "error" | "disabled"; lastSync?: number; error?: string; migratedAt?: number };

let status: SyncStatus = { state: "off" };
const listeners = new Set<() => void>();
export function syncStatus() {
  return status;
}
export function onSyncStatus(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(next: Partial<SyncStatus>) {
  status = { ...status, ...next };
  for (const fn of listeners) fn();
}

function loadMeta(): Meta {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) ?? "null");
    if (raw && typeof raw === "object") return { mtimes: raw.mtimes ?? {}, presetsMtime: raw.presetsMtime ?? 0, deleted: raw.deleted ?? {}, migratedAt: raw.migratedAt };
  } catch {
    /* ignore */
  }
  return { mtimes: {}, presetsMtime: 0, deleted: {} };
}

const inFlight = (t: Thread) => t.messages.some((m) => m.status);
const presetSig = (p: PresetState) => JSON.stringify([p.presets, p.activePresetId, p.modelBindings]);

let started = false;

export function startDeskSync(store: Store) {
  if (started || typeof window === "undefined") return () => {};
  started = true;
  const meta = loadMeta();
  let since = 0;
  let applying = false;
  let dirty = new Set<string>();
  let presetsDirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstDirtyAt = 0;
  let busy: Promise<void> | null = null;
  let disabled = false;
  const known = new Map<string, Thread>();
  let knownPresets = "";
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("sable-desk") : null;

  const saveMeta = () => {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch {
      /* ignore */
    }
  };

  function remember(state: { threads: Thread[] } & PresetState) {
    known.clear();
    for (const t of state.threads) known.set(t.id, t);
    knownPresets = presetSig(state);
  }

  function apply(changes: DeskChanges) {
    const state = store.getState();
    const byId = new Map(state.threads.map((t) => [t.id, t]));
    let touched = false;
    for (const { id, at } of changes.deleted) {
      const local = byId.get(id);
      if (local && !inFlight(local) && (meta.mtimes[id] ?? 0) <= at) {
        byId.delete(id);
        dirty.delete(id);
        touched = true;
      }
      delete meta.mtimes[id];
    }
    for (const { thread, mtime } of changes.threads) {
      const local = byId.get(thread.id);
      if (local && inFlight(local)) continue;
      if ((meta.mtimes[thread.id] ?? 0) >= mtime && local) continue;
      if (dirty.has(thread.id) && (meta.mtimes[thread.id] ?? 0) > mtime) continue;
      byId.set(thread.id, thread);
      meta.mtimes[thread.id] = mtime;
      dirty.delete(thread.id);
      touched = true;
    }
    const patch: Record<string, unknown> = {};
    if (changes.presets && changes.presets.mtime > meta.presetsMtime && !presetsDirty) {
      Object.assign(patch, changes.presets.state);
      meta.presetsMtime = changes.presets.mtime;
    }
    if (touched) {
      let threads = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LOCAL_MAX);
      if (!threads.length) threads = state.threads.filter((t) => t.messages.length === 0).slice(0, 1);
      if (threads.length) {
        patch.threads = threads;
        if (!threads.some((t) => t.id === state.activeId)) patch.activeId = threads[0].id;
      }
    }
    if (Object.keys(patch).length) {
      applying = true;
      try {
        store.setState(patch);
      } finally {
        applying = false;
      }
    }
    remember(store.getState());
    since = changes.rev;
    saveMeta();
  }

  async function request(push: Record<string, unknown> | null) {
    const res = await fetch(withPrefix("/api/desk"), {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sync", since, push: push ?? {} }),
    });
    if (res.status === 409) {
      disabled = true;
      setStatus({ state: "disabled" });
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as DeskChanges & { changed: number };
  }

  function buildPush() {
    const state = store.getState();
    const threads = state.threads
      .filter((t) => dirty.has(t.id))
      .map((t) => ({ thread: t, mtime: meta.mtimes[t.id] ?? Date.now() }));
    const deleted = Object.entries(meta.deleted).map(([id, at]) => ({ id, at }));
    const push: Record<string, unknown> = { threads, deleted };
    if (presetsDirty) push.presets = { state: { presets: state.presets, activePresetId: state.activePresetId, modelBindings: state.modelBindings }, mtime: meta.presetsMtime };
    return { push, sentThreads: new Set(threads.map((t) => t.thread.id)), sentDeleted: Object.keys(meta.deleted), sentPresets: presetsDirty };
  }

  function sync(): Promise<void> {
    if (disabled) return Promise.resolve();
    if (busy) return busy.then(() => (dirty.size || presetsDirty ? sync() : undefined));
    clearTimeout(timer);
    firstDirtyAt = 0;
    const { push, sentThreads, sentDeleted, sentPresets } = buildPush();
    // Streaming threads are pushed again once they settle.
    for (const id of sentThreads) dirty.delete(id);
    if (sentPresets) presetsDirty = false;
    setStatus({ state: "syncing" });
    busy = request(push)
      .then((changes) => {
        if (!changes) return;
        for (const id of sentDeleted) delete meta.deleted[id];
        apply(changes);
        if (changes.changed) channel?.postMessage("changed");
        setStatus({ state: "idle", lastSync: Date.now(), error: undefined });
      })
      .catch((error: unknown) => {
        for (const id of sentThreads) dirty.add(id);
        if (sentPresets) presetsDirty = true;
        setStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        busy = null;
      });
    return busy;
  }

  function schedule() {
    const now = Date.now();
    if (!firstDirtyAt) firstDirtyAt = now;
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(PUSH_DEBOUNCE, firstDirtyAt + PUSH_MAX_WAIT - now));
    timer = setTimeout(() => void sync(), wait);
  }

  async function initial() {
    setStatus({ state: "syncing" });
    let server: (DeskChanges & { changed: number }) | null;
    try {
      server = await request(null);
    } catch (error) {
      setStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      setTimeout(() => void initial(), 15_000);
      return;
    }
    if (!server) return;
    const state = store.getState();
    const remote = new Map(server.threads.map((t) => [t.thread.id, t]));
    const tomb = new Map(server.deleted.map((d) => [d.id, d.at]));
    // Local copies the server lacks (or has older) get uploaded: the one-time migration and offline edits.
    for (const t of state.threads) {
      const localM = meta.mtimes[t.id] ?? t.updatedAt;
      const r = remote.get(t.id);
      const deadAt = tomb.get(t.id);
      if (deadAt !== undefined && deadAt >= localM) continue;
      if (!r && t.messages.length === 0) continue;
      if (!r || localM > r.mtime) {
        meta.mtimes[t.id] = Math.max(localM, (r?.mtime ?? 0) + 1, deadAt !== undefined ? deadAt + 1 : 0);
        dirty.add(t.id);
      }
    }
    const localPresetsNewer = meta.presetsMtime > (server.presets?.mtime ?? 0) || (!server.presets && !meta.migratedAt);
    if (localPresetsNewer) {
      meta.presetsMtime = Math.max(meta.presetsMtime, Date.now());
      presetsDirty = true;
    }
    apply({ ...server, threads: server.threads.filter((t) => !dirty.has(t.thread.id)) });
    if (!meta.migratedAt) meta.migratedAt = Date.now();
    setStatus({ state: "idle", lastSync: Date.now(), migratedAt: meta.migratedAt });
    saveMeta();
    if (dirty.size || presetsDirty) await sync();

    store.subscribe((next) => {
      if (applying) return;
      const now = Date.now();
      let changed = false;
      const ids = new Set<string>();
      for (const t of next.threads) {
        ids.add(t.id);
        if (known.get(t.id) !== t) {
          if (t.messages.length === 0 && !meta.mtimes[t.id]) continue;
          meta.mtimes[t.id] = Math.max(now, (meta.mtimes[t.id] ?? 0) + 1);
          dirty.add(t.id);
          changed = true;
        }
      }
      for (const id of known.keys())
        if (!ids.has(id) && meta.mtimes[id]) {
          meta.deleted[id] = Math.max(now, meta.mtimes[id] + 1);
          delete meta.mtimes[id];
          dirty.delete(id);
          changed = true;
        }
      if (presetSig(next) !== knownPresets) {
        meta.presetsMtime = Math.max(now, meta.presetsMtime + 1);
        presetsDirty = true;
        changed = true;
      }
      remember(next);
      if (changed) {
        saveMeta();
        schedule();
      }
    });

    const poll = () => {
      if (document.visibilityState === "visible") void sync();
    };
    setInterval(poll, POLL_MS);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    if (channel) channel.onmessage = () => void sync();
    window.addEventListener("pagehide", () => {
      if (!dirty.size && !presetsDirty && !Object.keys(meta.deleted).length) return;
      const { push } = buildPush();
      try {
        navigator.sendBeacon?.(withPrefix("/api/desk"), new Blob([JSON.stringify({ action: "sync", since, push })], { type: "application/json" }));
      } catch {
        /* ignore */
      }
    });
  }

  remember(store.getState());
  void initial();
  return () => {};
}

export async function exportDesk() {
  const res = await fetch(withPrefix("/api/desk?export=1"), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export async function importDesk(file: unknown) {
  const res = await fetch(withPrefix("/api/desk"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "import", file }),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string; changed?: number };
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
  return body;
}
