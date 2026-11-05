/**
 * Multi-agent profiles — named personas with instructions + preferred tools.
 * Built-ins mirror spawn profiles (research/writer/coder) plus the default Sable.
 * Custom profiles live in dataDir/profiles.json (server). Fresh Sable code.
 */
import { DEFAULT_INSTRUCTIONS, type ToolFlags } from "./types.ts";

export const MAX_PROFILES = 20;
export const MAX_PROFILE_NAME = 60;
export const MAX_PROFILE_INSTRUCTIONS = 12_000;
export const PROFILE_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;

export type AgentProfile = {
  id: string;
  name: string;
  instructions: string;
  /** Preferred ToolFlags (client chips). Missing keys = leave user preference. */
  tools: Partial<ToolFlags>;
  /** Function-tool names when this profile is used via spawn_agent. */
  spawnTools: string[];
  /** Optional model override hint (client may apply). */
  model?: string;
  builtin?: boolean;
  updatedAt: number;
};

export type ProfilesState = {
  activeId: string;
  profiles: AgentProfile[];
};

const FLAG_KEYS = ["web", "x", "code", "image", "files", "fetch", "shell", "browser"] as const;

export const BUILTIN_PROFILES: AgentProfile[] = [
  {
    id: "sable",
    name: "Sable",
    instructions: DEFAULT_INSTRUCTIONS,
    tools: {},
    spawnTools: [],
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "research",
    name: "Nghiên cứu",
    instructions:
      "You are Sable's research persona. Prefer web/fetch/read tools. Summarize with sources. Never write files unless the user explicitly asks.",
    tools: { web: true, x: true, fetch: true, files: true, code: false, image: false, shell: false, browser: false },
    spawnTools: ["web_search", "x_search", "http_fetch", "fs_list", "fs_read", "memory_recall"],
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "writer",
    name: "Viết",
    instructions:
      "You are Sable's writing persona. Draft and edit text carefully. Save to the workspace when asked (writes need approval). Prefer files over the web.",
    tools: { files: true, fetch: false, web: false, x: false, code: false, image: false, shell: false, browser: false },
    spawnTools: ["fs_list", "fs_read", "fs_write", "memory_recall"],
    builtin: true,
    updatedAt: 0,
  },
  {
    id: "coder",
    name: "Lập trình",
    instructions:
      "You are Sable's coding persona. Read and change code in the workspace (writes need approval). Explain diffs briefly. Use fetch only for docs/APIs the task needs.",
    tools: { files: true, fetch: true, code: true, web: false, x: false, image: false, shell: false, browser: false },
    spawnTools: ["fs_list", "fs_read", "fs_write", "http_fetch", "code_interpreter"],
    builtin: true,
    updatedAt: 0,
  },
];

export function profilesOn(env: Record<string, string | undefined> = process.env) {
  return (env.SABLE_PROFILES ?? "1").trim() !== "0";
}

export function defaultState(now = Date.now()): ProfilesState {
  return {
    activeId: "sable",
    profiles: BUILTIN_PROFILES.map((p) => ({ ...p, updatedAt: now })),
  };
}

export function findProfile(state: ProfilesState, id: string | null | undefined) {
  return id ? state.profiles.find((p) => p.id === id) : undefined;
}

export function sanitizeTools(raw: unknown): Partial<ToolFlags> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<ToolFlags> = {};
  const o = raw as Record<string, unknown>;
  for (const key of FLAG_KEYS) {
    if (typeof o[key] === "boolean") out[key] = o[key] as boolean;
  }
  return out;
}

export function sanitizeSpawnTools(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim().slice(0, 64);
    if (/^[a-z][a-z0-9_]{0,63}$/.test(name) && !out.includes(name)) out.push(name);
    if (out.length >= 24) break;
  }
  return out;
}

export function sanitizeProfile(raw: unknown, opts: { allowBuiltinEdit?: boolean } = {}): AgentProfile | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Profile không hợp lệ." };
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim().toLowerCase() : "";
  if (!PROFILE_ID_RE.test(id)) return { error: "Id profile: chữ thường, số, _- (1–40)." };
  if (BUILTIN_PROFILES.some((b) => b.id === id) && !opts.allowBuiltinEdit) {
    // Creating a custom with builtin id is refused; builtins are patched separately.
  }
  const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim().slice(0, MAX_PROFILE_NAME) : "";
  if (!name) return { error: "Thiếu tên profile." };
  const instructions = typeof o.instructions === "string" ? o.instructions.slice(0, MAX_PROFILE_INSTRUCTIONS) : "";
  if (!instructions.trim()) return { error: "Thiếu chỉ dẫn (instructions)." };
  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim().slice(0, 80) : undefined;
  return {
    id,
    name,
    instructions,
    tools: sanitizeTools(o.tools),
    spawnTools: sanitizeSpawnTools(o.spawnTools),
    model,
    builtin: Boolean(o.builtin),
    updatedAt: typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : Date.now(),
  };
}

