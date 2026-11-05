import { useCallback, useEffect, useState } from "react";
import { Check, MonitorPlay, Square, X } from "lucide-react";
import { readError, withPrefix } from "@/lib/agent/client";
import { DesktopShot } from "@/components/sable/desktop-shot";

type Pending = { id: string; tool: string; summary: string; image: string; mark?: { x: number; y: number; w: number; h: number }; at: number; source: string };
type Step = { n: number; thought?: string; action?: string; state: string; note?: string; changed?: boolean };
type Run = { id: string; goal: string; status: string; summary: string; steps: Step[]; usd: number };
type Status = {
  enabled: boolean;
  state: string;
  error: string | null;
  stoppedReason: string | null;
  viewers: number;
  idleMin: number;
  blockedRequests: number;
  viewUrl: string | null;
  pending: Pending[];
  run: Run | null;
  heavy: { active: string[]; max: number };
};

async function call(body?: Record<string, unknown>): Promise<Status> {
  const res = await fetch(withPrefix("/api/desktop"), body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(await readError(res, "Lỗi desktop."));
  return (await res.json()) as Status;
}

const RUN_LABEL: Record<string, string> = {
  running: "Đang chạy",
  done: "Xong",
  handover: "Cần bạn tiếp quản",
  rejected: "Bạn đã từ chối",
  cancelled: "Đã dừng",
  step_cap: "Hết số bước",
  budget: "Hết ngân sách",
  error: "Lỗi",
};

/** W3: Sable's own desktop (:99) — live view (noVNC), pending action cards, Stop. */
export function DesktopTab() {
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState("");
  const [takeOver, setTakeOver] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await call());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      setSt(await call(body));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi.");
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (!st) return <p className="p-3 text-sm text-muted">{error || "Đang tải…"}</p>;
  const running = st.state === "running";
  const runActive = st.run?.status === "running";
  const view = st.viewUrl ? withPrefix(takeOver ? st.viewUrl.replace("view_only=1", "view_only=0") : st.viewUrl) : null;

  return (
    <div className="space-y-3 p-1" data-desktop-panel>
      {!st.enabled && <p className="text-sm text-muted">Desktop đang tắt (SABLE_DESKTOP=0).</p>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <MonitorPlay className="size-4 text-accent" />
        <span>
          Màn hình :99 · {running ? "đang chạy" : "đã tắt"}
          {st.stoppedReason && !running ? ` (${st.stoppedReason})` : ""}
        </span>
        <span className="text-xs text-muted">
          · agent nặng {st.heavy.active.length}/{st.heavy.max} · tự tắt sau {st.idleMin} phút rảnh
          {st.blockedRequests ? ` · chặn ${st.blockedRequests} kết nối` : ""}
        </span>
        <div className="ml-auto flex gap-2">
          {!running ? (
            <button type="button" disabled={busy || !st.enabled} onClick={() => void act({ action: "start" })} className="min-h-11 rounded-xl bg-accent px-3 text-sm text-ink disabled:opacity-40">
              Bật desktop
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void act({ action: "stop" })} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-red-500 shadow-ring" aria-label="Dừng desktop">
              <Square className="size-4" /> Dừng
            </button>
          )}
        </div>
      </div>
      {st.error && <p className="text-xs text-red-500">{st.error}</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}

      {st.pending.map((p) => (
        <div key={p.id} className="rounded-2xl bg-surface p-3 shadow-ring" role="group" aria-label="Duyệt thao tác desktop" data-desktop-pending>
          <p className="text-sm font-medium">{p.summary}</p>
          <p className="mt-1 text-xs text-muted">{p.tool} · {p.source === "agent" ? "desktop agent" : "chat"} · chờ bạn duyệt</p>
          <DesktopShot image={p.image} mark={p.mark} />
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void act({ action: "decide", id: p.id, approve: true })} className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-3 text-sm text-ink">
              <Check className="size-4" /> Đồng ý
            </button>
            <button type="button" disabled={busy} onClick={() => void act({ action: "decide", id: p.id, approve: false })} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted shadow-ring hover:text-fg">
              <X className="size-4" /> Từ chối
            </button>
          </div>
        </div>
      ))}

      {view ? (
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-muted">
            <span>Xem trực tiếp{st.viewers ? ` · ${st.viewers} người xem` : ""}</span>
            <label className="ml-auto flex items-center gap-1">
              <input type="checkbox" checked={takeOver} onChange={(e) => setTakeOver(e.target.checked)} /> Tôi tự điều khiển
            </label>
          </div>
          <iframe key={view} title="Desktop :99" src={view} className="aspect-[16/10] w-full rounded-xl bg-black shadow-ring" referrerPolicy="no-referrer" />
        </div>
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (goal.trim()) void act({ action: "run", goal: goal.trim() });
        }}
      >
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={1000}
          placeholder="Mục tiêu cho desktop agent (mỗi thao tác đều cần bạn duyệt)"
          className="min-h-11 flex-1 rounded-xl bg-bg px-3 text-sm shadow-ring"
          disabled={!st.enabled || runActive}
        />
        {runActive ? (
          <button type="button" onClick={() => void act({ action: "cancel" })} className="min-h-11 rounded-xl px-3 text-sm text-red-500 shadow-ring">
            Dừng agent
          </button>
        ) : (
          <button type="submit" disabled={busy || !st.enabled || !goal.trim()} className="min-h-11 rounded-xl bg-accent px-3 text-sm text-ink disabled:opacity-40">
            Chạy
          </button>
        )}
      </form>

      {st.run && (
        <div className="rounded-xl bg-bg p-3 text-xs" data-desktop-run>
          <p className="text-sm">
            {RUN_LABEL[st.run.status] ?? st.run.status} · {st.run.steps.length} bước · ${st.run.usd.toFixed(3)}
          </p>
          <p className="mt-1 text-muted">Mục tiêu: {st.run.goal}</p>
          {st.run.summary && <p className="mt-1">{st.run.summary}</p>}
          <ol className="mt-2 space-y-1 text-muted">
            {st.run.steps.map((s) => (
              <li key={s.n}>
                {s.n}. {s.action ?? s.note ?? ""} — {s.state}
                {s.changed === false ? " (màn hình không đổi)" : ""}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
