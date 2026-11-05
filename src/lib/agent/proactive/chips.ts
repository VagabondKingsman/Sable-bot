/**
 * Reply / action chips on brief and triage items (W2a). A chip is a shortcut
 * for something the owner could do by hand in the UI: approve or reject an
 * ask that is already waiting, snooze, mark done, open the task/job, or open
 * an editable reply *draft*. No chip sends anything: there is no "send"
 * action, a draft only fills a local text box (copy button, no send button),
 * and approve/reject go through the normal human approval path with a
 * confirm. Idea from OpenDuet replies.ts (MIT, CopilotKit): "the most a tap
 * can do is what the person could have typed".
 */
import type { UnifiedTask } from "./unify.ts";

export type ChipAction = "approve" | "reject" | "snooze" | "done" | "draft_reply" | "open_task" | "open_job" | "review_resolve" | "review_dismiss" | "bridge_resolve" | "bridge_dismiss";

export type Chip = {
  id: string;
  label: string;
  action: ChipAction;
  /** Always false: enforced by type and by test. */
  sends: false;
  /** UI must ask "are you sure" before calling (approve / reject). */
  confirm: boolean;
  /** For draft_reply: editable starting text, shown locally, never sent. */
  draft?: string;
  /** Snooze length. */
  ms?: number;
};

/** The only server routes a chip may call. None of them sends a message. */
export const CHIP_ROUTES: Record<ChipAction, string | null> = {
  approve: "/api/tools (or /api/tasks approve_step) — human decision on an existing ask",
  reject: "/api/tools (or /api/tasks approve_step) — human decision on an existing ask",
  snooze: "/api/triage",
  done: "/api/triage",
  draft_reply: null,
  open_task: null,
  open_job: null,
  review_resolve: "/api/evals (review state only — never edits code)",
  review_dismiss: "/api/evals (review state only — never edits code)",
  bridge_resolve: "/api/bridge action=inbound (item state only; no outbound)",
  bridge_dismiss: "/api/bridge action=inbound (item state only; no outbound)",
};

const SEND_WORDS = /\b(send|gửi|post|reply now|forward)\b/i;

function draftFor(t: UnifiedTask) {
  const who = t.title.replace(/\s+/g, " ").slice(0, 80);
  return `Chào bạn,\n\nCảm ơn về "${who}". [Viết câu trả lời ở đây]\n\nThân,\nHe`;
}

export function chipsFor(t: UnifiedTask): Chip[] {
  const chips: Chip[] = [];
  const add = (action: ChipAction, label: string, extra: Partial<Chip> = {}) =>
    chips.push({ id: `${t.id}:${action}${extra.ms ? `:${extra.ms}` : ""}`, label, action, sends: false, confirm: action === "approve" || action === "reject", ...extra });
  if (t.state === "waiting_approval" && (t.ref.approvalId || t.ref.stepId)) {
    add("approve", "Duyệt");
    add("reject", "Từ chối");
  }
  if (t.bucket === "needs_reply" && t.state !== "done") add("draft_reply", "Soạn nháp", { draft: draftFor(t) });
  if (t.ref.triageId && t.state !== "done" && t.state !== "waiting_approval") {
    add("snooze", "Hoãn 1 giờ", { ms: 3_600_000 });
    add("snooze", "Mai", { ms: 86_400_000 });
    add("done", "Xong");
  }
  if (t.ref.reviewId) {
    add("review_resolve", "Đã xem");
    add("review_dismiss", "Bỏ qua");
  }
  if (t.ref.bridgeId) {
    add("bridge_resolve", "Đã xem");
    add("bridge_dismiss", "Bỏ qua");
  }
  if (t.ref.planId) add("open_task", "Mở task");
  else if (t.ref.jobId) add("open_job", "Mở việc");
  return chips;
}

/** Invariant check used by tests and the server before returning chips. */
export function assertNoSend(chips: Chip[]) {
  for (const c of chips) {
    if (c.sends !== false) throw new Error(`chip ${c.id} claims to send`);
    if (!(c.action in CHIP_ROUTES)) throw new Error(`chip ${c.id} has unknown action`);
    if (SEND_WORDS.test(c.label)) throw new Error(`chip ${c.id} label reads like a send`);
  }
  return chips;
}
