import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { recallApi, type RecallHit, type VectorStatus } from "@/lib/agent/evals-client";

const SOURCES: { id: string; label: string }[] = [
  { id: "memory", label: "Bộ nhớ" },
  { id: "journal", label: "Nhật ký" },
  { id: "thread", label: "Hội thoại" },
  { id: "canvas", label: "Canvas" },
  { id: "research", label: "Research" },
  { id: "workspace", label: "Tài liệu" },
];
const MODES = [
  { id: "hybrid", label: "Kết hợp" },
  { id: "bm25", label: "BM25" },
  { id: "vector", label: "Vector" },
];
const btn = "inline-flex min-h-11 items-center justify-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:text-fg disabled:opacity-40";
const field = "rounded-xl bg-bg px-3 py-2 text-sm text-fg shadow-ring outline-none placeholder:text-muted";
const time = (ms: number) => new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Saigon", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
const pct = (n: number) => `${Math.round(n * 100)}`;

/** W5: search everything Sable has indexed (hybrid BM25 + vector + recency) and manage the local index. */
export function MemorySearchTab() {
  const [st, setSt] = useState<VectorStatus | null>(null);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [sources, setSources] = useState<string[]>([]);
  const [hits, setHits] = useState<RecallHit[] | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(() => {
    recallApi.status().then(setSt, (e: Error) => setError(e.message));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  async function search(event?: React.FormEvent) {
    event?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await recallApi.search(q.trim(), { sources, mode, k: 12 });
      setHits(r.hits);
      setMs(r.ms ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sync(rebuild: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await recallApi.sync(rebuild);
      setSt(r.status);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (id: string) => setSources((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div className="space-y-4" data-testid="memory-search">
      <section className="space-y-2 rounded-2xl p-4 shadow-ring">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Chỉ mục cục bộ</h3>
          <div className="flex gap-2">
            <button type="button" className={btn} disabled={busy || !st?.enabled} onClick={() => sync(false)}>
              <RefreshCw className="size-4" /> Đồng bộ
            </button>
            <button type="button" className={btn} disabled={busy || !st?.enabled} onClick={() => sync(true)}>
              Dựng lại
            </button>
          </div>
        </div>
        {!st ? (
          <p className="text-sm text-muted">Đang tải…</p>
        ) : !st.enabled ? (
          <p className="text-sm text-muted">Đã tắt (SABLE_VECTOR=0). Tìm kiếm chỉ dùng BM25 trên bộ nhớ.</p>
        ) : (
          <div className="space-y-1 text-sm text-muted" data-testid="vector-status">
            <p>
              Embedder: <span className="text-fg">{st.embedder ?? "—"}</span> ({st.embedderKind ?? "—"})
              {st.embedderKind === "hash" ? " — dự phòng xác định, khớp từ vựng, không phải ngữ nghĩa" : ""}
            </p>
            {st.stats ? (
              <p>
                {st.stats.docs} tài liệu · {st.stats.chunks}/{st.maxChunks} đoạn · {Math.round(st.stats.bytes / 1024)} KB ·{" "}
                {Object.entries(st.stats.bySource).map(([k, v]) => `${k} ${v}`).join(", ")}
              </p>
            ) : null}
            <p>
              Lần đồng bộ cuối: {st.lastAt ? time(st.lastAt) : "chưa"} (giờ VN){st.syncing ? " · đang đồng bộ…" : ""}
              {st.last ? ` · +${st.last.added} ~${st.last.updated} −${st.last.removed}, ${st.last.redactions} đã ẩn, ${st.last.ms} ms` : ""}
            </p>
            {st.lastError ? <p className="text-red-400">{st.lastError}</p> : null}
            <details>
              <summary className="cursor-pointer">Nhà cung cấp đã thử</summary>
              <ul className="mt-1 space-y-0.5">
                {st.tried.map((t) => (
                  <li key={t.provider}>
                    {t.ok ? "✓" : "✗"} {t.provider}: {t.why}
                  </li>
                ))}
              </ul>
            </details>
            <p className="text-xs">Kho bí mật (vault) không bao giờ được lập chỉ mục; mọi nội dung được che bí mật trước khi nhúng.</p>
          </div>
        )}
      </section>

      <form onSubmit={search} className="space-y-2">
        <div className="flex gap-2">
          <input className={field + " flex-1"} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm trong bộ nhớ, hội thoại, Canvas, research…" aria-label="Truy vấn" />
          <button type="submit" className={btn} disabled={busy || !q.trim()}>
            <Search className="size-4" /> Tìm
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {SOURCES.map((s) => (
            <button key={s.id} type="button" aria-pressed={sources.includes(s.id)} onClick={() => toggle(s.id)} className={"min-h-9 rounded-xl px-3 text-xs shadow-ring " + (sources.includes(s.id) ? "bg-fg/10 text-fg" : "text-muted")}>
              {s.label}
            </button>
          ))}
          <span className="mx-1" />
          {MODES.map((m) => (
            <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)} className={"min-h-9 rounded-xl px-3 text-xs shadow-ring " + (mode === m.id ? "bg-fg/10 text-fg" : "text-muted")}>
              {m.label}
            </button>
          ))}
        </div>
      </form>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {hits ? (
        <section className="space-y-2" data-testid="recall-hits">
          <p className="text-xs text-muted">
            {hits.length} kết quả{ms != null ? ` · ${ms} ms` : ""}
          </p>
          {hits.map((h) => (
            <article key={h.id} className="space-y-1 rounded-2xl p-3 shadow-ring">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{h.title || h.ref}</span>
                <span className="text-xs text-muted">
                  {h.source} · {time(h.at)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted">{h.text.slice(0, 400)}</p>
              <p className="text-xs text-muted">
                điểm {pct(h.score)} · BM25 {pct(h.parts.bm25)} · vector {pct(h.parts.vector)} · mới {pct(h.parts.recency)}
              </p>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
