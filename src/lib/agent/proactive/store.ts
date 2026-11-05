/**
 * proactive.json: incoming events (webhook / Telegram / later mail) waiting to
 * be triaged, cached verdicts (so the light model is asked once per item and
 * state), per-item UI state (snooze / done), and the morning-brief config +
 * history. Owner-only file, 0600, written atomically.
 */
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "../jobs/db.ts";
import type { TriageInput, TriageResult } from "./triage.ts";

export type ItemState = { snoozedUntil?: number; done?: boolean; at: number };
export type CachedVerdict = TriageResult & { key: string; at: number };

export type BriefConfig = {
  enabled: boolean;
  /** HH:MM local time in `tz`. */
  time: string;
  tz: string;
  telegram: boolean;
  lastRunAt: number | null;
  /** YYYY-MM-DD (in tz) of the last scheduled run, so a day fires once. */
  lastSlot: string | null;
};

export type BriefRecord = {
  id: string;
  at: number;
  title: string;
  text: string;
  manual: boolean;
  delivered: string[];
  counts: Record<string, number>;
  /** Items that need the owner, with their chips (approve / snooze / draft / open). */
  items?: import("./unify.ts").UnifiedTask[];
};

export type ProactiveData = {
  v: 1;
  events: TriageInput[];
  verdicts: Record<string, CachedVerdict>;
  states: Record<string, ItemState>;
  brief: BriefConfig;
  briefs: BriefRecord[];
};

export const DEFAULT_BRIEF: BriefConfig = { enabled: false, time: "07:30", tz: "Asia/Saigon", telegram: true, lastRunAt: null, lastSlot: null };
const MAX_EVENTS = 300;
const MAX_VERDICTS = 1_000;
const MAX_BRIEFS = 30;

function fresh(): ProactiveData {
  return { v: 1, events: [], verdicts: {}, states: {}, brief: { ...DEFAULT_BRIEF }, briefs: [] };
}

export function isTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function trimRecord<T extends { at: number }>(rec: Record<string, T>, max: number) {
  const entries = Object.entries(rec);
  if (entries.length <= max) return rec;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, max));
}

export class ProactiveStore {
  private data: ProactiveData;
  readonly file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "proactive.json");
    this.data = this.load();
  }

  private load(): ProactiveData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<ProactiveData>;
      const base = fresh();
      return {
        v: 1,
        events: Array.isArray(raw.events) ? raw.events.filter((e) => e && typeof e.id === "string").slice(0, MAX_EVENTS) : [],
        verdicts: raw.verdicts && typeof raw.verdicts === "object" ? raw.verdicts : {},
        states: raw.states && typeof raw.states === "object" ? raw.states : {},
        brief: { ...base.brief, ...(raw.brief ?? {}) },
        briefs: Array.isArray(raw.briefs) ? raw.briefs.slice(0, MAX_BRIEFS) : [],
      };
    } catch {
      return fresh();
    }
  }

  private save() {
    this.data.verdicts = trimRecord(this.data.verdicts, MAX_VERDICTS);
    this.data.states = trimRecord(this.data.states, MAX_VERDICTS);
    writeAtomic(this.file, JSON.stringify(this.data));
  }

  events() {
    return this.data.events;
  }

  addEvent(input: TriageInput) {
    this.data.events = [input, ...this.data.events.filter((e) => e.id !== input.id)].slice(0, MAX_EVENTS);
    this.save();
  }

  verdict(id: string, key: string): CachedVerdict | undefined {
    const v = this.data.verdicts[id];
    return v && v.key === key ? v : undefined;
  }

  putVerdict(id: string, key: string, result: TriageResult, now = Date.now()) {
    this.data.verdicts[id] = { ...result, key, at: now };
    this.save();
  }

  state(id: string): ItemState | undefined {
    return this.data.states[id];
  }

  setState(id: string, patch: Partial<ItemState>, now = Date.now()) {
    const next = { ...(this.data.states[id] ?? {}), ...patch, at: now };
    if (!next.done) delete next.done;
    if (!next.snoozedUntil) delete next.snoozedUntil;
    this.data.states[id] = next;
    this.save();
    return next;
  }

  brief(): BriefConfig {
    return this.data.brief;
  }

  setBrief(patch: Partial<BriefConfig>) {
    const next = { ...this.data.brief };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.telegram === "boolean") next.telegram = patch.telegram;
    if (patch.time !== undefined) {
      if (!isTime(patch.time)) throw new Error("time must be HH:MM");
      next.time = patch.time;
    }
    if (patch.tz !== undefined) {
      if (!isTimeZone(patch.tz)) throw new Error("unknown time zone");
      next.tz = patch.tz;
    }
    if (patch.lastRunAt !== undefined) next.lastRunAt = patch.lastRunAt;
    if (patch.lastSlot !== undefined) next.lastSlot = patch.lastSlot;
    this.data.brief = next;
    this.save();
    return next;
  }

  briefs() {
    return this.data.briefs;
  }

  addBrief(record: BriefRecord) {
    this.data.briefs = [record, ...this.data.briefs].slice(0, MAX_BRIEFS);
    this.save();
  }
}
