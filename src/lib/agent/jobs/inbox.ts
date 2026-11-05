/** In-app delivery: finished job / routine results and approval asks. */
import type { JobDb } from "./db.ts";
import { isActive, type InboxItem, type Job, type JobApproval } from "./types.ts";

function newId() {
  return `ibx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function snippetOf(job: Job) {
  if (job.status === "failed") return (job.error || "Việc nền lỗi.").slice(0, 240);
  const text = job.text.replace(/\s+/g, " ").trim();
  return (
    text ||
    (job.stopped ? "Dừng ở giới hạn bước, chưa có câu trả lời." : "Xong, không có câu trả lời chữ.")
  ).slice(0, 240);
}

/**
 * Settle a finished job in the inbox: its approval asks are no longer actionable
 * (marked read, so the badge stays accurate), and done/failed jobs get a result
 * entry. User-cancelled jobs get none. Idempotent per job.
 */
export function deliverResult(db: JobDb, job: Job, now = Date.now()) {
  // An ask left open by the job ending is not "waiting" any more: show the job's end state.
  const settled = db
    .inbox()
    .map((entry) =>
      entry.jobId === job.id &&
      entry.kind === "approval" &&
      (!entry.read || isActive(entry.status))
        ? { ...entry, read: true, status: job.status }
        : entry,
    );
  if (job.status !== "done" && job.status !== "failed") {
    if (settled.some((entry, index) => entry !== db.inbox()[index])) db.saveInbox(settled);
    return null;
  }
  if (settled.some((entry) => entry.jobId === job.id && entry.kind === "result")) {
    db.saveInbox(settled);
    return null;
  }
  const item: InboxItem = {
    id: newId(),
    kind: "result",
    jobId: job.id,
    routineId: job.routineId,
    title: job.title,
    status: job.status,
    snippet: snippetOf(job),
    createdAt: now,
    read: false,
  };
  db.saveInbox([item, ...settled]);
  return item;
}

export function deliverApproval(db: JobDb, job: Job, approval: JobApproval, now = Date.now()) {
  const item: InboxItem = {
    id: newId(),
    kind: "approval",
    jobId: job.id,
    routineId: job.routineId,
    title: job.title,
    approvalId: approval.id,
    status: "waiting_approval",
    snippet: `Cần duyệt: ${approval.summary}`.slice(0, 240),
    createdAt: now,
    read: false,
  };
  db.saveInbox([item, ...db.inbox()]);
  return item;
}

const SETTLED: Record<Exclude<JobApproval["state"], "pending">, string> = {
  approved: "Đã duyệt",
  rejected: "Đã từ chối",
  expired: "Hết hạn duyệt",
};

/** A decided ask: its inbox item stops saying "Chờ duyệt" and stops counting as new. */
export function settleApproval(db: JobDb, job: Job, approval: JobApproval) {
  const state = approval.state;
  if (state === "pending") return;
  let changed = false;
  const next = db.inbox().map((entry) => {
    if (entry.kind !== "approval" || entry.approvalId !== approval.id || entry.jobId !== job.id) return entry;
    changed = true;
    return {
      ...entry,
      read: true,
      status: job.status,
      snippet: `${SETTLED[state]}: ${approval.summary}`.slice(0, 240),
    };
  });
  if (changed) db.saveInbox(next);
}

export function markRead(db: JobDb, ids: string[] | "all") {
  const set = ids === "all" ? null : new Set(ids);
  let changed = 0;
  const next = db.inbox().map((item) => {
    if (item.read || (set && !set.has(item.id))) return item;
    changed += 1;
    return { ...item, read: true };
  });
  if (changed) db.saveInbox(next);
  return changed;
}

export function removeItems(db: JobDb, ids: string[] | "all") {
  const set = ids === "all" ? null : new Set(ids);
  const next = set ? db.inbox().filter((item) => !set.has(item.id)) : [];
  db.saveInbox(next);
}

export function unreadCount(db: JobDb) {
  return db.inbox().filter((item) => !item.read).length;
}
