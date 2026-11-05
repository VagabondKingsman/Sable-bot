import { MAX_INSTRUCTIONS, MAX_MEMORY } from "@/lib/agent/assemble";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bell,
  CalendarClock,
  Check,
  Clock,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { decideApproval } from "@/lib/agent/client";
import { tasksApi, type TaskSummary } from "@/lib/agent/tasks-client";
import { ScopeApprovalStrip } from "@/components/sable/scope-cards";
import { jobsApi, saigonTime, type JobsOverview, type RoutineView } from "@/lib/agent/jobs-client";
import { DEFAULT_TZ, describeSchedule, nextRun, validateSchedule } from "@/lib/agent/jobs/schedule";
import type { InboxItem, Job, JobStatus, Schedule } from "@/lib/agent/jobs/types";
import { findPreset } from "@/lib/agent/presets";
import { useAgent } from "@/lib/agent/store";
import { EFFORTS, type ChatMessage, type Effort } from "@/lib/agent/types";
import { RichText } from "@/components/sable/rich-text";
import { ApprovalCard, WorkTrail } from "@/components/sable/desk";
import { TracesTab } from "@/components/sable/traces-panel";
import { MediaTab } from "@/components/sable/media-panel";
import { CanvasTab } from "@/components/sable/canvas-panel";
import { BriefCard, TasksInbox } from "@/components/sable/proactive-panel";

export type PanelTab = "jobs" | "routines" | "inbox" | "tasks" | "traces" | "media" | "canvas";

const STATUS: Record<JobStatus, { label: string; tone: string }> = {
  queued: { label: "Đang chờ", tone: "text-muted" },
  running: { label: "Đang chạy", tone: "text-accent" },
  waiting_approval: { label: "Chờ duyệt", tone: "text-accent" },
  done: { label: "Xong", tone: "text-fg" },
  failed: { label: "Lỗi", tone: "text-red-400" },
  cancelled: { label: "Đã hủy", tone: "text-muted" },
};

const ACTIVE = new Set<JobStatus>(["queued", "running", "waiting_approval"]);
const btn =
  "inline-flex min-h-11 items-center justify-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:text-fg disabled:opacity-40";
const field =
  "rounded-xl bg-bg px-3 py-2 text-sm text-fg shadow-ring outline-none placeholder:text-muted";

function StatusBadge({ status }: { status: JobStatus }) {
  const info = STATUS[status];
  return (
    <span className={"shrink-0 text-xs font-medium " + info.tone} data-status={status}>
      {info.label}
    </span>
  );
}

/** Poll while mounted; returns latest data and a manual refresh. */
function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, everyMs: number, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const controller = new AbortController();
    const run = async () => {
      try {
        const next = await load(controller.signal);
        if (!alive) return;
        setData(next);
        setError("");
      } catch (err) {
        if (alive && !controller.signal.aborted)
          setError(err instanceof Error ? err.message : "Không tải được.");
      }
      if (alive && everyMs > 0)
        timer = window.setTimeout(run, document.hidden ? everyMs * 4 : everyMs);
    };
    void run();
    return () => {
      alive = false;
      controller.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, everyMs]);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, refresh };
}

