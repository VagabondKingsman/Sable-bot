import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { mediaApi, type MediaItem, type MediaProviders } from "@/lib/agent/w2-client";
import { saigonTime } from "@/lib/agent/jobs-client";
import { withPrefix } from "@/lib/agent/client";

type Item = MediaItem & { url?: string | null };

/** W2 media gallery: honest provider status, generate image/video (budget-gated), library grid. */
export function MediaTab() {
  const [providers, setProviders] = useState<MediaProviders | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"image" | "video">("image");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const d = await mediaApi.library(signal);
      setProviders(d.providers);
      setItems(d.items as Item[]);
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

  async function run(fn: () => Promise<unknown>) {
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

  if (!providers) return <p className="p-3 text-sm text-muted">{error || "Đang tải…"}</p>;
  const list = kind === "image" ? providers.image : providers.video;
  const ready = providers.enabled && list.some((p) => p.configured);

  return (
    <div className="space-y-3 p-3">
      {!providers.enabled && <p className="text-sm text-muted">Media đang tắt (SABLE_MEDIA=0).</p>}
      <ul className="space-y-1 text-xs text-muted">
        {[...providers.image.map((p) => ({ ...p, k: "ảnh" })), ...providers.video.map((p) => ({ ...p, k: "video" }))].map((p) => (
          <li key={`${p.k}-${p.id}`}>
            <span className={p.configured ? "text-accent" : ""}>{p.configured ? "●" : "○"}</span> {p.k} · {p.label} · {p.model}
            {p.configured ? "" : ` — chưa cấu hình: ${p.reason ?? ""}`}
          </li>
        ))}
        <li>
          Chi phí media: ${providers.budget.mediaUsd.toFixed(2)}
          {providers.budget.capUsd != null ? ` / trần $${providers.budget.capUsd}` : " (không trần riêng)"}
        </li>
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!prompt.trim()) return;
          void run(() => mediaApi.generate({ kind, prompt, save: true }).then(() => setPrompt("")));
        }}
      >
        <select aria-label="Loại" value={kind} onChange={(e) => setKind(e.target.value as "image" | "video")} className="min-h-11 rounded-xl bg-surface px-2 text-sm shadow-ring">
          <option value="image">Ảnh</option>
          <option value="video">Video</option>
        </select>
        <input aria-label="Mô tả" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Mô tả…" maxLength={4000} className="min-h-11 flex-1 rounded-xl bg-surface px-3 text-sm shadow-ring" />
        <button type="submit" disabled={busy || !ready || !prompt.trim()} className="min-h-11 rounded-xl bg-accent px-4 text-sm text-ink disabled:opacity-50">
          {busy ? "Đang tạo…" : "Tạo"}
        </button>
      </form>
      {!ready && providers.enabled && <p className="text-xs text-muted">Chưa có provider {kind === "image" ? "ảnh" : "video"} thật nào được cấu hình.</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((item) => {
          const src = item.url ? (item.url.startsWith("/api/") ? withPrefix(item.url) : item.url) : null;
          return (
            <figure key={item.id} className="overflow-hidden rounded-2xl shadow-ring">
              {item.status === "ready" && src ? (
                item.kind === "image" ? (
                  <img src={src} alt={item.prompt.slice(0, 120)} className="aspect-square w-full object-cover" loading="lazy" />
                ) : (
                  <video src={src} controls className="aspect-video w-full" />
                )
              ) : (
                <div className="grid aspect-square place-items-center text-xs text-muted">{item.status === "failed" ? item.error ?? "lỗi" : "đang tạo…"}</div>
              )}
              <figcaption className="space-y-1 p-2 text-xs text-muted">
                <p className="line-clamp-2 text-fg">{item.prompt}</p>
                <p>
                  {item.kind} · {item.provider} · ${item.usd.toFixed(2)} · {saigonTime(item.createdAt)}
                </p>
                <div className="flex gap-1">
                  {item.status === "pending" && (
                    <button type="button" aria-label="Cập nhật" disabled={busy} onClick={() => void run(() => mediaApi.refresh(item.id))} className="grid size-9 place-items-center rounded-lg hover:bg-fg/5">
                      <RotateCcw className="size-4" />
                    </button>
                  )}
                  <button type="button" aria-label="Xóa" disabled={busy} onClick={() => void run(() => mediaApi.remove(item.id))} className="grid size-9 place-items-center rounded-lg hover:bg-fg/5">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </figcaption>
            </figure>
          );
        })}
      </div>
      {items.length === 0 && <p className="text-sm text-muted">Thư viện trống.</p>}
    </div>
  );
}
