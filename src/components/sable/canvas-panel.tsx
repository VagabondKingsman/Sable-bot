import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, PanelRight, Plus, Trash2, X } from "lucide-react";
import { canvasApi, type CanvasDetail, type CanvasShareView, type CanvasSummary } from "@/lib/agent/w2-client";
import { saigonTime } from "@/lib/agent/jobs-client";

export const CANVAS_OPEN_EVENT = "sable:canvas-open";
export type CanvasOpen = { id: string; version?: number } | null;

/** Ask the desk to show a canvas in the side pane beside the chat. */
export function openCanvasBeside(id: string, version?: number) {
  window.dispatchEvent(new CustomEvent<CanvasOpen>(CANVAS_OPEN_EVENT, { detail: { id, version } }));
}

/** Absolute desk link (the desk's own origin; owner auth still required). */
function shareHref(id: string, version?: number) {
  return new URL(canvasApi.viewUrl(id, version), window.location.href).toString();
}

/**
 * W2c: a sandboxed canvas frame that cannot keep a self-navigation. The first
 * `load` is the canvas; any later load means the page navigated its own frame,
 * so the original is restored (remount). After 3 attempts the frame is replaced
 * by a notice. Top/parent navigation, popups and forms are blocked by the sandbox.
 */
export function GuardedFrame({ src, srcDoc, title, className }: { src?: string; srcDoc?: string; title: string; className?: string }) {
  const [gen, setGen] = useState(0);
  const [blocked, setBlocked] = useState(0);
  const loads = useRef(0);
  useEffect(() => {
    loads.current = 0;
    setBlocked(0);
  }, [src, srcDoc]);
  if (blocked > 3) return <p className={`${className ?? ""} grid place-items-center p-6 text-sm text-amber-400`}>Đã chặn: trang liên tục tự điều hướng.</p>;
  return (
    <>
      {blocked > 0 && <p className="px-3 text-xs text-amber-400">Đã chặn {blocked} lần trang tự điều hướng.</p>}
      <iframe
        key={gen}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={src}
        srcDoc={srcDoc}
        className={className}
        onLoad={() => {
          loads.current += 1;
          if (loads.current > 1) {
            loads.current = 0;
            setBlocked((b) => b + 1);
            setGen((g) => g + 1);
          }
        }}
      />
    </>
  );
}

const TTL_CHOICES: { h: number; label: string }[] = [
  { h: 1, label: "1 giờ" },
  { h: 24, label: "1 ngày" },
  { h: 24 * 7, label: "7 ngày" },
  { h: 24 * 30, label: "30 ngày" },
];

/** W2c: owner-created, expiring, revocable, read-only links (/s/<token>). */
function ShareLinks({ id, version }: { id: string; version: number }) {
  const [items, setItems] = useState<CanvasShareView[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [ttl, setTtl] = useState(24 * 7);
  const [pin, setPin] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try {
      const d = await canvasApi.shares(id);
      setEnabled(d.enabled);
      setItems(d.items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Lỗi.");
    }
  }, [id]);
  useEffect(() => {
    setFresh(null);
    void load();
  }, [load]);
  if (!enabled) return <p className="text-xs text-muted">Link chia sẻ đang tắt (SABLE_SHARE=0).</p>;
  const active = items.filter((s) => s.state === "active");
  return (
    <div className="space-y-2 rounded-xl bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Link chỉ xem</span>
        <select aria-label="Thời hạn" className="h-9 rounded-lg bg-bg px-2" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
          {TTL_CHOICES.map((c) => (
            <option key={c.h} value={c.h}>
              {c.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> ghim v{version}
        </label>
        <button
          type="button"
          className="h-9 rounded-lg bg-fg px-3 text-bg"
          onClick={() =>
            void canvasApi
              .share(id, ttl, pin ? version : undefined)
              .then((r) => {
                setFresh(r.url);
                setErr("");
                return load();
              })
              .catch((e) => setErr(e instanceof Error ? e.message : "Lỗi."))
          }
        >
          Tạo link
        </button>
      </div>
      {fresh && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <code className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1">{fresh}</code>
          <button type="button" className="h-8 rounded-lg px-2 hover:bg-fg/5" onClick={() => void navigator.clipboard?.writeText(fresh)}>
            Chép
          </button>
          <span className="w-full text-muted">Link chỉ hiện một lần. Ai có link đều xem được (chỉ đọc) đến khi hết hạn hoặc bạn thu hồi. Qua ngrok vẫn cần basic-auth trừ khi bạn mở /s/ trong traffic policy (docs/CANVAS-SHARE.md).</span>
        </div>
      )}
      {err && <p className="text-xs text-red-400">{err}</p>}
      {active.length > 0 && (
        <ul className="space-y-1 text-xs">
          {active.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-muted">
                {s.id} · {s.version ? `v${s.version}` : "bản mới nhất"} · hết hạn {saigonTime(s.expiresAt)} · {s.views} lượt xem
              </span>
              <button type="button" className="h-8 rounded-lg px-2 text-red-400 hover:bg-fg/5" onClick={() => void canvasApi.revokeShare(s.id).then(load).catch((e) => setErr(e instanceof Error ? e.message : "Lỗi."))}>
                Thu hồi
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
            Chép link desk
          </button>
        </div>
        <p className="text-xs text-muted">Link desk cần đăng nhập của desk (basic-auth qua ngrok). Trang chạy trong sandbox: không mạng, không truy cập desk, không tự điều hướng.</p>
        <ShareLinks id={sel.id} version={sel.shownVersion} />
        <GuardedFrame
          key={`${sel.id}-${sel.shownVersion}`}
          title={sel.title}
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
      <GuardedFrame
        key={`${open.id}-${open.version ?? "latest"}`}
        title={title}
        src={canvasApi.viewUrl(open.id, open.version)}
        className="m-3 mt-0 min-h-0 flex-1 rounded-xl bg-fg shadow-ring"
      />
    </aside>
  );
}