export function BackgroundPanel({
  tab,
  focusJobId,
  models,
  onTab,
  onFocusJob,
  onClose,
}: {
  tab: PanelTab;
  focusJobId: string | null;
  models: readonly string[];
  onTab: (tab: PanelTab) => void;
  onFocusJob: (id: string | null) => void;
  onClose: () => void;
}) {
  const [planFocus, setPlanFocus] = useState<string | null>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const tabs: { id: PanelTab; label: string }[] = [
    { id: "jobs", label: "Việc nền" },
    { id: "tasks", label: "Tasks" },
    { id: "routines", label: "Lịch chạy" },
    { id: "inbox", label: "Hộp thư" },
    { id: "traces", label: "Trace" },
    { id: "media", label: "Media" },
    { id: "canvas", label: "Canvas" },
  ];
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-bg/70">
      <button
        type="button"
        aria-label="Đóng việc nền"
        className="hidden h-full flex-1 md:block"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sable-bg-title"
        className="flex h-full w-full max-w-2xl flex-col bg-surface shadow-ring"
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-5">
          <h2 id="sable-bg-title" className="font-display text-3xl">
            Chạy nền
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="grid size-11 place-items-center rounded-xl hover:bg-fg/5"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto px-4 pt-3" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => {
                onFocusJob(null);
                onTab(item.id);
              }}
              className={
                "min-h-11 rounded-xl px-3 text-sm " +
                (tab === item.id ? "bg-fg/10 text-fg" : "text-muted hover:bg-fg/5 hover:text-fg")
              }
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ScopeApprovalStrip />
          {focusJobId ? (
            <JobDetail id={focusJobId} onBack={() => onFocusJob(null)} />
          ) : tab === "jobs" ? (
            <JobsTab onOpen={onFocusJob} />
          ) : tab === "tasks" ? (
            <div className="flex flex-col gap-3">
              <BriefCard />
              <TasksInbox onOpenPlan={setPlanFocus} onOpenJob={onFocusJob} />
              <h3 className="pt-2 text-sm font-medium">Kế hoạch</h3>
              <TasksTab focusId={planFocus} onFocusChange={setPlanFocus} />
            </div>
          ) : tab === "traces" ? (
            <TracesTab />
          ) : tab === "media" ? (
            <MediaTab />
          ) : tab === "canvas" ? (
            <CanvasTab onOpened={onClose} />
          ) : tab === "routines" ? (
            <RoutinesTab models={models} onOpenJob={onFocusJob} />
          ) : (
            <InboxTab onOpenJob={onFocusJob} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- jobs ----------

function JobsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error } = usePoll<JobsOverview>((signal) => jobsApi.overview(signal), 1_500, []);
  if (!data) return <p className="text-sm text-muted">{error || "Đang tải…"}</p>;
  return (
    <div className="flex flex-col gap-3">
      {!data.enabled && (
        <p className="rounded-xl bg-bg px-3 py-2 text-sm text-accent">
          Việc nền đang tắt trên máy chủ (SABLE_JOBS=0).
        </p>
      )}
      <p className="text-sm leading-relaxed text-muted">
        Gõ việc ở ô nhắn rồi bấm <Clock className="inline size-4" /> để chạy nền. Việc vẫn chạy khi
        bạn đóng tab. Ghi tệp luôn dừng lại chờ bạn duyệt (hết hạn sau{" "}
        {data.config.approvalTtlHours} giờ thì coi như từ chối). Tối đa {data.config.concurrency}{" "}
        việc cùng lúc, {data.config.maxSteps} bước, {data.config.timeoutMin} phút mỗi việc.
      </p>
      {error && <p className="text-sm text-muted">{error}</p>}
      {data.jobs.length === 0 && <p className="text-sm text-muted">Chưa có việc nền nào.</p>}
      <ul className="flex flex-col gap-2" aria-label="Danh sách việc nền">
        {data.jobs.map((job) => (
          <li key={job.id}>
            <button
              type="button"
              onClick={() => onOpen(job.id)}
              className="flex w-full flex-col gap-1 rounded-2xl bg-bg px-4 py-3 text-left shadow-ring hover:shadow-ring-strong"
              data-job-id={job.id}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{job.title}</span>
                <StatusBadge status={job.status} />
              </span>
              <span className="text-xs text-muted">
                {job.kind === "routine"
                  ? job.catchUp
                    ? "Lịch chạy · bù lượt lỡ"
                    : "Lịch chạy"
                  : "Từ chat"}{" "}
                · {job.model} · {saigonTime(job.createdAt)}
                {job.stepCount ? ` · ${job.stepCount} bước` : ""}
              </span>
              {(job.error || job.snippet || job.statusText) && (
                <span className="line-clamp-2 text-sm text-muted">
                  {job.error || job.snippet || job.statusText}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function asMessage(job: Job): ChatMessage {
  return {
    id: job.id,
    role: "assistant",
    content: job.text,
    status: ACTIVE.has(job.status) ? job.statusText || STATUS[job.status].label : undefined,
    steps: job.steps,
    citations: job.citations,
    startedAt: job.startedAt,
    finishedAt: ACTIVE.has(job.status) ? undefined : (job.finishedAt ?? job.updatedAt),
  };
}

function JobDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [live, setLive] = useState(true);
  const {
    data: job,
    error,
    refresh,
  } = usePoll<Job>((signal) => jobsApi.job(id, signal), live ? 1_500 : 0, [id]);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (job) setLive(ACTIVE.has(job.status));
  }, [job]);
  if (!job) return <p className="text-sm text-muted">{error || "Đang tải…"}</p>;
  const active = ACTIVE.has(job.status);
  const prompt =
    [...job.request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  async function act(run: () => Promise<unknown>) {
    setNote("");
    try {
      await run();
      setLive(true);
      refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Không làm được.");
    }
  }
  return (
    <article className="flex flex-col gap-3" data-job-detail={job.id}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Quay lại"
          className="grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/5 hover:text-fg"
        >
          <ArrowLeft className="size-5" />
        </button>
        <h3 className="min-w-0 flex-1 truncate font-medium">{job.title}</h3>
        <StatusBadge status={job.status} />
      </div>
      <p className="text-xs text-muted">
        {job.request.model} · tạo {saigonTime(job.createdAt)}
        {job.startedAt ? ` · bắt đầu ${saigonTime(job.startedAt)}` : ""}
        {job.finishedAt ? ` · xong ${saigonTime(job.finishedAt)}` : ""}
        {job.attempts > 1 ? ` · lần chạy ${job.attempts}` : ""}
      </p>
      <details className="rounded-xl bg-bg px-3 py-2 text-sm">
        <summary className="min-h-11 cursor-pointer content-center text-muted">
          Việc được giao
        </summary>
        <p className="pb-2 whitespace-pre-wrap">{prompt}</p>
      </details>
      {job.notices.map((notice, index) => (
        <p key={index} className="text-sm text-muted">
          {notice}
        </p>
      ))}
      <WorkTrail message={asMessage(job)} />
      {job.approvals.map((approval) => (
        <div key={approval.id}>
          <ApprovalCard
            approval={approval}
            onDecide={(approve) => void act(() => decideApproval(approval.id, approve))}
          />
          {approval.state === "pending" && approval.expiresAt && (
            <p className="-mt-2 mb-2 text-xs text-muted">
              Hết hạn duyệt lúc {saigonTime(approval.expiresAt)}
            </p>
          )}
        </div>
      ))}
      {job.text ? (
        <RichText text={job.text} />
      ) : active ? (
        <p className="text-muted">{job.statusText || STATUS[job.status].label}</p>
      ) : null}
      {job.error && <p className="text-sm text-red-400">{job.error}</p>}
      {job.stopped === "max_steps" && (
        <p className="text-sm text-muted">Dừng vì chạm giới hạn {job.maxSteps} bước.</p>
      )}
      {note && <p className="text-sm text-muted">{note}</p>}
      <div className="flex gap-2">
        {active ? (
          <button
            type="button"
            className={btn}
            onClick={() => void act(() => jobsApi.cancel(job.id))}
          >
            <Square className="size-4" /> Hủy việc
          </button>
        ) : (
          <button
            type="button"
            className={btn + " text-muted"}
            onClick={() =>
              void jobsApi
                .remove(job.id)
                .then(onBack)
                .catch((err: unknown) =>
                  setNote(err instanceof Error ? err.message : "Không xóa được."),
                )
            }
          >
            <Trash2 className="size-4" /> Xóa
          </button>
        )}
      </div>
    </article>
  );
}

// ---------- routines ----------

type Mode = "hourly" | "daily" | "interval" | "cron";

type Draft = {
  name: string;
  prompt: string;
  mode: Mode;
  minute: number;
  time: string;
  every: number;
  expr: string;
  tz: string;
  model: string;
  effort: Effort;
  presetId: string;
  useMemory: boolean;
  web: boolean;
  x: boolean;
  code: boolean;
  files: boolean;
  fetch: boolean;
  shell: boolean;
  browser: boolean;
  catchUp: boolean;
  enabled: boolean;
};

function scheduleOf(draft: Draft): Schedule {
  if (draft.mode === "interval") return { kind: "interval", minutes: draft.every };
  if (draft.mode === "hourly") return { kind: "cron", expr: `${draft.minute} * * * *` };
  if (draft.mode === "daily") {
    const [h, m] = draft.time.split(":").map((part) => Number(part));
    return {
      kind: "cron",
      expr: `${Number.isFinite(m) ? m : 0} ${Number.isFinite(h) ? h : 7} * * *`,
    };
  }
  return { kind: "cron", expr: draft.expr.trim() };
}

function draftFrom(
  routine: RoutineView | null,
  defaults: { model: string; effort: Effort; presetId: string },
): Draft {
  const base: Draft = {
    name: "",
    prompt: "",
    mode: "daily",
    minute: 0,
    time: "07:00",
    every: 60,
    expr: "0 7 * * 1-5",
    tz: DEFAULT_TZ,
    model: defaults.model,
    effort: defaults.effort,
    presetId: defaults.presetId,
    useMemory: true,
    web: true,
    x: false,
    code: false,
    files: true,
    fetch: true,
    shell: false,
    browser: false,
    catchUp: true,
    enabled: true,
  };
  if (!routine) return base;
  const draft: Draft = {
    ...base,
    name: routine.name,
    prompt: routine.prompt,
    tz: routine.tz,
    model: routine.model,
    effort: routine.effort,
    presetId: "",
    useMemory: Boolean(routine.memory),
    web: routine.tools.web,
    x: routine.tools.x,
    code: routine.tools.code,
    files: routine.tools.files !== false,
    fetch: routine.tools.fetch !== false,
    shell: routine.tools.shell === true,
    browser: routine.tools.browser === true,
    catchUp: routine.catchUp,
    enabled: routine.enabled,
  };
  const schedule = routine.schedule;
  if (schedule.kind === "interval") return { ...draft, mode: "interval", every: schedule.minutes };
  const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(schedule.expr);
  if (hourly) return { ...draft, mode: "hourly", minute: Number(hourly[1]) };
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule.expr);
  if (daily)
    return {
      ...draft,
      mode: "daily",
      time: `${daily[2].padStart(2, "0")}:${daily[1].padStart(2, "0")}`,
    };
  return { ...draft, mode: "cron", expr: schedule.expr };
}

function RoutinesTab({
  models,
  onOpenJob,
}: {
  models: readonly string[];
  onOpenJob: (id: string) => void;
}) {
  const { data, error, refresh } = usePoll((signal) => jobsApi.routines(signal), 5_000, []);
  const [editing, setEditing] = useState<RoutineView | "new" | null>(null);
  const [note, setNote] = useState("");
  async function act(run: () => Promise<unknown>, done?: (value: unknown) => void) {
    setNote("");
    try {
      const value = await run();
      done?.(value);
      refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Không làm được.");
    }
  }
  if (editing) {
    return (
      <RoutineForm
        routine={editing === "new" ? null : editing}
        models={models}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
    );
  }
  if (!data) return <p className="text-sm text-muted">{error || "Đang tải…"}</p>;
  return (
    <div className="flex flex-col gap-3">
      {!data.enabled && (
        <p className="rounded-xl bg-bg px-3 py-2 text-sm text-accent">
          Lịch chạy đang tắt trên máy chủ (SABLE_ROUTINES=0 hoặc SABLE_JOBS=0). Không lượt nào được
          chạy.
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Giờ theo Asia/Saigon (GMT+7). Mỗi lượt tạo một việc nền; kết quả vào Hộp thư.
        </p>
        <button
          type="button"
          className={btn + " shrink-0 bg-accent text-ink shadow-none"}
          onClick={() => setEditing("new")}
        >
          <Plus className="size-4" /> Lịch mới
        </button>
      </div>
      {note && <p className="text-sm text-accent">{note}</p>}
      {data.routines.length === 0 && <p className="text-sm text-muted">Chưa có lịch chạy nào.</p>}
      <ul className="flex flex-col gap-3" aria-label="Danh sách lịch chạy">
        {data.routines.map((routine) => (
          <li
            key={routine.id}
            className="rounded-2xl bg-bg p-4 shadow-ring"
            data-routine-id={routine.id}
          >
            <div className="flex items-center gap-2">
              <CalendarClock className="size-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate font-medium">{routine.name}</span>
              <span className={"text-xs " + (routine.enabled ? "text-accent" : "text-muted")}>
                {routine.enabled ? "Đang bật" : "Tạm dừng"}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">
              {routine.scheduleLabel} · {routine.model}
              {routine.presetName ? ` · ${routine.presetName}` : ""}
            </p>
            <p className="mt-1 text-sm">
              Lượt tới: {routine.enabled ? saigonTime(routine.nextRunAt) : "—"}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={btn}
                onClick={() =>
                  void act(
                    () => jobsApi.runRoutine(routine.id),
                    (made) => onOpenJob((made as { id: string }).id),
                  )
                }
              >
                <Play className="size-4" /> Chạy ngay
              </button>
              <button
                type="button"
                className={btn}
                onClick={() => void act(() => jobsApi.toggleRoutine(routine.id, !routine.enabled))}
              >
                {routine.enabled ? <Pause className="size-4" /> : <RotateCcw className="size-4" />}
                {routine.enabled ? "Tạm dừng" : "Bật lại"}
              </button>
              <button type="button" className={btn} onClick={() => setEditing(routine)}>
                Sửa
              </button>
              <button
                type="button"
                className={btn + " text-muted"}
                onClick={() => {
                  if (window.confirm(`Xóa lịch “${routine.name}”?`))
                    void act(() => jobsApi.deleteRoutine(routine.id));
                }}
              >
                <Trash2 className="size-4" /> Xóa
              </button>
            </div>
            <TriggerPanel routine={routine} enabled={data.triggersEnabled !== false} onChanged={refresh} />
            {routine.history.length > 0 && (
              <details className="mt-2 text-sm">
                <summary className="min-h-11 cursor-pointer content-center text-muted">
                  Lịch sử ({routine.history.length})
                </summary>
                <ol className="flex flex-col gap-1">
                  {routine.history.map((run) => (
                    <li
                      key={run.id}
                      className="flex flex-wrap items-center gap-x-2 text-xs text-muted"
                    >
                      <span>{saigonTime(run.at)}</span>
                      <span className="text-fg">{RUN_LABEL[run.outcome]}</span>
                      {run.note && <span>{run.note}</span>}
                      {run.jobId && (
                        <button
                          type="button"
                          className="min-h-8 underline hover:text-fg"
                          onClick={() => onOpenJob(run.jobId!)}
                        >
                          xem
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const RUN_LABEL = {
  queued: "Đã chạy",
  manual: "Chạy tay",
  missed: "Lỡ",
  busy: "Bỏ qua (đang chạy)",
  error: "Lỗi",
  webhook: "Webhook",
  watch: "Trang thay đổi",
  builtin: "Tích hợp",
} as const;

function TriggerPanel({ routine, enabled, onChanged }: { routine: RoutineView; enabled: boolean; onChanged: () => void }) {
  const t = routine.trigger;
  const [secret, setSecret] = useState("");
  const [url, setUrl] = useState(t?.watch?.url ?? "");
  const [every, setEvery] = useState(String(t?.watch?.everyMin ?? 30));
  const [msg, setMsg] = useState("");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  async function run(fn: () => Promise<unknown>) {
    setMsg("");
    try {
      await fn();
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Không làm được.");
    }
  }
  return (
    <details className="mt-2 text-sm" data-trigger-panel>
      <summary className="min-h-11 cursor-pointer content-center text-muted">
        Trigger sự kiện{t?.webhook ? " · webhook" : ""}{t?.watch ? " · theo dõi URL" : ""}
      </summary>
      {!enabled && <p className="text-xs text-accent">Trigger đang tắt trên máy chủ (SABLE_TRIGGERS=0).</p>}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span>Webhook: {t?.webhook ? `bật${t.webhook.lastFiredAt ? ` · lần cuối ${saigonTime(t.webhook.lastFiredAt)}` : ""}` : "tắt"}</span>
          <button type="button" className={btn} disabled={!enabled} onClick={() => void run(async () => setSecret((await jobsApi.setWebhook(routine.id, true)).secret ?? ""))}>
            {t?.webhook ? "Đổi secret" : "Bật webhook"}
          </button>
          {t?.webhook && (
            <button type="button" className={btn + " text-muted"} disabled={!enabled} onClick={() => void run(async () => { await jobsApi.setWebhook(routine.id, false); setSecret(""); })}>
              Tắt webhook
            </button>
          )}
        </div>
        {secret && (
          <div className="rounded-xl bg-surface p-2 text-xs">
            <p className="text-accent">Secret chỉ hiện một lần — lưu lại ngay.</p>
            <code className="block break-all" data-webhook-secret>{secret}</code>
            <p className="mt-1 text-muted">Gọi (vẫn qua basic auth của ngrok):</p>
            <code className="block break-all">{`curl -u sable:$SABLE_PASSWORD -H "ngrok-skip-browser-warning: 1" -H "X-Sable-Secret: ${secret}" -X POST --data 'nội dung sự kiện' ${origin}/api/routines/${routine.id}/fire`}</code>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="URL theo dõi" className="min-h-11 min-w-0 flex-1 rounded-xl bg-surface px-3" placeholder="https://… (trang hoặc RSS)" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input aria-label="Mỗi (phút)" className="min-h-11 w-20 rounded-xl bg-surface px-3" type="number" min={5} value={every} onChange={(e) => setEvery(e.target.value)} />
          <button type="button" className={btn} disabled={!enabled} onClick={() => void run(() => jobsApi.setWatch(routine.id, { url: url.trim(), everyMin: Number(every) }))}>
            Lưu theo dõi
          </button>
          {t?.watch && (
            <button type="button" className={btn + " text-muted"} disabled={!enabled} onClick={() => void run(() => jobsApi.setWatch(routine.id, null))}>
              Bỏ theo dõi
            </button>
          )}
        </div>
        {t?.watch && (
          <p className="text-xs text-muted" data-watch-status>
            Mỗi {t.watch.everyMin} phút · kiểm tra tới {saigonTime(t.watch.nextCheckAt)}
            {t.watch.lastCheckAt ? ` · lần cuối ${saigonTime(t.watch.lastCheckAt)}` : " · chưa kiểm tra"}
            {t.watch.lastHash ? "" : " · lần đầu chỉ lấy mốc"}
            {t.watch.lastChangeAt ? ` · đổi lúc ${saigonTime(t.watch.lastChangeAt)}` : ""}
            {t.watch.failures ? ` · lỗi ${t.watch.failures} lần (${t.watch.lastError ?? ""}), đang giãn nhịp` : ""}
          </p>
        )}
        <p className="text-xs text-muted">Nội dung sự kiện là dữ liệu không tin cậy. Nếu không có gì mới, lượt chạy trả NO_CHANGE và không báo vào Hộp thư.</p>
        {msg && <p className="text-xs text-accent">{msg}</p>}
      </div>
    </details>
  );
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={on}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

function RoutineForm({
  routine,
  models,
  onCancel,
  onSaved,
}: {
  routine: RoutineView | null;
  models: readonly string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const settings = useAgent((state) => state.settings);
  const presets = useAgent((state) => state.presets);
  const activePresetId = useAgent((state) => state.activePresetId);
  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(routine, {
      model: settings.model,
      effort: settings.effort,
      presetId: activePresetId ?? presets[0]?.id ?? "",
    }),
  );
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));
  const schedule = scheduleOf(draft);
  const preview = useMemo(() => {
    const now = Date.now();
    const problem = validateSchedule(schedule, draft.tz, now);
    if (problem) return { problem, runs: [] as number[] };
    const runs: number[] = [];
    let after = now;
    for (let index = 0; index < 3; index += 1) {
      const next = nextRun(schedule, draft.tz, after, now);
      if (next === null) break;
      runs.push(next);
      after = next;
    }
    return { problem: "", runs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(schedule), draft.tz]);

  async function save() {
    setNote("");
    // same checks the server makes, so a bad form never becomes a failed request
    if (!draft.name.trim()) return setNote("Đặt tên cho lịch chạy.");
    if (!draft.prompt.trim()) return setNote("Viết việc cần làm.");
    if (preview.problem) {
      setNote(preview.problem);
      return;
    }
    const preset = draft.presetId ? findPreset({ presets }, draft.presetId) : null;
    const keepOld = !draft.presetId && routine;
    setSaving(true);
    try {
      await jobsApi.saveRoutine(
        {
          name: draft.name,
          prompt: draft.prompt,
          schedule,
          tz: draft.tz,
          model: draft.model,
          effort: draft.effort,
          presetName: keepOld ? routine.presetName : preset?.name,
          // same caps chat applies; the server rejects (not clips) anything longer
          instructions: (keepOld ? routine.instructions : (preset?.body ?? settings.instructions)).slice(
            0,
            MAX_INSTRUCTIONS,
          ),
          memory: (draft.useMemory
            ? keepOld && routine.memory
              ? routine.memory
              : settings.memory
            : ""
          ).slice(0, MAX_MEMORY),
          tools: {
            web: draft.web,
            x: draft.x,
            code: draft.code,
            image: false,
            files: draft.files,
            fetch: draft.fetch,
            shell: draft.shell,
            browser: draft.browser,
          },
          catchUp: draft.catchUp,
          enabled: draft.enabled,
        },
        routine?.id,
      );
      onSaved();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Không lưu được.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={routine ? "Sửa lịch chạy" : "Lịch chạy mới"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Quay lại"
          className="grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/5 hover:text-fg"
        >
          <ArrowLeft className="size-5" />
        </button>
        <h3 className="font-medium">{routine ? "Sửa lịch chạy" : "Lịch chạy mới"}</h3>
      </div>
      <Field label="Tên">
        <input
          value={draft.name}
          maxLength={80}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder="Tin sáng"
          className={field + " min-h-11"}
        />
      </Field>
      <Field label="Việc cần làm (prompt)">
        <textarea
          value={draft.prompt}
          rows={4}
          maxLength={8000}
          onChange={(event) => patch({ prompt: event.target.value })}
          placeholder="Tóm tắt 5 tin AI mới nhất, có nguồn."
          className={field + " leading-relaxed"}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Lặp lại">
          <select
            value={draft.mode}
            onChange={(event) => patch({ mode: event.target.value as Mode })}
            className={field + " h-11"}
          >
            <option value="daily">Mỗi ngày</option>
            <option value="hourly">Mỗi giờ</option>
            <option value="interval">Mỗi N phút</option>
            <option value="cron">Cron (5 trường)</option>
          </select>
        </Field>
        {draft.mode === "daily" && (
          <Field label="Lúc (GMT+7)">
            <input
              type="time"
              value={draft.time}
              onChange={(event) => patch({ time: event.target.value })}
              className={field + " h-11"}
            />
          </Field>
        )}
        {draft.mode === "hourly" && (
          <Field label="Phút thứ">
            <input
              type="number"
              min={0}
              max={59}
              value={draft.minute}
              onChange={(event) =>
                patch({ minute: Math.min(59, Math.max(0, Number(event.target.value) || 0)) })
              }
              className={field + " h-11"}
            />
          </Field>
        )}
        {draft.mode === "interval" && (
          <Field label="Mỗi (phút, tối thiểu 5)">
            <input
              type="number"
              min={5}
              step={5}
              value={draft.every}
              onChange={(event) => patch({ every: Number(event.target.value) || 0 })}
              className={field + " h-11"}
            />
          </Field>
        )}
        {draft.mode === "cron" && (
          <Field label="Biểu thức cron">
            <input
              value={draft.expr}
              onChange={(event) => patch({ expr: event.target.value })}
              placeholder="0 7 * * 1-5"
              className={field + " h-11 font-mono"}
            />
          </Field>
        )}
      </div>
      <div className="rounded-xl bg-bg px-3 py-2 text-sm" aria-live="polite">
        {preview.problem ? (
          <span className="text-accent">{preview.problem}</span>
        ) : (
          <>
            <span className="text-muted">{describeSchedule(schedule)} · các lượt tới: </span>
            {preview.runs.map((run) => saigonTime(run)).join(", ")}
          </>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Mô hình">
          <select
            value={draft.model}
            onChange={(event) => patch({ model: event.target.value })}
            className={field + " h-11"}
          >
            {[...new Set([...models, draft.model])].map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Suy luận">
          <select
            value={draft.effort}
            onChange={(event) => patch({ effort: event.target.value as Effort })}
            className={field + " h-11"}
          >
            {EFFORTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Preset">
          <select
            value={draft.presetId}
            onChange={(event) => patch({ presetId: event.target.value })}
            className={field + " h-11"}
          >
            {routine && (
              <option value="">
                Giữ như cũ{routine.presetName ? ` (${routine.presetName})` : ""}
              </option>
            )}
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset className="flex flex-wrap gap-x-4">
        <legend className="text-sm text-muted">Công cụ</legend>
        <Toggle label="Web" on={draft.web} onChange={(web) => patch({ web })} />
        <Toggle label="X" on={draft.x} onChange={(x) => patch({ x })} />
        <Toggle label="Mã" on={draft.code} onChange={(code) => patch({ code })} />
        <Toggle label="Tệp" on={draft.files} onChange={(files) => patch({ files })} />
        <Toggle label="Tải trang" on={draft.fetch} onChange={(fetch) => patch({ fetch })} />
        <Toggle label="Shell (luôn duyệt)" on={draft.shell} onChange={(shell) => patch({ shell })} />
        <Toggle label="Browser (click cần duyệt)" on={draft.browser} onChange={(browser) => patch({ browser })} />
      </fieldset>
      <div className="flex flex-wrap gap-x-4">
        <Toggle
          label="Dùng Ghi nhớ"
          on={draft.useMemory}
          onChange={(useMemory) => patch({ useMemory })}
        />
        <Toggle
          label="Bù một lượt nếu lỡ (máy tắt/ngủ)"
          on={draft.catchUp}
          onChange={(catchUp) => patch({ catchUp })}
        />
        <Toggle label="Bật" on={draft.enabled} onChange={(enabled) => patch({ enabled })} />
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Ghi tệp trong lịch chạy không bao giờ tự duyệt: việc sẽ dừng ở “Chờ duyệt” và hiện trong Hộp
        thư.
      </p>
      {note && <p className="text-sm text-accent">{note}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={btn + " bg-accent text-ink shadow-none"}>
          <Check className="size-4" /> Lưu
        </button>
        <button type="button" onClick={onCancel} className={btn + " text-muted"}>
          Hủy
        </button>
      </div>
    </form>
  );
}

// ---------- inbox ----------

function InboxTab({ onOpenJob }: { onOpenJob: (id: string) => void }) {
  const { data, error, refresh } = usePoll((signal) => jobsApi.inbox(signal), 3_000, []);
  if (!data) return <p className="text-sm text-muted">{error || "Đang tải…"}</p>;
  async function open(item: InboxItem) {
    if (!item.read) await jobsApi.markRead([item.id]).catch(() => undefined);
    // The morning brief belongs to no job: it opens in the Tasks view instead.
    if (item.jobId) onOpenJob(item.jobId);
    else refresh();
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {data.unread ? `${data.unread} chưa đọc` : "Đã đọc hết"}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className={btn}
            disabled={!data.unread}
            onClick={() => void jobsApi.markRead("all").then(refresh)}
          >
            <Check className="size-4" /> Đọc hết
          </button>
          <button
            type="button"
            className={btn + " text-muted"}
            disabled={!data.items.length}
            onClick={() => {
              if (window.confirm("Xóa mọi mục trong Hộp thư? (Việc nền vẫn giữ.)"))
                void jobsApi.removeInbox("all").then(refresh);
            }}
          >
            <Trash2 className="size-4" /> Dọn
          </button>
        </div>
      </div>
      {data.items.length === 0 && (
        <p className="text-sm text-muted">
          Hộp thư trống. Kết quả việc nền và lịch chạy sẽ hiện ở đây.
        </p>
      )}
      <ul className="flex flex-col gap-2" aria-label="Hộp thư">
        {data.items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => void open(item)}
              data-inbox-id={item.id}
              data-unread={item.read ? undefined : "1"}
              className={
                "flex w-full flex-col gap-1 rounded-2xl bg-bg px-4 py-3 text-left shadow-ring hover:shadow-ring-strong " +
                (item.read ? "opacity-70" : "")
              }
            >
              <span className="flex items-center gap-2">
                {!item.read && (
                  <span aria-label="chưa đọc" className="size-2 shrink-0 rounded-full bg-accent" />
                )}
                <span
                  className={"min-w-0 flex-1 truncate text-sm " + (item.read ? "" : "font-medium")}
                >
                  {item.title}
                </span>
                <StatusBadge status={item.kind === "approval" ? "waiting_approval" : item.status} />
              </span>
              <span className="text-xs text-muted">{saigonTime(item.createdAt)}</span>
              {item.snippet && (
                <span className="line-clamp-2 text-sm text-muted">{item.snippet}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sidebar entry with badges (unread inbox, jobs waiting for approval). */

function TasksTab({ focusId, onFocusChange }: { focusId?: string | null; onFocusChange?: (id: string | null) => void } = {}) {
  const { data, error, refresh } = usePoll<{ enabled: boolean; items: TaskSummary[] }>((signal) => tasksApi.list(signal), 2_000, []);
  const [focus, setFocusState] = useState<string | null>(focusId ?? null);
  useEffect(() => {
    if (focusId !== undefined) setFocusState(focusId);
  }, [focusId]);
  const setFocus = (id: string | null) => {
    setFocusState(id);
    onFocusChange?.(id);
  };
  const [detail, setDetail] = useState<{
    plan?: {
      id: string;
      goal: string;
      status: string;
      steps: { id: string; title: string; status: string; kind: string }[];
      currentStepId?: string;
      usedTokens: number;
      usedUsd: number;
    };
    workspace?: { root: string };
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!focus) {
      setDetail(null);
      return;
    }
    let dead = false;
    void tasksApi.get(focus).then((d) => {
      if (!dead) setDetail(d);
    });
    return () => {
      dead = true;
    };
  }, [focus, data]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await tasksApi.act(body);
      refresh();
      if (focus) setDetail(await tasksApi.get(focus));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="p-3 text-sm text-muted">{error}</p>;
  if (!data) return <p className="p-3 text-sm text-muted">Đang tải…</p>;
  if (focus && detail?.plan) {
    const plan = detail.plan;
    return (
      <div className="space-y-3 p-3">
        <button type="button" className="text-sm text-accent" onClick={() => setFocus(null)} disabled={busy}>
          ← Danh sách
        </button>
        <h3 className="text-sm font-medium">{plan.goal}</h3>
        <p className="text-xs text-muted">
          {plan.status} · tokens {plan.usedTokens} · ${plan.usedUsd.toFixed(4)}
          {detail.workspace?.root ? ` · ${detail.workspace.root}` : ""}
        </p>
        <ol className="space-y-1 text-sm">
          {plan.steps.map((s) => (
            <li key={s.id} className={s.id === plan.currentStepId ? "text-accent" : "text-muted"}>
              <span className="font-mono text-xs">{s.status}</span> · {s.title}{" "}
              <span className="text-xs">({s.kind})</span>
              {s.status === "waiting_approval" && (
                <span className="ml-2 inline-flex gap-1">
                  <button type="button" disabled={busy} className="rounded bg-accent px-2 py-1 text-xs text-ink" onClick={() => void act({ action: "approve_step", id: plan.id, stepId: s.id, approve: true })}>
                    Duyệt
                  </button>
                  <button type="button" disabled={busy} className="rounded px-2 py-1 text-xs shadow-ring" onClick={() => void act({ action: "approve_step", id: plan.id, stepId: s.id, approve: false })}>
                    Từ chối
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className="rounded-xl px-3 py-2 text-sm shadow-ring" onClick={() => void act({ action: "pause", id: plan.id })}>
            Tạm dừng
          </button>
          <button type="button" disabled={busy} className="rounded-xl px-3 py-2 text-sm shadow-ring" onClick={() => void act({ action: "resume", id: plan.id })}>
            Tiếp tục
          </button>
          <button type="button" disabled={busy} className="rounded-xl px-3 py-2 text-sm shadow-ring" onClick={() => void act({ action: "cancel", id: plan.id })}>
            Hủy
          </button>
          <button type="button" disabled={busy} className="rounded-xl px-3 py-2 text-sm text-muted shadow-ring" onClick={() => void act({ action: "delete", id: plan.id }).then(() => setFocus(null))}>
            Xóa + wipe workspace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted">
        {data.enabled ? "Planner bật" : "SABLE_PLANNER=0"} · {data.items.length} task
      </p>
      {data.items.length === 0 && <p className="text-sm text-muted">Chưa có task graph. Tạo qua POST /api/tasks.</p>}
      {data.items.map((item) => (
        <button key={item.id} type="button" onClick={() => setFocus(item.id)} className="block w-full rounded-2xl bg-surface p-3 text-left shadow-ring hover:bg-fg/5">
          <div className="text-sm font-medium">{item.goal.slice(0, 80)}</div>
          <div className="mt-1 text-xs text-muted">
            {item.status} · {item.stepCount} bước · {item.currentStepId ?? "—"} · tok {item.usedTokens}
          </div>
        </button>
      ))}
    </div>
  );
}

export function BackgroundNavButton({
  unread,
  waiting,
  active,
  onClick,
}: {
  unread: number;
  waiting: number;
  active: number;
  onClick: () => void;
}) {
  // Approval asks are inbox items too, so the unread count already covers them.
  const badge = unread;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted hover:bg-fg/5 hover:text-fg"
    >
      <Bell className="size-4" />
      <span className="flex-1 text-left">Chạy nền &amp; Hộp thư</span>
      {waiting > 0 ? (
        <span className="text-xs text-accent">{waiting} chờ duyệt</span>
      ) : active > 0 ? (
        <span className="text-xs text-accent">{active} đang chạy</span>
      ) : null}
      {badge > 0 && (
        <span
          aria-label={`${badge} mục mới`}
          data-testid="bg-badge"
          className="grid min-w-6 place-items-center rounded-full bg-accent px-1.5 text-xs font-medium text-ink"
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
