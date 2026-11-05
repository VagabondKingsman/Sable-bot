import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { readError, withPrefix } from "@/lib/agent/client";
import { openCanvasBeside } from "@/components/sable/canvas-panel";

type Step = { id: string; title: string; status: string; error?: string };
type Src = { id: string; url: string; finalUrl?: string; title: string; host: string; status: string; error?: string; chars?: number; passages: number; credibility?: { score: number; notes: string[] } };
type Cite = { source: string; quote: string; valid: boolean; reason?: string };
type Claim = { text: string; verdict: "supported" | "weak" | "unsupported"; cites: Cite[]; notes: string[] };
type Stats = { claims: number; supported: number; weak: number; unsupported: number; citesValid: number; citesInvalid: number };
type Run = {
  id: string;
  question: string;
  status: string;
  steps: Step[];
  plan?: { subquestions: string[]; queries: string[] };
  sources: Src[];
  report?: { title: string; summary: string; sections: { heading: string; claims: Claim[] }[]; stats: Stats };
  canvasId?: string;
  usd: number;
  ops: number;
  error?: string;
  log: { at: number; text: string }[];
  live: boolean;
};
type Summary = { id: string; question: string; status: string; usd: number; createdAt: number; canvasId: string | null; stats: Stats | null; live: boolean };
type Status = { enabled: boolean; model: string; configured: boolean; caps: { runUsd: number; maxSteps: number; maxSources: number; maxQueries: number }; heavy: { active: string[]; max: number }; runs: Summary[] };

const LABEL: Record<string, string> = { running: "Đang chạy", paused: "Tạm dừng", done: "Xong", failed: "Lỗi", cancelled: "Đã hủy", budget: "Hết ngân sách", step_cap: "Hết số bước" };
const VERDICT: Record<string, string> = { supported: "text-emerald-400", weak: "text-amber-400", unsupported: "text-red-400" };
const btn = "inline-flex min-h-11 items-center justify-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:text-fg disabled:opacity-40";
const field = "rounded-xl bg-bg px-3 py-2 text-sm text-fg shadow-ring outline-none placeholder:text-muted";

