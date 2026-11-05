import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { tracesApi, type TraceList } from "@/lib/agent/w2-client";
import { saigonTime } from "@/lib/agent/jobs-client";
import type { Trace, TraceEvent } from "@/lib/agent/trace/types";

function fmtMs(ms: number | undefined) {
  if (ms == null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

const TYPE_LABEL: Record<TraceEvent["type"], string> = {
  tool: "tool",
  search: "search",
  think: "think",
  subagent: "sub-agent",
  approval: "duyệt",
  plan_step: "bước",
  notice: "ghi chú",
  model: "model",
};

/** W2 trace timeline: list of runs (chat / job / plan) → one timeline with latency bars. */
export function TracesTab() {
  const [source, setSource] = useState("");
  const [tool, setTool] = useState("");
  const [q, setQ] = useState("");
  const [list, setList] = useState<TraceList | null>(null);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const run = async () => {
      try {
        setList(await tracesApi.list({ source, tool, q }, controller.signal));
        setError("");
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Không tải được trace.");
      }
      timer = window.setTimeout(run, document.hidden ? 20_000 : 5_000);
    };
    void run();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [source, tool, q]);

  useEffect(() => {
    if (!focus) {
      setTrace(null);
      return;
    }
    const controller = new AbortController();
    tracesApi
      .get(focus, tool || undefined, controller.signal)
      .then((d) => setTrace(d.trace))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Không tải được trace.");
      });
    return () => controller.abort();
  }, [focus, tool, list?.total]);

  if (error && !list) return <p className="p-3 text-sm text-muted">{error}</p>;
  if (!list) return <p className="p-3 text-sm text-muted">Đang tải…</p>;
  if (!list.enabled) return <p className="p-3 text-sm text-muted">{list.message ?? "Trace đang tắt."}</p>;

  const filters = (
    <div className="flex flex-wrap gap-2">
      <select aria-label="Nguồn" value={source} onChange={(e) => setSource(e.target.value)} className="min-h-11 rounded-xl bg-surface px-2 text-sm shadow-ring">
        <option value="">Mọi nguồn</option>
        <option value="chat">Chat</option>
        <option value="job">Việc nền</option>
        <option value="plan">Tasks</option>
      </select>
      <select aria-label="Lọc theo tool" value={tool} onChange={(e) => setTool(e.target.value)} className="min-h-11 rounded-xl bg-surface px-2 text-sm shadow-ring">
        <option value="">Mọi tool</option>
        {list.tools.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name} ({t.count})
          </option>
        ))}
      </select>
      <input aria-label="Tìm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm…" className="min-h-11 flex-1 rounded-xl bg-surface px-3 text-sm shadow-ring" />
    </div>
  );

  if (focus && trace) {
    const t0 = trace.startedAt ?? trace.events.find((e) => e.at)?.at ?? 0;
    const span = Math.max(1, trace.durationMs ?? Math.max(...trace.events.map((e) => (e.at ?? t0) + (e.ms ?? 0) - t0), 1));
    const ids = new Set(trace.events.map((e) => e.id));
    return (
      <div className="space-y-3 p-3">
        <button type="button" className="text-sm text-accent" onClick={() => setFocus(null)}>
          ← Danh sách
        </button>
        {filters}
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">{trace.title}</h3>
            <p className="text-xs text-muted">
              {trace.source} · {trace.status} · {trace.model ? `${trace.model} · ` : ""}
              {saigonTime(trace.startedAt)} · {fmtMs(trace.durationMs) || "—"}
            </p>
            <p className="text-xs text-muted">
              {trace.stats.toolCalls} tool · {trace.stats.subAgents} sub-agent · {trace.stats.approvals} duyệt · {trace.stats.errors} lỗi · tool {fmtMs(trace.stats.toolMs)}
            </p>
          </div>
          <a href={tracesApi.exportUrl(trace.id)} download className="inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:bg-fg/5">
            <Download className="size-4" /> JSON
          </a>
        </div>
        <ol className="space-y-1" data-testid="trace-timeline">
          {trace.events.map((e) => {
            const left = e.at ? Math.min(100, ((e.at - t0) / span) * 100) : 0;
            const width = e.ms ? Math.max(1, Math.min(100 - left, (e.ms / span) * 100)) : 0;
            const nested = e.parent && ids.has(e.parent);
            return (
              <li key={e.id} className={"rounded-xl p-2 shadow-ring " + (nested ? "ml-6" : "")}>
                <div className="flex items-center gap-2 text-sm">
                  <span className={"rounded px-1.5 font-mono text-[11px] " + (e.ok === false ? "bg-red-500/15 text-red-400" : "bg-fg/10 text-muted")}>{TYPE_LABEL[e.type]}</span>
                  <span className="flex-1 truncate" title={e.label}>
                    {e.label}
                  </span>
                  <span className="text-xs text-muted">{e.state}</span>
                  <span className="w-16 text-right font-mono text-xs text-muted">{fmtMs(e.ms)}</span>
                </div>
                {width > 0 && (
                  <div className="mt-1 h-1.5 rounded bg-fg/5">
                    <div className="h-1.5 rounded bg-accent/70" style={{ marginLeft: `${left}%`, width: `${width}%` }} />
                  </div>
                )}
                {e.detail && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted">chi tiết</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted">{e.detail}</pre>
                  </details>
                )}
              </li>
            );
          })}
          {trace.events.length === 0 && <li className="text-sm text-muted">Không có sự kiện khớp bộ lọc.</li>}
        </ol>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-3">
      {filters}
      <p className="text-xs text-muted">
        {list.total} lượt chạy · giữ {list.retainDays ?? 14} ngày
      </p>
      {list.items.length === 0 && <p className="text-sm text-muted">Chưa có trace.</p>}
      {list.items.map((item) => (
        <button key={item.id} type="button" onClick={() => setFocus(item.id)} className="block w-full rounded-2xl bg-surface p-3 text-left shadow-ring hover:bg-fg/5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="rounded bg-fg/10 px-1.5 font-mono text-[11px] text-muted">{item.source}</span>
            <span className="truncate">{item.title}</span>
          </div>
          <div className="mt-1 text-xs text-muted">
            {item.status} · {item.stats.toolCalls} tool · {item.stats.approvals} duyệt · {item.stats.errors} lỗi · {fmtMs(item.durationMs) || "—"} · {saigonTime(item.startedAt)}
          </div>
        </button>
      ))}
    </div>
  );
}
