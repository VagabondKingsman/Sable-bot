import { useCallback, useEffect, useState } from "react";
import { ExternalLink, PanelRight, Plus, Trash2, X } from "lucide-react";
import { canvasApi, type CanvasDetail, type CanvasSummary } from "@/lib/agent/w2-client";
import { saigonTime } from "@/lib/agent/jobs-client";

export const CANVAS_OPEN_EVENT = "sable:canvas-open";
export type CanvasOpen = { id: string; version?: number } | null;

/** Ask the desk to show a canvas in the side pane beside the chat. */
export function openCanvasBeside(id: string, version?: number) {
  window.dispatchEvent(new CustomEvent<CanvasOpen>(CANVAS_OPEN_EVENT, { detail: { id, version } }));
}

/** Absolute share link (the desk's own origin; owner auth still required). */
function shareHref(id: string, version?: number) {
  return new URL(canvasApi.viewUrl(id, version), window.location.href).toString();
}

/** Background → Canvas: list, versions, preview, create, delete. */
export function CanvasTab({ onOpened }: { onOpened?: () => void }) {
  const [enabled, setEnabled] = useState(true);
  const [items, setItems] = useState<CanvasSummary[] | null>(null);
  const [sel, setSel] = useState<CanvasDetail | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{ title: string; html: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const d = await canvasApi.list(signal);
      setEnabled(d.enabled);
      setItems(d.items);
      setError("");
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : "Không tải được.");
    }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  async function pick(id: string, version?: number) {
    try {
      setSel((await canvasApi.get(id, version)).canvas);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không mở được.");
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi.");
    } finally {
      setBusy(false);
    }
  }

  if (!items) return <p className="p-3 text-sm text-muted">{error || "Đang tải…"}</p>;
  if (!enabled) return <p className="p-3 text-sm text-muted">Canvas đang tắt (SABLE_CANVAS=0).</p>;

  if (sel) {
    return (
      <div className="flex h-full min-h-[60vh] flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="h-11 rounded-xl px-3 text-sm text-muted hover:bg-fg/5" onClick={() => setSel(null)}>
            ← Danh sách
          </button>
          <h3 className="min-w-0 flex-1 truncate font-display text-lg">{sel.title}</h3>
          <label className="text-xs text-muted">
            Phiên bản{" "}
            <select className="h-9 rounded-lg bg-surface px-2" value={sel.shownVersion} onChange={(e) => void pick(sel.id, Number(e.target.value))}>
              {[...sel.versions].reverse().map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {saigonTime(v.at)}
                  {v.note ? ` · ${v.note}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <button
            type="button"
            className="flex h-11 items-center gap-2 rounded-xl px-3 text-muted hover:bg-fg/5 hover:text-fg"
            onClick={() => {
              openCanvasBeside(sel.id, sel.shownVersion);
              onOpened?.();
            }}
          >
            <PanelRight className="size-4" /> Mở cạnh chat
          </button>
          <a className="flex h-11 items-center gap-2 rounded-xl px-3 text-muted hover:bg-fg/5 hover:text-fg" href={canvasApi.viewUrl(sel.id, sel.shownVersion)} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" /> Tab mới
          </a>
          <button type="button" className="h-11 rounded-xl px-3 text-muted hover:bg-fg/5 hover:text-fg" onClick={() => void navigator.clipboard?.writeText(shareHref(sel.id, sel.shownVersion))}>
            Chép link chia sẻ
          </button>
        </div>
        <p className="text-xs text-muted">Link chia sẻ dùng chung đăng nhập của desk (basic-auth qua ngrok). Trang chạy trong sandbox: không mạng, không truy cập desk.</p>
        <iframe
          key={`${sel.id}-${sel.shownVersion}`}
          title={sel.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={canvasApi.viewUrl(sel.id, sel.shownVersion)}
          className="min-h-[50vh] w-full flex-1 rounded-xl bg-fg shadow-ring"
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {draft ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const res = await canvasApi.create(draft.title, draft.html);
              setDraft(null);
              await pick(res.canvas.id);
            });
          }}
        >
          <input className="h-11 w-full rounded-xl bg-surface px-3 text-sm" placeholder="Tiêu đề" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <textarea className="h-48 w-full rounded-xl bg-surface p-3 font-mono text-xs" placeholder="<h1>HTML + CSS/JS inline</h1>" value={draft.html} onChange={(e) => setDraft({ ...draft, html: e.target.value })} />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !draft.html.trim()} className="h-11 rounded-xl bg-accent px-4 text-sm text-ink disabled:opacity-40">
              Lưu canvas
            </button>
            <button type="button" className="h-11 rounded-xl px-3 text-sm text-muted hover:bg-fg/5" onClick={() => setDraft(null)}>
              Hủy
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="flex h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted hover:bg-fg/5 hover:text-fg" onClick={() => setDraft({ title: "", html: "" })}>
          <Plus className="size-4" /> Canvas mới
        </button>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted">Chưa có canvas. Bật Files trong chat và nhờ Sable “làm một canvas …” (cần duyệt), hoặc tạo tay.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-xl px-2 hover:bg-fg/5">
              <button type="button" className="min-h-11 min-w-0 flex-1 text-left" onClick={() => void pick(c.id)}>
                <span className="block truncate text-sm">{c.title}</span>
                <span className="block text-xs text-muted">
                  v{c.version} · {saigonTime(c.updatedAt)} · {Math.ceil(c.bytes / 1024)} KB
                </span>
              </button>
              <button
                type="button"
                aria-label="Mở cạnh chat"
                className="grid size-11 place-items-center rounded-xl text-muted hover:text-fg"
                onClick={() => {
                  openCanvasBeside(c.id);
                  onOpened?.();
                }}
              >
                <PanelRight className="size-4" />
              </button>
              <button type="button" aria-label="Xóa canvas" disabled={busy} className="grid size-11 place-items-center rounded-xl text-muted hover:text-fg" onClick={() => confirm(`Xóa “${c.title}”?`) && void act(() => canvasApi.remove(c.id))}>
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Side pane beside the chat (same slot as the HTML preview pane). */
export function CanvasPane({ open, mobile, onClose }: { open: { id: string; version?: number }; mobile: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("Canvas");
  useEffect(() => {
    const c = new AbortController();
    canvasApi
      .get(open.id, open.version, c.signal)
      .then((d) => setTitle(d.canvas.title))
      .catch(() => undefined);
    return () => c.abort();
  }, [open.id, open.version]);
  return (
    <aside className={"min-w-0 flex-col border-fg/10 bg-bg md:flex md:w-[46%] md:border-l " + (mobile ? "flex flex-1" : "hidden")}>
      <div className="flex items-center gap-2 px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm text-muted">{title}</p>
        <a className="grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/5 hover:text-fg" aria-label="Mở tab mới" href={canvasApi.viewUrl(open.id, open.version)} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="size-4" />
        </a>
        <button type="button" aria-label="Đóng canvas" className="grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/5 hover:text-fg" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <iframe
        key={`${open.id}-${open.version ?? "latest"}`}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={canvasApi.viewUrl(open.id, open.version)}
        className="m-3 mt-0 min-h-0 flex-1 rounded-xl bg-fg shadow-ring"
      />
    </aside>
  );
}
