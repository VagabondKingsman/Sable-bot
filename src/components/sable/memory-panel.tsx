/** Learned memory panel: what Sable remembered on its own. Every change goes through /api/memory. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Pin, PinOff, Trash2, Upload, Pencil, Check, X } from "lucide-react";
import type { Memory } from "@/lib/agent/memory/types";
import { withPrefix } from "@/lib/agent/client";

type State = { enabled: boolean; killed: boolean; stats: { total: number; max: number }; items: Memory[] };

async function call<T>(init?: { body?: unknown; q?: string }): Promise<T> {
  const res = init?.body
    ? await fetch(withPrefix("/api/memory"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) })
    : await fetch(`${withPrefix("/api/memory")}${init?.q ? `?q=${encodeURIComponent(init.q)}` : ""}`, { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
  return data;
}

const KIND_LABEL = { profile: "Hồ sơ", journal: "Nhật ký" } as const;

export function LearnedMemory({ noMemory, onNoMemory }: { noMemory: boolean; onNoMemory: (on: boolean) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (q = query) => {
    try {
      setState(await call<State>({ q: q.trim() }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được bộ nhớ.");
    }
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), 200);
    return () => clearTimeout(timer);
  }, [query, load]);

  async function act(body: Record<string, unknown>) {
    try {
      await call({ body });
      setError("");
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thực hiện được.");
      return false;
    }
  }

  async function importFile(file: File) {
    if (file.size > 900_000) return setError("File quá lớn (tối đa ~900 KB).");
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return setError("File không phải JSON.");
    }
    const replace = window.confirm("Thay toàn bộ bộ nhớ hiện tại? (OK = thay, Huỷ = gộp thêm)");
    await act({ action: "import", mode: replace ? "replace" : "merge", data });
  }

  const off = !state || !state.enabled || state.killed;
  return (
    <section aria-labelledby="sable-learned-title" className="flex flex-col gap-3 rounded-xl bg-bg p-3 shadow-ring" data-testid="learned-memory">
      <div className="flex items-center justify-between gap-2">
        <h3 id="sable-learned-title" className="text-sm text-muted">
          Sable tự ghi nhớ {state ? `(${state.stats.total}/${state.stats.max})` : ""}
        </h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Bật tự ghi nhớ"
            checked={Boolean(state?.enabled) && !state?.killed}
            disabled={!state || state.killed}
            onChange={(event) => {
              const enabled = event.target.checked;
              // Optimistic: flip now, reload (and revert) from the server answer.
              setState((current) => (current ? { ...current, enabled } : current));
              void act({ action: "toggle", enabled });
            }}
          />
          Bật
        </label>
      </div>
      {state?.killed && <p className="text-xs text-muted">Đang tắt trên máy chủ (SABLE_MEMORY=0).</p>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" aria-label="Không ghi nhớ cuộc này" checked={noMemory} onChange={(event) => onNoMemory(event.target.checked)} />
        Không ghi nhớ cuộc trò chuyện này
      </label>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Tìm trong bộ nhớ"
        aria-label="Tìm trong bộ nhớ"
        className="h-10 rounded-lg bg-surface px-3 text-sm shadow-ring outline-none"
      />
      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (adding.trim() && (await act({ action: "add", text: adding.trim() }))) setAdding("");
        }}
      >
        <input
          value={adding}
          maxLength={300}
          disabled={off}
          onChange={(event) => setAdding(event.target.value)}
          placeholder="Thêm một điều cần nhớ"
          aria-label="Thêm điều cần nhớ"
          className="h-10 min-w-0 flex-1 rounded-lg bg-surface px-3 text-sm shadow-ring outline-none"
        />
        <button type="submit" disabled={off || !adding.trim()} className="h-10 rounded-lg bg-accent px-3 text-sm text-ink disabled:opacity-40">
          Thêm
        </button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-label="Danh sách ghi nhớ">
        {state?.items.length === 0 && <li className="text-sm text-muted">{query ? "Không có kết quả." : "Chưa nhớ gì."}</li>}
        {state?.items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 rounded-lg bg-surface p-2 text-sm shadow-ring" data-memory-id={item.id}>
            {editing?.id === item.id ? (
              <form
                className="flex flex-1 gap-1"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (await act({ action: "update", id: item.id, text: editing.text })) setEditing(null);
                }}
              >
                <input
                  autoFocus
                  maxLength={300}
                  value={editing.text}
                  aria-label="Sửa ghi nhớ"
                  onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                  className="h-9 min-w-0 flex-1 rounded bg-bg px-2 outline-none"
                />
                <button type="submit" aria-label="Lưu" className="grid size-9 place-items-center">
                  <Check className="size-4" />
                </button>
                <button type="button" aria-label="Huỷ sửa" className="grid size-9 place-items-center" onClick={() => setEditing(null)}>
                  <X className="size-4" />
                </button>
              </form>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <p className="break-words leading-snug">{item.text}</p>
                  <p className="text-xs text-muted">
                    {KIND_LABEL[item.kind]}
                    {item.eventDate ? ` · ${item.eventDate}` : ""} · {item.source}
                  </p>
                </div>
                <button type="button" aria-label={item.pinned ? "Bỏ ghim" : "Ghim"} className="grid size-9 place-items-center" onClick={() => void act({ action: "update", id: item.id, pinned: !item.pinned })}>
                  {item.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                </button>
                <button type="button" aria-label="Sửa" className="grid size-9 place-items-center" onClick={() => setEditing({ id: item.id, text: item.text })}>
                  <Pencil className="size-4" />
                </button>
                <button type="button" aria-label="Xoá ghi nhớ" className="grid size-9 place-items-center" onClick={() => void act({ action: "delete", ids: [item.id] })}>
                  <Trash2 className="size-4" />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 text-sm">
        <a href={`${withPrefix("/api/memory")}?export=1`} download="sable-memory.json" className="flex h-9 items-center gap-1 rounded-lg px-2 shadow-ring">
          <Download className="size-4" /> Xuất
        </a>
        <button type="button" disabled={off} className="flex h-9 items-center gap-1 rounded-lg px-2 shadow-ring disabled:opacity-40" onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" /> Nhập
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Chọn file nhập"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
        <button
          type="button"
          disabled={!state?.items.length}
          className="ml-auto flex h-9 items-center gap-1 rounded-lg px-2 text-red-500 shadow-ring disabled:opacity-40"
          onClick={() => window.confirm("Xoá toàn bộ những gì Sable đã tự ghi nhớ?") && void act({ action: "delete", ids: "all" })}
        >
          <Trash2 className="size-4" /> Xoá hết
        </button>
      </div>
    </section>
  );
}
