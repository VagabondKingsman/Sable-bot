import { useEffect, useRef, useState } from "react";
import { exportDesk, importDesk, onSyncStatus, syncStatus } from "@/lib/agent/desk/client";

const LABEL: Record<string, string> = {
  off: "Chưa đồng bộ",
  idle: "Đã đồng bộ",
  syncing: "Đang đồng bộ…",
  error: "Lỗi đồng bộ (sẽ thử lại)",
  disabled: "Đồng bộ máy chủ đang tắt (SABLE_DESK_SYNC=0)",
};

/** Settings section: chats/presets live on the server; export/import them. */
export function DeskSyncPanel() {
  const [status, setStatus] = useState(syncStatus());
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const off = onSyncStatus(() => setStatus(syncStatus()));
    return () => {
      off();
    };
  }, []);

  async function doExport() {
    try {
      const blob = await exportDesk();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sable-chats-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      setNote(`Không xuất được: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function doImport(file: File) {
    try {
      if (file.size > 7_500_000) throw new Error("Tệp quá lớn (tối đa ~7 MB).");
      const parsed = JSON.parse(await file.text()) as unknown;
      const result = await importDesk(parsed);
      setNote(`Đã nhập ${result.changed ?? 0} mục. Các thiết bị khác sẽ thấy trong vài giây.`);
    } catch (error) {
      setNote(`Không nhập được: ${error instanceof Error ? error.message : error}`);
    }
  }

  const when = status.lastSync ? new Date(status.lastSync).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  return (
    <section aria-label="Đồng bộ cuộc trò chuyện" className="grid gap-2 rounded-xl bg-bg p-3 text-sm shadow-ring">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Cuộc trò chuyện & preset trên máy chủ</span>
        <span className="text-xs text-muted" data-sync-state={status.state}>
          {LABEL[status.state]}
          {when && status.state === "idle" ? ` · ${when}` : ""}
        </span>
      </div>
      <p className="text-xs text-muted">Điện thoại và máy tính dùng chung các cuộc trò chuyện, preset và gán preset theo model.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-lg px-3 py-1.5 shadow-ring hover:bg-surface" onClick={() => void doExport()}>
          Xuất tệp
        </button>
        <button type="button" className="rounded-lg px-3 py-1.5 shadow-ring hover:bg-surface" onClick={() => input.current?.click()}>
          Nhập tệp
        </button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label="Chọn tệp sable-chats.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void doImport(f);
          }}
        />
      </div>
      {note && <p className="text-xs" role="status">{note}</p>}
    </section>
  );
}
