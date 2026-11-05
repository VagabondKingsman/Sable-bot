import { useEffect, useState } from "react";
import { withPrefix } from "@/lib/agent/client";
import type { AgentSettings, ToolFlags } from "@/lib/agent/types";

type Row = {
  id: string;
  name: string;
  builtin?: boolean;
  model?: string;
  tools: Partial<ToolFlags>;
  spawnTools: string[];
  instructions: string;
};

type Props = {
  settings: AgentSettings;
  onChange: (patch: Partial<AgentSettings>) => void;
};

/** Settings: switch / edit multi-agent profiles (personas + spawn tool sets). */
export function ProfilesPanel({ settings, onChange }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [activeId, setActiveId] = useState("sable");
  const [enabled, setEnabled] = useState(true);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<Row | null>(null);

  async function refresh() {
    try {
      const res = await fetch(withPrefix("/api/profiles"), { cache: "no-store" });
      const data = (await res.json()) as { enabled: boolean; activeId: string; profiles: Row[] };
      setEnabled(data.enabled);
      setActiveId(data.activeId);
      setRows(data.profiles ?? []);
    } catch {
      setNote("Không tải được profile.");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function post(body: unknown) {
    const res = await fetch(withPrefix("/api/profiles"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; state?: { activeId: string; profiles: Row[] }; profile?: Row };
    if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
    return data;
  }

  async function activate(id: string) {
    try {
      const data = await post({ action: "activate", id });
      const profile = data.profile;
      if (profile) {
        onChange({
          instructions: profile.instructions,
          ...(profile.model ? { model: profile.model } : {}),
          ...profile.tools,
        });
      }
      if (data.state) {
        setActiveId(data.state.activeId);
        setRows(data.state.profiles);
      }
      setNote(`Đã chuyển sang profile ${id}.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Không chuyển được.");
    }
  }

  async function save() {
    if (!draft) return;
    try {
      const data = await post({
        action: "save",
        profile: {
          ...draft,
          spawnTools: draft.spawnTools,
        },
      });
      if (data.state) {
        setRows(data.state.profiles);
        setActiveId(data.state.activeId);
      }
      setDraft(null);
      setNote("Đã lưu profile.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Không lưu được.");
    }
  }

  async function remove(id: string) {
    if (!window.confirm(`Xóa profile ${id}?`)) return;
    try {
      const data = await post({ action: "delete", id });
      if (data.state) {
        setRows(data.state.profiles);
        setActiveId(data.state.activeId);
      }
      setNote(`Đã xóa ${id}.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Không xóa được.");
    }
  }

  const field = "w-full rounded-lg bg-surface px-2 py-1.5 text-sm shadow-ring";
  return (
    <section aria-label="Profile đa agent" className="grid gap-2 rounded-xl bg-bg p-3 text-sm shadow-ring">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Profile đa agent</span>
        {enabled ? (
          <button
            type="button"
            className="rounded-lg px-3 py-1 shadow-ring hover:bg-surface"
            onClick={() =>
              setDraft({
                id: "custom",
                name: "Profile mới",
                instructions: settings.instructions,
                tools: { files: true, fetch: true },
                spawnTools: ["fs_list", "fs_read"],
              })
            }
          >
            Thêm
          </button>
        ) : (
          <span className="text-xs text-muted">Đang tắt (SABLE_PROFILES=0)</span>
        )}
      </div>
      <p className="text-xs text-muted">
        Mỗi profile là một persona (chỉ dẫn + công cụ). Bấm dùng để áp vào chat; spawn_agent cũng nhận id profile tùy chỉnh.
      </p>
      <ul className="grid gap-1" aria-label="Danh sách profile">
        {rows.map((r) => (
          <li key={r.id} className={`flex items-start justify-between gap-2 rounded-lg px-2 py-1.5 ${activeId === r.id ? "bg-accent/15" : "hover:bg-surface"}`}>
            <div className="min-w-0">
              <div className="font-medium">
                {r.name} <span className="font-mono text-[11px] text-muted">({r.id})</span>
                {activeId === r.id && <span className="ml-1 text-[11px] text-accent">đang dùng</span>}
              </div>
              <div className="line-clamp-2 text-xs text-muted">{r.instructions}</div>
            </div>
            {enabled && (
              <div className="flex shrink-0 flex-col gap-1">
                <button type="button" className="rounded px-2 py-0.5 text-xs shadow-ring" onClick={() => void activate(r.id)}>
                  Dùng
                </button>
                <button type="button" className="rounded px-2 py-0.5 text-xs shadow-ring" onClick={() => setDraft({ ...r })}>
                  Sửa
                </button>
                {!r.builtin && (
                  <button type="button" className="rounded px-2 py-0.5 text-xs shadow-ring" onClick={() => void remove(r.id)}>
                    Xóa
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {draft && (
        <div className="grid gap-2 rounded-lg bg-surface p-2 shadow-ring">
          <input className={field} value={draft.id} disabled={Boolean(draft.builtin) || rows.some((r) => r.id === draft.id && r.builtin)} onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) })} placeholder="id" />
          <input className={field} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Tên" />
          <textarea className={field} rows={4} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} />
          <input
            className={field}
            value={Array.isArray(draft.spawnTools) ? draft.spawnTools.join(", ") : String(draft.spawnTools ?? "")}
            onChange={(e) => setDraft({ ...draft, spawnTools: e.target.value.split(/[,\s]+/).filter(Boolean) as unknown as string[] })}
            placeholder="spawn tools: fs_read, http_fetch…"
          />
          <div className="flex gap-2">
            <button type="button" className="rounded-lg bg-accent px-3 py-1 text-ink" onClick={() => void save()}>
              Lưu
            </button>
            <button type="button" className="rounded-lg px-3 py-1 shadow-ring" onClick={() => setDraft(null)}>
              Huỷ
            </button>
          </div>
        </div>
      )}
      {note && <p className="text-xs text-muted">{note}</p>}
    </section>
  );
}
