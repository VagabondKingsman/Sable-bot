/** W2a proactive UI: morning-brief settings card (+ Tasks inbox, reply chips). */
import { useEffect, useState } from "react";
import { Bell, Play } from "lucide-react";
import { proactiveApi, type BriefView } from "@/lib/agent/proactive-client";
import { saigonTime } from "@/lib/agent/jobs-client";

const btn =
  "inline-flex min-h-11 items-center justify-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:text-fg disabled:opacity-40";
const field = "rounded-xl bg-bg px-3 py-2 text-sm text-fg shadow-ring outline-none placeholder:text-muted";

export function BriefCard() {
  const [view, setView] = useState<BriefView | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => proactiveApi.brief().then(setView).catch((e) => setNote(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);
  if (!view) return <p className="text-sm text-muted">{note || "Đang tải bản tin…"}</p>;
  if (!view.enabled) return <p className="text-sm text-muted">Bản tin sáng đang tắt trên máy chủ (SABLE_BRIEF=0).</p>;
  const cfg = view.config;
  async function patch(p: Parameters<typeof proactiveApi.briefConfig>[0]) {
    setNote("");
    try {
      await proactiveApi.briefConfig(p);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }
  async function runNow() {
    setBusy(true);
    setNote("");
    try {
      const out = await proactiveApi.briefRun();
      setNote(`Đã gửi: ${out.brief.delivered.join(" + ")}`);
      setOpen(out.brief.id);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-bg p-4 shadow-ring" aria-label="Bản tin sáng" data-brief-enabled={cfg.enabled ? "1" : "0"}>
      <div className="flex flex-wrap items-center gap-2">
        <Bell className="size-4 text-accent" />
        <h3 className="flex-1 text-sm font-medium">Bản tin sáng</h3>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} className="size-4 accent-[var(--color-accent)]" />
          Bật
        </label>
        <input type="time" aria-label="Giờ gửi" className={field} value={cfg.time} onChange={(e) => void patch({ time: e.target.value })} />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.telegram} onChange={(e) => void patch({ telegram: e.target.checked })} className="size-4 accent-[var(--color-accent)]" />
          Telegram
        </label>
        <button type="button" className={btn} disabled={busy} onClick={() => void runNow()}>
          <Play className="size-4" /> Gửi ngay
        </button>
      </div>
      <p className="text-xs text-muted">
        {cfg.enabled ? `Mỗi ngày lúc ${cfg.time} (${cfg.tz}).` : "Đang tắt."} Gửi vào Hộp thư{cfg.telegram ? " và Telegram của bạn (nếu đã cấu hình)" : ""}.
        {cfg.lastRunAt ? ` Lần cuối: ${saigonTime(cfg.lastRunAt)}.` : ""}
      </p>
      {note && <p className="text-sm text-accent">{note}</p>}
      {view.history.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Bản tin gần đây">
          {view.history.slice(0, 5).map((b) => (
            <li key={b.id}>
              <button type="button" className="w-full truncate text-left text-sm text-muted hover:text-fg" onClick={() => setOpen(open === b.id ? null : b.id)}>
                {saigonTime(b.at)} · {b.title}
              </button>
              {open === b.id && <pre className="mt-1 whitespace-pre-wrap rounded-xl bg-surface p-3 text-xs" data-brief-text>{b.text}</pre>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
