import { useEffect, useState } from "react";
import { withPrefix } from "@/lib/agent/client";

type Row = { name: string; description: string; tools: string[]; size: number };
type Draft = { name: string; description: string; tools: string; body: string; editing: boolean };
const EMPTY: Draft = { name: "", description: "", tools: "", body: "", editing: false };

/** Settings section: list, create, edit and delete skills (skills/<name>/SKILL.md). */
export function SkillsPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState("");

  async function refresh() {
    try {
      const res = await fetch(withPrefix("/api/skills"), { cache: "no-store" });
      const data = (await res.json()) as { enabled: boolean; skills: Row[] };
      setRows(data.skills ?? []);
      setEnabled(data.enabled);
    } catch {
      setNote("Không tải được danh sách skill.");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function post(body: unknown) {
    const res = await fetch(withPrefix("/api/skills"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new Error(data.message || `Lỗi ${res.status}`);
  }

  async function edit(name: string) {
    const res = await fetch(`${withPrefix("/api/skills")}?name=${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!res.ok) return setNote("Không mở được skill.");
    const s = (await res.json()) as { name: string; description: string; tools: string[]; body: string };
    setDraft({ name: s.name, description: s.description, tools: s.tools.join(", "), body: s.body, editing: true });
  }

  async function save() {
    if (!draft) return;
    try {
      await post({ action: "save", skill: { name: draft.name.trim(), description: draft.description, tools: draft.tools, body: draft.body } });
      setNote(`Đã lưu skill ${draft.name.trim()}.`);
      setDraft(null);
      await refresh();
    } catch (error) {
      setNote(`Không lưu được: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`Xóa skill ${name}?`)) return;
    try {
      await post({ action: "delete", name });
      setNote(`Đã xóa skill ${name}.`);
      await refresh();
    } catch (error) {
      setNote(`Không xóa được: ${error instanceof Error ? error.message : error}`);
    }
  }

  const field = "w-full rounded-lg bg-surface px-2 py-1.5 text-sm shadow-ring";
  return (
    <section aria-label="Skill" className="grid gap-2 rounded-xl bg-bg p-3 text-sm shadow-ring">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Skill</span>
        {enabled ? (
          <button type="button" className="rounded-lg px-3 py-1 shadow-ring hover:bg-surface" onClick={() => setDraft({ ...EMPTY })}>
            Thêm skill
          </button>
        ) : (
          <span className="text-xs text-muted">Đang tắt (SABLE_SKILLS=0)</span>
        )}
      </div>
      <p className="text-xs text-muted">Skill là chỉ dẫn mà Sable tự nạp khi cần (load_skill). Skill không bật thêm công cụ nào.</p>
      <ul className="grid gap-1" aria-label="Danh sách skill">
        {rows.map((r) => (
          <li key={r.name} className="flex items-start justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-surface" data-skill={r.name}>
            <div className="min-w-0">
              <div className="font-mono text-xs">{r.name}</div>
              <div className="text-xs text-muted">{r.description}</div>
              {r.tools.length > 0 && <div className="text-[11px] text-muted">Công cụ: {r.tools.join(", ")}</div>}
            </div>
            {enabled && (
              <div className="flex shrink-0 gap-1">
                <button type="button" className="rounded px-2 py-0.5 text-xs shadow-ring" aria-label={`Sửa skill ${r.name}`} onClick={() => void edit(r.name)}>
                  Sửa
                </button>
                <button type="button" className="rounded px-2 py-0.5 text-xs shadow-ring" aria-label={`Xóa skill ${r.name}`} onClick={() => void remove(r.name)}>
                  Xóa
                </button>
              </div>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="text-xs text-muted">Chưa có skill.</li>}
      </ul>
      {draft && (
        <form
          aria-label="Soạn skill"
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input className={field} aria-label="Tên skill" placeholder="ten-skill" value={draft.name} disabled={draft.editing} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className={field} aria-label="Mô tả skill" placeholder="Mô tả ngắn (hiện trong danh mục)" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <input className={field} aria-label="Công cụ gợi ý" placeholder="web_search, fs_read" value={draft.tools} onChange={(e) => setDraft({ ...draft, tools: e.target.value })} />
          <textarea className={`${field} min-h-32 font-mono text-xs`} aria-label="Nội dung skill" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <div className="flex gap-2">
            <button type="submit" className="rounded-lg bg-fg px-3 py-1.5 text-bg">Lưu skill</button>
            <button type="button" className="rounded-lg px-3 py-1.5 shadow-ring" onClick={() => setDraft(null)}>Hủy</button>
          </div>
        </form>
      )}
      {note && <p className="text-xs" role="status">{note}</p>}
    </section>
  );
}
