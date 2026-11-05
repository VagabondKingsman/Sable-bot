import { useCallback, useEffect, useState } from "react";
import { Check, Play, Square, Trash2, X } from "lucide-react";
import { readError, withPrefix } from "@/lib/agent/client";

type Step = { n: number; thought: string; action: string; detail: string; ok: boolean; output: string };
type Task = {
  id: string;
  goal: string;
  repo: string;
  baseRef: string;
  testCmd: string;
  status: string;
  loopStatus?: string;
  usd: number;
  steps: Step[];
  summary: string;
  error?: string;
  wt: { wt: string; branch: string; base: string } | null;
  test?: { cmd: string; ok: boolean; exitCode: number | null; timedOut: boolean; output: string };
  diff?: { text: string; stat: string; files: { status: string; path: string }[]; truncated: boolean };
  applied?: { head: string; into: string; at: number };
  pr: string;
  live: boolean;
};
type Summary = { id: string; goal: string; repo: string; status: string; usd: number; files: number; testOk: boolean | null; createdAt: number; live: boolean };
type Status = { enabled: boolean; model: string; sandbox: string; network: string; github: string; repoRoots: string[]; configured: boolean; caps: { runUsd: number; maxSteps: number; cmdTimeoutS: number }; heavy: { active: string[]; max: number }; tasks: Summary[] };

const LABEL: Record<string, string> = { running: "Đang chạy", review: "Chờ bạn duyệt", no_changes: "Không thay đổi", failed: "Lỗi", cancelled: "Đã hủy", applied: "Đã merge", rejected: "Đã từ chối" };
const btn = "inline-flex min-h-11 items-center justify-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:text-fg disabled:opacity-40";
const field = "rounded-xl bg-bg px-3 py-2 text-sm text-fg shadow-ring outline-none placeholder:text-muted";

