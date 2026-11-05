/**
 * File-backed store for jobs, routines and the inbox: one JSON file per job
 * plus routines.json / inbox.json, each written atomically (temp file, fsync,
 * rename). Lives outside the web root and outside the fs-tool jail. Single
 * process, single user, so an in-memory cache is the source of truth.
 */
import fs from "node:fs";
import path from "node:path";
import { isActive, type InboxItem, type Job, type Routine } from "./types.ts";

export const MAX_FINISHED_JOBS = 300;
export const MAX_INBOX = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function writeAtomic(file: string, data: string) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = fs.openSync(temp, "w", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Keep a bad file for inspection (never loaded again); start clean instead of crashing. */
function quarantine(file: string) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    console.warn(`[sable-jobs] unreadable data file set aside: ${path.basename(file)}`);
  } catch {
    /* ignore */
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    quarantine(file);
    return null;
  }
}

const STATUSES = new Set(["queued", "running", "waiting_approval", "done", "failed", "cancelled"]);
const isObj = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Valid JSON is not enough: a job missing its arrays would crash recovery and every list call. */
export function isJobShape(value: unknown): value is Job {
  if (!isObj(value)) return false;
  const request = value.request;
  return (
    typeof value.id === "string" &&
    ID_RE.test(value.id) &&
    typeof value.title === "string" &&
    STATUSES.has(value.status as string) &&
    isObj(request) &&
    typeof request.model === "string" &&
    Array.isArray(request.messages) &&
    isNum(value.createdAt) &&
    isNum(value.updatedAt) &&
    isNum(value.maxSteps) &&
    isNum(value.timeoutMs) &&
    isNum(value.usedMs) &&
    isNum(value.attempts) &&
    typeof value.text === "string" &&
    Array.isArray(value.steps) &&
    Array.isArray(value.approvals) &&
    Array.isArray(value.notices) &&
    Array.isArray(value.citations)
  );
}

export function isRoutineShape(value: unknown): value is Routine {
  if (!isObj(value)) return false;
  const schedule = value.schedule;
  return (
    typeof value.id === "string" &&
    ID_RE.test(value.id) &&
    typeof value.name === "string" &&
    typeof value.prompt === "string" &&
    isObj(schedule) &&
    (schedule.kind === "cron" ? typeof schedule.expr === "string" : isNum(schedule.minutes)) &&
    typeof value.tz === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.model === "string" &&
    isObj(value.tools) &&
    isNum(value.anchorAt) &&
    isNum(value.maxSteps) &&
    (value.nextRunAt === null || isNum(value.nextRunAt)) &&
    Array.isArray(value.history)
  );
}

export function isInboxShape(value: unknown): value is InboxItem {
  return (
    isObj(value) &&
    typeof value.id === "string" &&
    typeof value.jobId === "string" &&
    typeof value.title === "string" &&
    typeof value.read === "boolean" &&
    isNum(value.createdAt)
  );
}

/** Load a JSON list, keeping only well-formed entries; a non-list file is set aside. */
function readList<T>(file: string, valid: (value: unknown) => value is T): T[] {
  const raw = readJson<unknown>(file);
  if (raw === null) return [];
  if (!Array.isArray(raw)) {
    quarantine(file);
    return [];
  }
  const kept = raw.filter(valid);
  if (kept.length !== raw.length)
    console.warn(
      `[sable-jobs] dropped ${raw.length - kept.length} malformed entr(y/ies) from ${path.basename(file)}`,
    );
  return kept;
}

function tighten(target: string) {
  try {
    if ((fs.statSync(target).mode & 0o077) !== 0) fs.chmodSync(target, 0o700);
  } catch {
    /* ignore: reported when a write fails */
  }
}

export class JobDb {
  readonly dir: string;
  private jobs = new Map<string, Job>();
  private routinesCache: Routine[] = [];
  private inboxCache: InboxItem[] = [];

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, "jobs"), { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to new dirs: an existing, looser data dir is tightened.
    tighten(dir);
    tighten(path.join(dir, "jobs"));
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".tmp")) fs.rmSync(path.join(dir, name), { force: true });
    }
    for (const name of fs.readdirSync(path.join(dir, "jobs"))) {
      const file = path.join(dir, "jobs", name);
      if (name.endsWith(".tmp")) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const job = readJson<unknown>(file);
      if (job === null) continue;
      // The file name must match the id inside, or a delete would leave a twin behind.
      if (isJobShape(job) && name === `${job.id}.json`) this.jobs.set(job.id, job);
      else quarantine(file);
    }
    this.routinesCache = readList(path.join(dir, "routines.json"), isRoutineShape);
    this.inboxCache = readList(path.join(dir, "inbox.json"), isInboxShape);
  }

  private jobFile(id: string) {
    if (!ID_RE.test(id)) throw new Error("bad job id");
    return path.join(this.dir, "jobs", `${id}.json`);
  }

  getJob(id: string) {
    return this.jobs.get(id);
  }

  /** Newest first. */
  listJobs() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Disk first: if the write fails nothing changes in memory (no ghost job the API never acknowledged). */
  saveJob(job: Job) {
    writeAtomic(this.jobFile(job.id), JSON.stringify(job));
    this.jobs.set(job.id, job);
  }

  deleteJob(id: string) {
    this.jobs.delete(id);
    fs.rmSync(this.jobFile(id), { force: true });
  }

  /** Drop the oldest finished jobs beyond the cap. */
  prune(max = MAX_FINISHED_JOBS) {
    const finished = this.listJobs().filter((job) => !isActive(job.status));
    for (const job of finished.slice(max)) this.deleteJob(job.id);
  }

  routines() {
    return this.routinesCache;
  }

  saveRoutines(next: Routine[]) {
    writeAtomic(path.join(this.dir, "routines.json"), JSON.stringify(next));
    this.routinesCache = next;
  }

  inbox() {
    return this.inboxCache;
  }

  saveInbox(next: InboxItem[]) {
    const kept = next.slice(0, MAX_INBOX);
    writeAtomic(path.join(this.dir, "inbox.json"), JSON.stringify(kept));
    this.inboxCache = kept;
  }
}

/** Process start time from /proc (guards against pid reuse); "" when unavailable. */
function startTime(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  } catch {
    return "";
  }
}

function alive(pid: number, started: string) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  // Same pid but a different process (pid reused after a restart) is not the owner.
  return !started || !startTime(pid) || startTime(pid) === started;
}

/**
 * One writer per data dir: a second server process on the same dir would keep
 * its own cache and overwrite the first one's files. Returns the other owner's
 * pid when the dir is taken by a live process, null once this process owns it.
 */
export function claimDataDir(dir: string, pid = process.pid): number | null {
  const file = path.join(dir, "owner.pid");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, `${pid} ${startTime(pid)}`);
      fs.closeSync(fd);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const [ownerText = "", started = ""] = fs.readFileSync(file, "utf8").trim().split(" ");
    const owner = Number(ownerText);
    if (owner === pid) return null;
    if (Number.isInteger(owner) && owner > 0 && alive(owner, started)) return owner;
    fs.rmSync(file, { force: true }); // stale: the previous server is gone
  }
  return null;
}
