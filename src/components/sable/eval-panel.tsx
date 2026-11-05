import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import { evalsApi, type EvalsView } from "@/lib/agent/evals-client";
import type { ReviewState } from "@/lib/agent/evals/store";

const SUITES = ["w0", "w1", "w2", "w2a", "w2b", "w2c", "w3", "w4", "w5"];
const btn = "inline-flex min-h-11 items-center justify-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:text-fg disabled:opacity-40";
const field = "rounded-xl bg-bg px-3 py-2 text-sm text-fg shadow-ring outline-none";
const time = (ms: number) => new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Saigon", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
const pct = (n: number) => `${Math.round(n * 100)}%`;
const STATE: Record<string, string> = { open: "Mở", resolved: "Đã xem", dismissed: "Đã bỏ qua", accepted: "Đã chấp nhận" };

/** W5: self-eval dashboard — run grades, review queue, nightly regression settings + diffs, proposals (never auto-applied). */
export function EvalTab() {
  const [v, setV] = useState<EvalsView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [runSuites, setRunSuites] = useState<string[]>(["w0"]);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    evalsApi.view().then(setV, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!v?.running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [v?.running, load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!v) return <p className="text-sm text-muted">{error || "Đang tải…"}</p>;
  const reviews = showAll ? v.reviews : v.reviews.filter((r) => r.state === "open");
  const s = v.settings;
  const toggleNightlySuite = (id: string) => act(() => evalsApi.settings({ suites: s.suites.includes(id) ? s.suites.filter((x) => x !== id) : [...s.suites, id] }));

  return (
    <div className="space-y-4" data-testid="eval-dashboard">
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Lượt chấm", String(v.summary.runs)],
          ["Không đạt", String(v.summary.failed)],
          ["Hoàn thành TB", pct(v.summary.avgSuccess)],
          ["Có căn cứ TB", pct(v.summary.avgGrounded)],
        ].map(([k, val]) => (
          <div key={k} className="rounded-2xl p-3 shadow-ring">
            <p className="text-xs text-muted">{k}</p>
            <p className="font-display text-2xl">{val}</p>
          </div>
        ))}
      </section>
      <p className="text-xs text-muted">
        Bộ chấm: <span className="text-fg">{v.grader}</span>
        {v.enabled ? "" : " · đã tắt (SABLE_SELFEVAL=0)"} · Tự đánh giá chỉ tạo đề xuất; không bao giờ tự sửa code hay prompt.
      </p>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Hàng chờ xem lại</h3>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Hiện cả mục đã xử lý
          </label>
        </div>
        {reviews.length === 0 ? <p className="text-sm text-muted">Không có mục nào.</p> : null}
        {reviews.map((r) => (
          <article key={r.id} className="space-y-1 rounded-2xl p-3 shadow-ring" data-testid="review-item">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{r.title}</span>
              <span className="text-xs text-muted">
                {r.type === "failed_run" ? "Lượt chạy không đạt" : "Đề xuất hồi quy"} · {time(r.at)} · {STATE[r.state]}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-muted">{r.detail}</p>
            {r.proposal ? <p className="whitespace-pre-wrap rounded-xl bg-bg p-2 text-sm">Đề xuất: {r.proposal}</p> : null}
            {r.state === "open" ? (
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["resolved", "Đã xem"],
                    ...(r.proposal ? ([["accepted", "Chấp nhận đề xuất"]] as const) : []),
                    ["dismissed", "Bỏ qua"],
                  ] as [ReviewState, string][]
                ).map(([st, label]) => (
                  <button key={st} type="button" className={btn} disabled={busy} onClick={() => act(() => evalsApi.review(r.id, st))}>
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            {r.state === "accepted" ? <p className="text-xs text-muted">Đã ghi nhận — việc sửa vẫn do bạn tự làm/duyệt.</p> : null}
          </article>
        ))}
      </section>

      <section className="space-y-2 rounded-2xl p-4 shadow-ring">
        <h3 className="font-medium">Eval hồi quy</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.nightly} disabled={busy || !v.enabled} onChange={(e) => act(() => evalsApi.settings({ nightly: e.target.checked }))} aria-label="Bật eval hằng đêm" />
          Chạy hằng đêm lúc
          <input type="time" className={field} value={s.time} disabled={busy || !v.enabled} onChange={(e) => act(() => evalsApi.settings({ time: e.target.value }))} aria-label="Giờ chạy" />
          (giờ VN)
        </label>
        <div className="flex flex-wrap gap-1">
          {SUITES.map((id) => (
            <button key={id} type="button" aria-pressed={s.suites.includes(id)} disabled={busy || !v.enabled} onClick={() => toggleNightlySuite(id)} className={"min-h-9 rounded-xl px-3 text-xs shadow-ring " + (s.suites.includes(id) ? "bg-fg/10 text-fg" : "text-muted")}>
              {id}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-fg/10 pt-2">
          <span className="text-sm text-muted">Chạy ngay:</span>
          {SUITES.map((id) => (
            <label key={id} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={runSuites.includes(id)} onChange={() => setRunSuites((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))} />
              {id}
            </label>
          ))}
          <button type="button" className={btn} disabled={busy || !!v.running || !runSuites.length || !v.enabled} onClick={() => act(() => evalsApi.run(runSuites))}>
            <Play className="size-4" /> Chạy
          </button>
          <button type="button" className={btn} onClick={load} aria-label="Tải lại">
            <RefreshCw className="size-4" />
          </button>
        </div>
        {v.running ? <p className="text-sm text-muted">Đang chạy {v.running.suite}…</p> : null}
        {v.regress.map((r) => (
          <details key={r.id} className="rounded-xl bg-bg p-2 text-sm" data-testid="regress-run">
            <summary className="cursor-pointer">
              {time(r.at)} · {r.manual ? "thủ công" : "hằng đêm"} · {r.ok ? "OK" : "CÓ LỖI"} · {r.suites.map((x) => `${x.suite} ${x.pass}✓ ${x.fail}✗${x.skip ? ` ${x.skip}⤼` : ""}`).join(", ")}
            </summary>
            {r.diff ? (
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                <li>Mới hỏng: {r.diff.newlyFailing.join(", ") || "—"}</li>
                <li>Đã sửa: {r.diff.fixed.join(", ") || "—"}</li>
                <li>Mới thêm: {r.diff.added.length ? `${r.diff.added.length} kiểm tra` : "—"}</li>
                <li>Bị bỏ: {r.diff.removed.join(", ") || "—"}</li>
                <li>Lỗi bộ: {r.diff.suiteErrors.join(", ") || "—"}</li>
              </ul>
            ) : null}
          </details>
        ))}
      </section>

      <section className="space-y-1">
        <h3 className="font-medium">Điểm gần đây</h3>
        {v.grades.slice(0, 30).map((g) => (
          <div key={g.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-fg/5 py-1 text-sm" data-testid="grade-row">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-xs text-muted">{g.kind}</span> {g.goal}
            </span>
            <span className={"text-xs " + (g.failed ? "text-red-400" : "text-muted")}>
              {pct(g.success)} / {pct(g.grounded)} · {g.reason} · {time(g.at)}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
