/** W2a proactive UI: morning-brief settings card (+ Tasks inbox, reply chips). */
import { bridgeApi } from "@/lib/agent/bridge-client";
import { useCallback, useEffect, useState } from "react";
import { Bell, Play } from "lucide-react";
import { proactiveApi, type BriefView, type TasksInboxView } from "@/lib/agent/proactive-client";
import { evalsApi } from "@/lib/agent/evals-client";
import { TASK_STATES, type TaskState, type UnifiedTask } from "@/lib/agent/proactive/unify";
import type { Chip } from "@/lib/agent/proactive/chips";
import { decideApproval } from "@/lib/agent/client";
import { tasksApi } from "@/lib/agent/tasks-client";
import { saigonTime } from "@/lib/agent/jobs-client";

const btn =
  "inline-flex min-h-11 items-center justify-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:text-fg disabled:opacity-40";
const field = "rounded-xl bg-bg px-3 py-2 text-sm text-fg shadow-ring outline-none placeholder:text-muted";

export function BriefCard() {
  const [view, setView] = useState<BriefView | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => proactiveApi.brief().then(setView).catch((e) => setNote(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);
  if (!view) return <p className="text-sm text-muted">{note || "Đang tải bản tin…"}</p>;
  if (!view.enabled) return <p className="text-sm text-muted">Bản tin sáng đang tắt trên máy chủ (SABLE_BRIEF=0).</p>;
  const cfg = view.config;
  async function patch(p: Parameters<typeof proactiveApi.briefConfig>[0]) {
    setNote("");
    try {
      await proactiveApi.briefConfig(p);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }
  async function runNow() {
    setBusy(true);
    setNote("");
    try {
      const out = await proactiveApi.briefRun();
      setNote(`Đã gửi: ${out.brief.delivered.join(" + ")}`);
      setOpen(out.brief.id);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-bg p-4 shadow-ring" aria-label="Bản tin sáng" data-brief-enabled={cfg.enabled ? "1" : "0"}>
      <div className="flex flex-wrap items-center gap-2">
        <Bell className="size-4 text-accent" />
        <h3 className="flex-1 text-sm font-medium">Bản tin sáng</h3>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} className="size-4 accent-[var(--color-accent)]" />
          Bật
        </label>
        <input type="time" aria-label="Giờ gửi" className={field} value={cfg.time} onChange={(e) => void patch({ time: e.target.value })} />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.telegram} onChange={(e) => void patch({ telegram: e.target.checked })} className="size-4 accent-[var(--color-accent)]" />
          Telegram
        </label>
        <button type="button" className={btn} disabled={busy} onClick={() => void runNow()}>
          <Play className="size-4" /> Gửi ngay
        </button>
      </div>
      <p className="text-xs text-muted">
        {cfg.enabled ? `Mỗi ngày lúc ${cfg.time} (${cfg.tz}).` : "Đang tắt."} Gửi vào Hộp thư{cfg.telegram ? " và Telegram của bạn (nếu đã cấu hình)" : ""}.
        {cfg.lastRunAt ? ` Lần cuối: ${saigonTime(cfg.lastRunAt)}.` : ""}
      </p>
      {note && <p className="text-sm text-accent">{note}</p>}
      {view.history.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Bản tin gần đây">
          {view.history.slice(0, 5).map((b) => (
            <li key={b.id}>
              <button type="button" className="w-full truncate text-left text-sm text-muted hover:text-fg" onClick={() => setOpen(open === b.id ? null : b.id)}>
                {saigonTime(b.at)} · {b.title}
              </button>
              {open === b.id && (
                <div className="mt-1 flex flex-col gap-2">
                  <pre className="whitespace-pre-wrap rounded-xl bg-surface p-3 text-xs" data-brief-text>{b.text}</pre>
                  {(b.items ?? []).map((t) => (
                    <div key={t.id} className="flex flex-col gap-1 rounded-xl bg-surface p-2" data-brief-item={t.id}>
                      <span className="truncate text-xs">{t.title}</span>
                      <ChipRow task={t} busy={busy} act={async (fn) => { setBusy(true); try { await fn(); setNote("Xong."); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }} />
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- unified Tasks inbox ----------

const STATE_LABEL: Record<TaskState, string> = { waiting_approval: "Chờ duyệt", todo: "Cần làm", doing: "Đang làm", done: "Xong" };
const BUCKET_LABEL: Record<string, string> = { needs_reply: "Cần trả lời", needs_approval: "Cần duyệt", fyi: "Để biết", ignore: "Bỏ qua" };

export function TasksInbox({ onOpenPlan, onOpenJob }: { onOpenPlan: (id: string) => void; onOpenJob: (id: string) => void }) {
  const [view, setView] = useState<TasksInboxView | null>(null);
  const [filter, setFilter] = useState<TaskState | "open">("open");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setView(await proactiveApi.tasksInbox(signal));
      setError("");
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), 4_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);
  if (!view) return <p className="text-sm text-muted">{error || "Đang tải Tasks…"}</p>;
  const shown = view.tasks.filter((t) => (filter === "open" ? t.state !== "done" : t.state === filter));
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-2" aria-label="Tasks inbox">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Lọc trạng thái">
        {(["open", ...TASK_STATES] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={filter === s}
            data-filter={s}
            onClick={() => setFilter(s)}
            className={"min-h-9 rounded-xl px-3 text-xs " + (filter === s ? "bg-fg/10 text-fg" : "text-muted hover:bg-fg/5")}
          >
            {s === "open" ? "Đang mở" : STATE_LABEL[s]}
            {s !== "open" ? ` (${view.counts[s]})` : ""}
          </button>
        ))}
      </div>
      {!view.triage && <p className="text-xs text-muted">Triage đang tắt (SABLE_TRIAGE=0): chỉ hiện kế hoạch và việc nền.</p>}
      {error && <p className="text-sm text-accent">{error}</p>}
      {shown.length === 0 && <p className="text-sm text-muted">Không có mục nào.{view.ignored ? ` (${view.ignored} mục đã bỏ qua.)` : ""}</p>}
      <ul className="flex flex-col gap-2">
        {shown.map((t) => (
          <li key={t.id} data-task-id={t.id} data-state={t.state} data-kind={t.kind} className="flex flex-col gap-1 rounded-2xl bg-bg px-4 py-3 shadow-ring">
            <div className="flex items-center gap-2">
              {t.urgency === "high" && <span aria-label="gấp" className="size-2 shrink-0 rounded-full bg-red-400" />}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
              {t.bucket && <span className="shrink-0 text-xs text-muted">{BUCKET_LABEL[t.bucket]}</span>}
              <span className="shrink-0 text-xs text-accent">{STATE_LABEL[t.state]}</span>
            </div>
            <span className="text-xs text-muted">
              {saigonTime(t.at)}
              {t.reason ? ` · ${t.reason}` : ""}
              {t.decidedBy ? ` · ${t.decidedBy}` : ""}
              {t.initiator_kind ? <span data-initiator-kind={t.initiator_kind}>{` · bởi ${t.initiator_kind}`}</span> : null}
            </span>
            {t.detail && <span className="line-clamp-2 text-sm text-muted">{t.detail}</span>}
            <ChipRow task={t} busy={busy} act={act} onOpenPlan={onOpenPlan} onOpenJob={onOpenJob} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const chip = "inline-flex min-h-9 items-center gap-1 rounded-xl px-2 text-xs shadow-ring hover:text-fg disabled:opacity-40";

/**
 * Chips never send. Approve / reject ask for a confirm and use the normal
 * human approval path; a draft opens in a local text box with Copy only.
 */
export function ChipRow({
  task,
  busy,
  act,
  onOpenPlan,
  onOpenJob,
}: {
  task: UnifiedTask;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onOpenPlan?: (id: string) => void;
  onOpenJob?: (id: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const chips = task.chips ?? [];
  if (!chips.length) return null;
  async function decide(approve: boolean) {
    if (!window.confirm(approve ? `Duyệt: ${task.title}?` : `Từ chối: ${task.title}?`)) return;
    await act(async () => {
      if (task.ref.stepId && task.ref.planId) await tasksApi.act({ action: "approve_step", id: task.ref.planId, stepId: task.ref.stepId, approve });
      else if (task.ref.approvalId) await decideApproval(task.ref.approvalId, approve);
    });
  }
  function run(c: Chip) {
    switch (c.action) {
      case "approve":
        return void decide(true);
      case "reject":
        return void decide(false);
      case "snooze":
        return void act(() => proactiveApi.itemState(task.ref.triageId!, "snooze", c.ms));
      case "done":
        return void act(() => proactiveApi.itemState(task.ref.triageId!, "done"));
      case "draft_reply":
        return setDraft(draft === null ? (c.draft ?? "") : null);
      case "open_task":
        return task.ref.planId && onOpenPlan?.(task.ref.planId);
      case "open_job":
        return task.ref.jobId && onOpenJob?.(task.ref.jobId);
      case "review_resolve":
      case "review_dismiss":
        return void act(() => evalsApi.review(task.ref.reviewId!, c.action === "review_resolve" ? "resolved" : "dismissed"));
      case "bridge_resolve":
      case "bridge_dismiss":
        return void act(() => bridgeApi.inbound(task.ref.bridgeId!, c.action === "bridge_resolve" ? "resolved" : "dismissed"));
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1" aria-label="Gợi ý thao tác">
        {chips.map((c) => (
          <button key={c.id} type="button" data-chip={c.action} data-sends="false" className={chip} disabled={busy && c.confirm} onClick={() => run(c)}>
            {c.label}
          </button>
        ))}
      </div>
      {draft !== null && (
        <div className="flex flex-col gap-1" data-draft>
          <textarea aria-label="Bản nháp trả lời" className={field + " min-h-28"} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-1">
            <button
              type="button"
              className={chip}
              onClick={() =>
                void navigator.clipboard?.writeText(draft).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? "Đã chép" : "Chép"}
            </button>
            <span className="text-xs text-muted">Chỉ là bản nháp — Sable không tự gửi.</span>
          </div>
        </div>
      )}
    </div>
  );
}
