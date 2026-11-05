import { useEffect, useState } from "react";
import { bridgeApi, type BridgeStatus, type Handoff } from "@/lib/agent/bridge-client";
import { saigonTime } from "@/lib/agent/jobs-client";

const btn = "rounded px-2 py-0.5 text-xs shadow-ring disabled:opacity-50";
const STATE: Record<Handoff["state"], string> = {
  pending: "Chờ duyệt",
  sending: "Đang gửi",
  sent: "Đã gửi",
  failed: "Lỗi",
  rejected: "Đã từ chối",
  expired: "Hết hạn",
};

/** Settings: Sable ↔ peer agent bridge (W6). Shows no secret values; every real send needs the owner's click here or in chat. */
export function BridgePanel() {
  const [view, setView] = useState<BridgeStatus | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"task" | "question">("task");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  async function load() {
    try {
      setView(await bridgeApi.status());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setNote("");
    try {
      const msg = await fn();
      if (msg) setNote(msg);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void load();
    }
  }

  const ready = !!view?.outboundReady;
  const status = !view ? "…" : view.killed ? "Tắt (SABLE_BRIDGE=0)" : ready ? "sẵn sàng" : "Chưa cấu hình";
  const pending = view?.handoffs.filter((h) => h.state === "pending") ?? [];
  const recent = view?.handoffs.filter((h) => h.state !== "pending").slice(0, 8) ?? [];
  const inbound = view?.inbound.slice(0, 8) ?? [];

  return (
    <section aria-label="Bridge" className="grid gap-2 rounded-xl bg-bg p-3 text-sm shadow-ring" data-testid="bridge-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Bridge (agent ngoài)</span>
        <span data-testid="bridge-status" className={"text-xs " + (ready ? "text-accent" : "text-muted")}>{status}</span>
      </div>
      <p className="text-xs text-muted">
        Gửi việc/câu hỏi cho agent ngoài (Grok Bot) qua webhook ký HMAC. Mỗi lần gửi cần bạn duyệt; việc chạy nền không bao giờ gửi được. Kết quả trả về chỉ là dữ liệu (Tasks), không phải chỉ dẫn. Hướng dẫn: docs/BRIDGE-PROTOCOL.md.
      </p>
      {view && (
        <div className="grid gap-0.5 text-xs text-muted">
          <span>Peer: {view.peerHost ?? "—"}{view.peerToken ? " · có token" : ""} · inbound: {view.inboundPath}{view.inboundReady ? " (bật)" : " (tắt)"}</span>
          {view.problems.map((p) => (
            <span key={p}>• {p}</span>
          ))}
          {view.lastError && <span className="text-red-600">Lỗi gần nhất: {view.lastError}</span>}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={btn}
          disabled={busy}
          data-testid="bridge-ping-mock"
          onClick={() =>
            void run(async () => {
              const r = await bridgeApi.pingMock();
              return r.ok ? `Mock peer OK: pong đã xác thực (${r.ms} ms), chữ ký sai bị từ chối (${r.badSignatureStatus}).` : `Mock peer lỗi (${r.status}).`;
            })
          }
        >
          Test ping (mock)
        </button>
        <button type="button" className={btn} disabled={busy || !ready} onClick={() => void run(async () => void (await bridgeApi.handoff("ping", "ping", "ping")))}>
          Ping peer (cần duyệt)
        </button>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={!!view?.settings.inboundThreads} disabled={busy || !view} onChange={(e) => void run(async () => void (await bridgeApi.settings(e.target.checked)))} />
          Mở thread mới cho mỗi kết quả
        </label>
      </div>

      {ready && (
        <form
          className="grid gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await bridgeApi.handoff(kind, title, text);
              setTitle("");
              setText("");
              return "Đã tạo thẻ chờ duyệt — chưa gửi gì.";
            });
          }}
        >
          <div className="flex gap-1">
            <select value={kind} onChange={(e) => setKind(e.target.value as "task" | "question")} className="rounded bg-surface px-1 text-xs shadow-ring">
              <option value="task">Việc</option>
              <option value="question">Câu hỏi</option>
            </select>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Tiêu đề" className="flex-1 rounded bg-surface px-2 py-0.5 text-xs shadow-ring outline-none" />
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Nội dung (bí mật sẽ được che trước khi ký)" className="rounded bg-surface p-2 text-xs shadow-ring outline-none" />
          <button type="submit" className={btn + " justify-self-start"} disabled={busy || !title.trim() || !text.trim()}>
            Tạo thẻ duyệt
          </button>
        </form>
      )}

      {pending.length > 0 && (
        <ul className="grid gap-1" aria-label="Chờ duyệt">
          {pending.map((h) => (
            <li key={h.id} data-handoff={h.id} className="grid gap-1 rounded-lg bg-surface p-2 shadow-ring">
              <span className="text-xs font-medium">
                {h.kind} · {h.title} → {view?.peerHost}
              </span>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted">{h.text}</pre>
              <span className="text-xs text-muted">
                {h.bytes} byte · che {h.redactions} chỗ{h.clipped ? " · đã cắt bớt" : ""} · {saigonTime(h.at)}
              </span>
              <div className="flex gap-1">
                <button type="button" className={btn} disabled={busy} onClick={() => window.confirm(`Gửi "${h.title}" tới ${view?.peerHost}?`) && void run(async () => { const r = await bridgeApi.decide(h.id, true); return `Kết quả: ${STATE[r.handoff.state]}${r.handoff.error ? ` — ${r.handoff.error}` : ""}`; })}>
                  Duyệt gửi
                </button>
                <button type="button" className={btn} disabled={busy} onClick={() => void run(async () => void (await bridgeApi.decide(h.id, false)))}>
                  Từ chối
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {recent.length > 0 && (
        <div className="grid gap-0.5" aria-label="Handoff gần đây">
          <span className="text-xs font-medium">Gần đây</span>
          {recent.map((h) => (
            <span key={h.id} data-handoff={h.id} data-state={h.state} className="text-xs text-muted">
              {saigonTime(h.sentAt ?? h.at)} · {h.target === "mock" ? "mock" : "peer"} · {h.kind} · {h.title} · {STATE[h.state]}
              {h.status ? ` (${h.status}${h.ms != null ? `, ${h.ms} ms` : ""})` : ""}
              {h.error ? ` — ${h.error}` : ""}
            </span>
          ))}
        </div>
      )}

      {inbound.length > 0 && (
        <div className="grid gap-0.5" aria-label="Inbound">
          <span className="text-xs font-medium">Nhận về (dữ liệu không tin cậy)</span>
          {inbound.map((i) => (
            <span key={i.id} className="text-xs text-muted">
              {saigonTime(i.receivedAt)} · {i.type} · {i.title || "(không tiêu đề)"} · {i.state}
              {i.matched ? " · khớp handoff" : ""}
            </span>
          ))}
        </div>
      )}
      {note && <p className="text-xs text-muted" data-testid="bridge-note">{note}</p>}
    </section>
  );
}