async function api<T>(query = "", body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(withPrefix(`/api/research${query}`), body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(await readError(res, "Lỗi research."));
  return (await res.json()) as T;
}
const time = (ms: number) => new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Saigon", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

/** W4: deep research — plan, progress, sources (credibility), verified claims, Canvas report. */
export function ResearchTab({ onOpened }: { onOpened?: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await api<Status>());
      if (sel) setRun(await api<Run>(`?id=${sel}`));
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
      const r = await api<Run | { ok: boolean }>("", body);
      if (body.action === "start" && "id" in r) {
        setSel(r.id);
        setQ("");
      }
      if (body.action === "delete") {
        setSel(null);
        setRun(null);
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
    <div className="flex flex-col gap-3" data-testid="research-tab">
      <p className="text-xs text-muted">
        Nghiên cứu sâu: lập kế hoạch → tìm/đọc nguồn (qua SSRF guard) → trích dẫn từng ý (phải khớp nguyên văn đoạn đã đọc) → kiểm chứng → trang Canvas. Trần ${st.caps.runUsd.toFixed(2)}/run · {st.caps.maxSteps} bước · agent nặng {st.heavy.active.length}/{st.heavy.max} · {st.model}
      </p>
      {!st.enabled && <p className="text-sm text-red-400">Đang tắt (SABLE_RESEARCH=0).</p>}
      {!st.configured && <p className="text-sm text-amber-400">Chưa cấu hình xAI (cần web_search).</p>}
      <div className="flex gap-2">
        <textarea className={field + " min-h-11 flex-1"} rows={2} placeholder="Câu hỏi nghiên cứu…" value={q} maxLength={2000} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className={btn} disabled={busy || !q.trim() || !st.enabled} onClick={() => void act({ action: "start", question: q })}>
          <Play className="size-4" /> Bắt đầu
        </button>
      </div>
      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      {sel && run ? (
        <RunDetail run={run} busy={busy} onBack={() => { setSel(null); setRun(null); }} act={act} onOpened={onOpened} />
      ) : (
        <ul className="flex flex-col gap-2">
          {st.runs.length === 0 && <li className="text-sm text-muted">Chưa có run nào.</li>}
          {st.runs.map((r) => (
            <li key={r.id}>
              <button type="button" className="w-full rounded-xl p-3 text-left shadow-ring hover:bg-fg/5" onClick={() => setSel(r.id)}>
                <div className="flex justify-between gap-2 text-sm">
                  <span className="line-clamp-2">{r.question}</span>
                  <span className="shrink-0 text-xs text-muted">{LABEL[r.status] ?? r.status}</span>
                </div>
                <div className="text-xs text-muted">
                  {time(r.createdAt)} · ${r.usd.toFixed(3)}
                  {r.stats ? ` · ${r.stats.supported}/${r.stats.claims} ý có nguồn` : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunDetail({ run, busy, onBack, act, onOpened }: { run: Run; busy: boolean; onBack: () => void; act: (b: Record<string, unknown>) => Promise<void>; onOpened?: () => void }) {
  const resumable = !run.live && ["paused", "failed", "budget", "step_cap", "cancelled"].includes(run.status);
  const s = run.report?.stats;
  return (
    <div className="flex flex-col gap-3" data-testid="research-run">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={onBack}>← Danh sách</button>
        {run.live && <button type="button" className={btn} disabled={busy} onClick={() => void act({ action: "cancel", id: run.id })}><Square className="size-4" /> Dừng</button>}
        {resumable && <button type="button" className={btn} disabled={busy} onClick={() => void act({ action: "resume", id: run.id })}><RotateCcw className="size-4" /> Tiếp tục</button>}
        {run.canvasId && <button type="button" className={btn} onClick={() => { openCanvasBeside(run.canvasId!); onOpened?.(); }}><ExternalLink className="size-4" /> Mở báo cáo</button>}
        {!run.live && <button type="button" className={btn} disabled={busy} onClick={() => void act({ action: "delete", id: run.id })}><Trash2 className="size-4" /></button>}
      </div>
      <div className="rounded-xl p-3 shadow-ring">
        <div className="text-sm font-medium">{run.question}</div>
        <div className="text-xs text-muted">{LABEL[run.status] ?? run.status} · ${run.usd.toFixed(3)} · {run.ops} bước{run.error ? ` · ${run.error}` : ""}</div>
      </div>
      <ol className="flex flex-col gap-1 text-sm">
        {run.steps.map((st) => (
          <li key={st.id} className="flex justify-between gap-2">
            <span>{st.title}</span>
            <span className={"text-xs " + (st.status === "done" ? "text-emerald-400" : st.status === "failed" ? "text-red-400" : st.status === "running" ? "text-accent" : "text-muted")}>{st.status}{st.error ? ` — ${st.error}` : ""}</span>
          </li>
        ))}
      </ol>
      {run.plan && (
        <details className="rounded-xl p-3 shadow-ring" open={!run.report}>
          <summary className="cursor-pointer text-sm font-medium">Kế hoạch</summary>
          <ul className="mt-2 list-disc pl-5 text-sm">{run.plan.subquestions.map((x) => <li key={x}>{x}</li>)}</ul>
          <div className="mt-2 text-xs text-muted">Truy vấn: {run.plan.queries.join(" · ")}</div>
        </details>
      )}
      {run.sources.length > 0 && (
        <details className="rounded-xl p-3 shadow-ring" open>
          <summary className="cursor-pointer text-sm font-medium">Nguồn ({run.sources.filter((x) => x.status === "fetched").length}/{run.sources.length} đã đọc)</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {run.sources.map((x) => (
              <li key={x.id} className="text-sm" data-source={x.id}>
                <div className="flex justify-between gap-2">
                  <span className="truncate">[{x.id}] {x.title || x.host}</span>
                  <span className={"shrink-0 text-xs " + (x.status === "fetched" ? "text-muted" : "text-red-400")}>{x.status}{x.credibility ? ` · tin cậy ${x.credibility.score}/5` : ""}</span>
                </div>
                <div className="truncate text-xs text-muted">{x.finalUrl ?? x.url}</div>
                {x.credibility?.notes.length ? <div className="text-xs text-muted">{x.credibility.notes.join("; ")}</div> : null}
                {x.error && <div className="text-xs text-red-400">{x.error}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {run.report && s && (
        <div className="rounded-xl p-3 shadow-ring">
          <div className="text-sm font-medium">{run.report.title}</div>
          <div className="text-xs text-muted">{s.claims} ý · {s.supported} có nguồn · {s.weak} yếu · {s.unsupported} không có nguồn · trích dẫn hợp lệ {s.citesValid}/{s.citesValid + s.citesInvalid}</div>
          <p className="mt-2 text-sm">{run.report.summary}</p>
          {run.report.sections.map((sec) => (
            <div key={sec.heading} className="mt-2">
              <div className="text-sm font-medium">{sec.heading}</div>
              <ul className="flex flex-col gap-1">
                {sec.claims.map((c, i) => (
                  <li key={i} className="text-sm">
                    <span className={VERDICT[c.verdict]}>●</span> {c.text}{" "}
                    <span className="text-xs text-muted">{c.cites.filter((x) => x.valid).map((x) => `[${x.source}]`).join("")}</span>
                    {c.verdict !== "supported" && c.notes.length > 0 && <div className="text-xs text-amber-400">{c.notes.join("; ")}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {run.log.length > 0 && (
        <details className="rounded-xl p-3 shadow-ring">
          <summary className="cursor-pointer text-sm font-medium">Nhật ký</summary>
          <ul className="mt-2 text-xs text-muted">{run.log.slice(-40).map((l, i) => <li key={i}>{time(l.at)} {l.text}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