/** Merge builtins with saved customs; drop corrupt customs; keep activeId valid. */
export function mergeState(saved: unknown, now = Date.now()): ProfilesState {
  const base = defaultState(now);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return base;
  const o = saved as Record<string, unknown>;
  const list = Array.isArray(o.profiles) ? o.profiles : [];
  const customs: AgentProfile[] = [];
  const seen = new Set(BUILTIN_PROFILES.map((b) => b.id));
  for (const item of list) {
    const parsed = sanitizeProfile(item, { allowBuiltinEdit: true });
    if ("error" in parsed) continue;
    if (parsed.builtin || BUILTIN_PROFILES.some((b) => b.id === parsed.id)) {
      // Allow overriding builtin name/instructions/tools from disk (still marked builtin).
      const idx = base.profiles.findIndex((p) => p.id === parsed.id);
      if (idx >= 0) {
        base.profiles[idx] = { ...parsed, builtin: true, id: parsed.id };
      }
      continue;
    }
    if (seen.has(parsed.id) || customs.length + base.profiles.length >= MAX_PROFILES) continue;
    seen.add(parsed.id);
    customs.push({ ...parsed, builtin: false });
  }
  const profiles = [...base.profiles, ...customs];
  const activeId = typeof o.activeId === "string" && profiles.some((p) => p.id === o.activeId) ? o.activeId : "sable";
  return { activeId, profiles };
}

export function upsertProfile(state: ProfilesState, input: unknown): { ok: true; state: ProfilesState } | { ok: false; error: string } {
  const parsed = sanitizeProfile(input);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const builtin = BUILTIN_PROFILES.some((b) => b.id === parsed.id);
  if (builtin) {
    // Update builtin fields (except id/builtin flag).
    return {
      ok: true,
      state: {
        ...state,
        profiles: state.profiles.map((p) =>
          p.id === parsed.id ? { ...parsed, builtin: true, updatedAt: Date.now() } : p,
        ),
      },
    };
  }
  const existing = state.profiles.find((p) => p.id === parsed.id);
  if (!existing && state.profiles.length >= MAX_PROFILES) return { ok: false, error: `Tối đa ${MAX_PROFILES} profile.` };
  const next = { ...parsed, builtin: false, updatedAt: Date.now() };
  return {
    ok: true,
    state: {
      ...state,
      profiles: existing ? state.profiles.map((p) => (p.id === next.id ? next : p)) : [...state.profiles, next],
    },
  };
}

export function deleteProfile(state: ProfilesState, id: string): { ok: true; state: ProfilesState } | { ok: false; error: string } {
  const target = state.profiles.find((p) => p.id === id);
  if (!target) return { ok: false, error: "Không tìm thấy profile." };
  if (target.builtin) return { ok: false, error: "Không xóa được profile có sẵn." };
  const profiles = state.profiles.filter((p) => p.id !== id);
  const activeId = state.activeId === id ? "sable" : state.activeId;
  return { ok: true, state: { activeId, profiles } };
}

export function setActive(state: ProfilesState, id: string): { ok: true; state: ProfilesState } | { ok: false; error: string } {
  if (!state.profiles.some((p) => p.id === id)) return { ok: false, error: "Không tìm thấy profile." };
  return { ok: true, state: { ...state, activeId: id } };
}

/** Resolve spawn tool allowlist for a profile id (builtin or custom). */
export function spawnToolsFor(state: ProfilesState, profileId: string): { tools: readonly string[]; brief: string } | null {
  const p = findProfile(state, profileId);
  if (!p) return null;
  if (!p.spawnTools.length && p.builtin) {
    // Fallback for builtins that somehow lost spawnTools
    const b = BUILTIN_PROFILES.find((x) => x.id === p.id);
    if (b?.spawnTools.length) return { tools: b.spawnTools, brief: p.instructions.slice(0, 240) };
  }
  if (!p.spawnTools.length) return null;
  return { tools: p.spawnTools, brief: p.instructions.slice(0, 240) };
}

export function applyProfileTools(current: ToolFlags, profile: AgentProfile): ToolFlags {
  return { ...current, ...profile.tools };
}