async function api<T>(query = "", body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(withPrefix(`/api/code${query}`), body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(await readError(res, "Lỗi code agent."));
  return (await res.json()) as T;
}
const time = (ms: number) => new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Saigon", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

/** Unified diff with per-line colouring (text only, never HTML-injected). */
export function DiffView({ text }: { text: string }) {
  return (
    <pre className="max-h-[28rem] overflow-auto rounded-xl bg-bg p-3 text-xs leading-5 shadow-ring" data-testid="diff-view">
      {text.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+++") || l.startsWith("---") ? "text-muted" : l.startsWith("+") ? "text-emerald-400" : l.startsWith("-") ? "text-red-400" : l.startsWith("@@") ? "text-accent" : l.startsWith("diff ") ? "pt-2 font-medium text-fg" : ""}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

/** W4: code worktree agent — goal → steps → diff + test log → owner approve (merge) / reject. */
export function CodeTab() {
  const [st, setSt] = useState<Status | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [form, setForm] = useState({ repo: "", goal: "", testCmd: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await api<Status>());
      if (sel) setTask(await api<Task>(`?id=${sel}`));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được.");
    }
  }, [sel]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const r = await api<Task | { ok: boolean }>("", body);
      if (body.action === "start" && "id" in r) {
        setSel(r.id);
        setForm((f) => ({ ...f, goal: "" }));
      }
      if (body.action === "delete") {
        setSel(null);
        setTask(null);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi.");
    } finally {
      setBusy(false);
    }
  }

  if (!st) return <p className="p-3 text-sm text-muted">{error || "Đang tải…"}</p>;
  return (
    <div className="flex flex-col gap-3" data-testid="code-tab">
      <p className="text-xs text-muted">
        Agent code làm việc trên git worktree riêng (sable/&lt;id&gt;), lệnh chạy trong sandbox {st.sandbox}; mạng: {st.network}; {st.github}. Merge vào repo thật chỉ khi bạn duyệt. Trần ${st.caps.runUsd.toFixed(2)}/task · {st.caps.maxSteps} bước · agent nặng {st.heavy.active.length}/{st.heavy.max} · {st.model}
      </p>
      {!st.enabled && <p className="text-sm text-red-400">Đang tắt (SABLE_CODEAGENT=0).</p>}
      <div className="flex flex-col gap-2 rounded-xl p-3 shadow-ring">
        <input className={field} placeholder={`Repo (đường dẫn tuyệt đối, trong ${st.repoRoots.join(", ")})`} value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} />
        <textarea className={field} rows={2} maxLength={4000} placeholder="Việc cần làm…" value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
        <div className="flex gap-2">
          <input className={field + " flex-1"} placeholder="Lệnh test (vd: npm test)" value={form.testCmd} onChange={(e) => setForm({ ...form, testCmd: e.target.value })} />
          <button type="button" className={btn} disabled={busy || !st.enabled || !form.repo.trim() || !form.goal.trim()} onClick={() => void act({ action: "start", ...form })}>
            <Play className="size-4" /> Bắt đầu
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      {sel && task ? (
        <TaskDetail task={task} busy={busy} onBack={() => { setSel(null); setTask(null); }} act={act} />
      ) : (
        <ul className="flex flex-col gap-2">
          {st.tasks.length === 0 && <li className="text-sm text-muted">Chưa có task nào.</li>}
          {st.tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="w-full rounded-xl p-3 text-left shadow-ring hover:bg-fg/5" onClick={() => setSel(t.id)}>
                <div className="flex justify-between gap-2 text-sm">
                  <span className="line-clamp-2">{t.goal}</span>
                  <span className={"shrink-0 text-xs " + (t.status === "review" ? "text-accent" : "text-muted")}>{LABEL[t.status] ?? t.status}</span>
                </div>
                <div className="truncate text-xs text-muted">{time(t.createdAt)} · {t.repo} · {t.files} file · test {t.testOk === null ? "—" : t.testOk ? "pass" : "fail"} · ${t.usd.toFixed(3)}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskDetail({ task, busy, onBack, act }: { task: Task; busy: boolean; onBack: () => void; act: (b: Record<string, unknown>) => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-col gap-3" data-testid="code-task">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={onBack}>← Danh sách</button>
        {task.live && <button type="button" className={btn} disabled={busy} onClick={() => void act({ action: "cancel", id: task.id })}><Square className="size-4" /> Dừng</button>}
        {(task.status === "applied" || task.status === "rejected") && <button type="button" className={btn} disabled={busy} onClick={() => void act({ action: "delete", id: task.id })}><Trash2 className="size-4" /></button>}
      </div>
      <div className="rounded-xl p-3 shadow-ring">
        <div className="text-sm font-medium">{task.goal}</div>
        <div className="text-xs text-muted">
          {LABEL[task.status] ?? task.status}{task.loopStatus && task.loopStatus !== "done" ? ` (${task.loopStatus})` : ""} · {task.repo} · base {task.wt?.base.slice(0, 10) ?? "—"} · ${task.usd.toFixed(3)} · PR {task.pr}
        </div>
        {task.summary && <p className="mt-1 text-sm">{task.summary}</p>}
        {task.error && <p className="mt-1 text-sm text-red-400">{task.error}</p>}
        {task.applied && <p className="mt-1 text-sm text-emerald-400">Đã merge vào {task.applied.into} @ {task.applied.head.slice(0, 10)} ({time(task.applied.at)})</p>}
      </div>
      {task.status === "review" && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl p-3 shadow-ring" data-testid="code-review">
          <span className="text-sm">Merge nhánh {task.wt?.branch} vào branch hiện tại của repo?</span>
          {confirm ? (
            <>
              <button type="button" className={btn + " text-emerald-400"} disabled={busy} onClick={() => void act({ action: "apply", id: task.id })}><Check className="size-4" /> Xác nhận merge</button>
              <button type="button" className={btn} onClick={() => setConfirm(false)}>Thôi</button>
            </>
          ) : (
            <button type="button" className={btn} disabled={busy} onClick={() => setConfirm(true)}><Check className="size-4" /> Duyệt (apply)</button>
          )}
          <button type="button" className={btn + " text-red-400"} disabled={busy} onClick={() => void act({ action: "reject", id: task.id })}><X className="size-4" /> Từ chối</button>
        </div>
      )}
      {(task.status === "no_changes" || task.status === "failed" || task.status === "cancelled") && task.wt && (
        <button type="button" className={btn} disabled={busy} onClick={() => void act({ action: "reject", id: task.id })}>Dọn worktree</button>
      )}
      <details className="rounded-xl p-3 shadow-ring" open={task.live}>
        <summary className="cursor-pointer text-sm font-medium">Các bước ({task.steps.length})</summary>
        <ol className="mt-2 flex flex-col gap-2">
          {task.steps.map((s) => (
            <li key={s.n} className="text-sm">
              <div><span className={s.ok ? "text-emerald-400" : "text-red-400"}>●</span> {s.n}. <b>{s.action}</b> <span className="text-muted">{s.detail}</span></div>
              {s.thought && <div className="text-xs text-muted">{s.thought}</div>}
              {s.output && s.action === "run" && <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-bg p-2 text-xs">{s.output}</pre>}
            </li>
          ))}
        </ol>
      </details>
      {task.test && (
        <details className="rounded-xl p-3 shadow-ring" open>
          <summary className="cursor-pointer text-sm font-medium">
            Test: <code>{task.test.cmd}</code> — <span className={task.test.ok ? "text-emerald-400" : "text-red-400"}>{task.test.ok ? "pass" : `fail (exit ${task.test.exitCode ?? "?"}${task.test.timedOut ? ", timeout" : ""})`}</span>
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-bg p-2 text-xs">{task.test.output}</pre>
        </details>
      )}
      {task.diff && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Diff ({task.diff.files.length} file){task.diff.truncated ? " — đã cắt bớt" : ""}</div>
          <ul className="text-xs text-muted">{task.diff.files.map((f) => <li key={f.path}>{f.status} {f.path}</li>)}</ul>
          {task.diff.text ? <DiffView text={task.diff.text} /> : <p className="text-sm text-muted">Không có thay đổi.</p>}
        </div>
      )}
    </div>
  );
}
