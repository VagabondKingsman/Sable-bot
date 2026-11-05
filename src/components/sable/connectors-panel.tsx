import { useEffect, useState } from "react";
import { withPrefix } from "@/lib/agent/client";
import { saigonTime } from "@/lib/agent/jobs-client";

type Connector = {
  id: string;
  label: string;
  description: string;
  status: "off" | "not-configured" | "needs-auth" | "connected" | "error";
  reason?: string;
  scopes: string[];
  grantedScopes?: string[];
  connectedAt?: number;
  lastError?: string;
  lastSyncAt?: number;
};
type View = { enabled: boolean; redirectUri: string | null; connectors: Connector[]; setup: string };

const LABEL: Record<Connector["status"], string> = {
  off: "Tắt",
  "not-configured": "Chưa cấu hình",
  "needs-auth": "Cần cấp quyền",
  connected: "Đã kết nối",
  error: "Lỗi",
};
const btn = "rounded px-2 py-0.5 text-xs shadow-ring disabled:opacity-50";

/** Settings: OAuth connectors (Gmail, Google Calendar). Tokens never reach the browser. */
export function ConnectorsPanel() {
  const [view, setView] = useState<View | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await fetch(withPrefix("/api/connectors"), { cache: "no-store" });
      setView((await res.json()) as View);
    } catch {
      setNote("Không tải được connectors.");
    }
  }
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  async function act(action: "connect" | "disconnect" | "sync", id: string) {
    if (action === "disconnect" && !window.confirm("Ngắt kết nối và thu hồi quyền?")) return;
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(withPrefix("/api/connectors"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id }) });
      const data = (await res.json().catch(() => ({}))) as View & { url?: string; message?: string; synced?: number };
      if (data.connectors) setView(data);
      if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
      if (action === "connect" && data.url) {
        window.open(data.url, "_blank", "noopener,noreferrer");
        setNote("Đã mở trang cấp quyền. Xong thì quay lại tab này.");
      }
      if (action === "sync") setNote(`Đã đồng bộ ${data.synced ?? 0} mục.`);
      if (action === "disconnect") setNote("Đã ngắt kết nối.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Kết nối" className="grid gap-2 rounded-xl bg-bg p-3 text-sm shadow-ring" data-testid="connectors-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Kết nối (OAuth)</span>
        {view && !view.enabled && <span className="text-xs text-muted">Đang tắt (SABLE_OAUTH=0)</span>}
      </div>
      <p className="text-xs text-muted">
        Token chỉ lưu trong vault (mã hoá). Redirect URI cần đăng ký trong Google Cloud Console:{" "}
        <code className="break-all">{view?.redirectUri ?? "— chưa có public origin —"}</code>. Hướng dẫn: {view?.setup ?? "docs/OAUTH-SETUP.md"}.
      </p>
      <ul className="grid gap-1">
        {view?.connectors.map((c) => (
          <li key={c.id} className="grid gap-1 rounded-lg px-2 py-1.5 hover:bg-surface" data-connector={c.id} data-state={c.status}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{c.label}</span>
              <span className={"text-xs " + (c.status === "connected" ? "text-accent" : c.status === "error" ? "text-red-600" : "text-muted")}>{LABEL[c.status]}</span>
            </div>
            <span className="text-xs text-muted">{c.description}</span>
            {c.reason && <span className="text-xs text-muted">{c.reason}</span>}
            {c.connectedAt && <span className="text-xs text-muted">Kết nối lúc {saigonTime(c.connectedAt)}{c.lastSyncAt ? ` · đồng bộ ${saigonTime(c.lastSyncAt)}` : ""}</span>}
            {c.lastError && c.status !== "connected" && <span className="text-xs text-red-600">{c.lastError}</span>}
            <div className="flex gap-1">
              {(c.status === "needs-auth" || c.status === "error") && (
                <button type="button" className={btn} disabled={busy} onClick={() => void act("connect", c.id)}>
                  Connect
                </button>
              )}
              {c.status === "connected" && (
                <>
                  {c.id === "gmail" && (
                    <button type="button" className={btn} disabled={busy} onClick={() => void act("sync", c.id)}>
                      Đồng bộ thư
                    </button>
                  )}
                  <button type="button" className={btn} disabled={busy} onClick={() => void act("disconnect", c.id)}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {note && <p className="text-xs text-muted">{note}</p>}
    </section>
  );
}
