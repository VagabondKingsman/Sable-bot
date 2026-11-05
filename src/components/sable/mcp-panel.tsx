import { useEffect, useState } from "react";
import { withPrefix } from "@/lib/agent/client";

type Status = {
  name: string;
  source: "env" | "file";
  url: string;
  enabled: boolean;
  state: "off" | "ok" | "error" | "idle";
  transport?: string;
  error?: string;
  tools: { name: string; mcpName: string; readOnly: boolean }[];
  headers: { header: string; env: string; set: boolean }[];
  allowTools: string[];
  timeoutS: number;
};
type View = { enabled: boolean; errors: string[]; servers: Status[] };
type Draft = { name: string; url: string; transport: string; headers: string; allowTools: string; timeoutS: string; editing: boolean };
const EMPTY: Draft = { name: "", url: "https://", transport: "auto", headers: "", allowTools: "", timeoutS: "30", editing: false };
const STATE: Record<Status["state"], string> = { off: "Tắt", ok: "Đã kết nối", error: "Lỗi", idle: "Chưa kết nối" };

/** Settings section: MCP servers (env ones read-only; file ones editable; header values only via env var names). */
export function McpPanel() {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch(withPrefix("/api/mcp"), { cache: "no-store" });
      setView((await res.json()) as View);
    } catch {
      setNote("Không tải được danh sách MCP.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function act(body: unknown, done?: string) {
    setBusy(true);
    try {
      const res = await fetch(withPrefix("/api/mcp"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as View & { message?: string };
      if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
      setView(data);
      if (done) setNote(done);
      return true;
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    const headers: Record<string, string> = {};
    for (const line of draft.headers.split(/[\n,]/).map((l) => l.trim()).filter(Boolean)) {
      const [h, env] = line.split(/[:=]/).map((x) => x.trim());
      if (h && env) headers[h] = env;
    }
    const ok = await act(
      {
        action: "save",
        server: { name: draft.name.trim(), url: draft.url.trim(), transport: draft.transport, headers, allowTools: draft.allowTools.split(",").map((t) => t.trim()).filter(Boolean), timeoutS: Number(draft.timeoutS) || 30 },
      },
      `Đã lưu máy chủ ${draft.name.trim()}.`,
    );
    if (ok) setDraft(null);
  }

  const field = "w-full rounded-lg bg-surface px-2 py-1.5 text-sm shadow-ring";
  const btn = "rounded px-2 py-0.5 text-xs shadow-ring disabled:opacity-50";
  return (
    <section aria-label="Máy chủ MCP" className="grid gap-2 rounded-xl bg-bg p-3 text-sm shadow-ring">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Máy chủ MCP</span>
        {view?.enabled ? (
          <div className="flex gap-1">
            <button type="button" className={btn} disabled={busy} onClick={() => void act({ action: "refresh" }, "Đã làm mới.")}>
              Làm mới
            </button>
            <button type="button" className={btn} onClick={() => setDraft({ ...EMPTY })}>
              Thêm máy chủ
            </button>
          </div>
        ) : (
          view && <span className="text-xs text-muted">Đang tắt (SABLE_MCP=0)</span>
        )}
      </div>
      <p className="text-xs text-muted">
        Công cụ MCP tên mcp__máy-chủ__công-cụ. Công cụ có thể thay đổi dữ liệu luôn cần bạn duyệt; kết quả được coi là dữ liệu không tin cậy. Header xác thực chỉ ghi tên biến môi trường (MCP_…), không lưu giá trị.
      </p>
      {view?.errors.map((e) => (
        <p key={e} className="text-xs text-red-600">
          {e}
        </p>
      ))}
      <ul className="grid gap-1" aria-label="Danh sách máy chủ MCP">
        {view?.servers.map((s) => (
          <li key={s.name} className="grid gap-1 rounded-lg px-2 py-1.5 hover:bg-surface" data-mcp={s.name} data-state={s.state}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-xs">
                  {s.name} <span className="text-muted">· {s.source === "env" ? "MCP_SERVERS" : "tệp"} · {STATE[s.state]}{s.transport ? ` (${s.transport})` : ""}</span>
                </div>
                <div className="truncate text-[11px] text-muted">{s.url}</div>
                {s.error && <div className="text-[11px] text-red-600">{s.error}</div>}
                {s.headers.map((h) => (
                  <div key={h.header} className="text-[11px] text-muted">
                    {h.header} ← {h.env} {h.set ? "✓" : "(chưa đặt)"}
                  </div>
                ))}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  aria-label={`${s.enabled ? "Tắt" : "Bật"} máy chủ ${s.name}`}
                  onClick={() => void act({ action: "toggle", name: s.name, enabled: !s.enabled })}
                >
                  {s.enabled ? "Tắt" : "Bật"}
                </button>
                {s.source === "file" && (
                  <>
                    <button
                      type="button"
                      className={btn}
                      aria-label={`Sửa máy chủ ${s.name}`}
                      onClick={() =>
                        setDraft({ name: s.name, url: s.url, transport: s.transport ?? "auto", headers: s.headers.map((h) => `${h.header}: ${h.env}`).join("\n"), allowTools: s.allowTools.join(", "), timeoutS: String(s.timeoutS), editing: true })
                      }
                    >
                      Sửa
                    </button>
                    <button
                      type="button"
                      className={btn}
                      aria-label={`Xóa máy chủ ${s.name}`}
                      onClick={() => {
                        if (window.confirm(`Xóa máy chủ ${s.name}?`)) void act({ action: "delete", name: s.name }, `Đã xóa ${s.name}.`);
                      }}
                    >
                      Xóa
                    </button>
                  </>
                )}
              </div>
            </div>
            {s.tools.length > 0 && (
              <div className="flex flex-wrap gap-1" aria-label={`Công cụ của ${s.name}`}>
                {s.tools.map((t) => (
                  <span key={t.name} className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px]" title={t.readOnly ? "chỉ đọc" : "cần duyệt"}>
                    {t.mcpName}
                    {t.readOnly ? "" : " ✎"}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
        {view && view.servers.length === 0 && <li className="text-xs text-muted">Chưa có máy chủ MCP.</li>}
      </ul>
      {draft && (
        <form
          aria-label="Soạn máy chủ MCP"
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input className={field} aria-label="Tên máy chủ" placeholder="ten" value={draft.name} disabled={draft.editing} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className={field} aria-label="URL máy chủ" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          <select className={field} aria-label="Giao thức" value={draft.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value })}>
            <option value="auto">Tự động (HTTP, rồi SSE)</option>
            <option value="http">Streamable HTTP</option>
            <option value="sse">SSE (cũ)</option>
          </select>
          <textarea className={`${field} font-mono text-xs`} aria-label="Header xác thực" placeholder="Authorization: MCP_GITHUB_TOKEN" value={draft.headers} onChange={(e) => setDraft({ ...draft, headers: e.target.value })} />
          <input className={field} aria-label="Chỉ cho phép công cụ" placeholder="search_issues, get_file (trống = tất cả)" value={draft.allowTools} onChange={(e) => setDraft({ ...draft, allowTools: e.target.value })} />
          <input className={field} aria-label="Thời gian chờ (giây)" inputMode="numeric" value={draft.timeoutS} onChange={(e) => setDraft({ ...draft, timeoutS: e.target.value })} />
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-fg px-3 py-1.5 text-bg disabled:opacity-50">
              Lưu máy chủ
            </button>
            <button type="button" className="rounded-lg px-3 py-1.5 shadow-ring" onClick={() => setDraft(null)}>
              Hủy
            </button>
          </div>
        </form>
      )}
      {note && <p className="text-xs" role="status">{note}</p>}
    </section>
  );
}
