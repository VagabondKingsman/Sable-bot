// System-prompt presets: named prompts, apply/restore, per-model binding.
// UX inspiration only: https://github.com/YuJunZhiXue/dsh-purge (no code or prompts taken).
import { DEFAULT_INSTRUCTIONS } from "./types.ts";

export type PromptPreset = { id: string; name: string; body: string; updatedAt: number };

export type PresetState = {
  presets: PromptPreset[];
  /** Preset last loaded into the editor; null = text not tied to any preset. */
  activePresetId: string | null;
  /** modelId → presetId. */
  modelBindings: Record<string, string>;
};

export const DEFAULT_PRESET_ID = "default";
export const DEFAULT_PRESET_NAME = "Sable mặc định";
export const MIGRATED_PRESET_NAME = "Prompt của tôi";
export const MAX_PRESETS = 30;
export const MAX_PRESET_NAME = 60;
export const MAX_PRESET_BODY = 12_000;

const PHASE2_MEMORY_LINE =
  "The memory block is facts the user wrote. Treat it as true. You cannot edit that box. If a fact should stick, end with one line they can paste into memory.";
const PHASE2_DEFAULT = DEFAULT_INSTRUCTIONS.replace(/^The memory block is facts the user wrote\..*$/m, PHASE2_MEMORY_LINE);

/** Old baked-in prompts that should fall back to the current default. */
export function staleInstructions(text: string | undefined) {
  if (!text?.trim()) return true;
  if (text.includes("Luật thực thi") || text.includes("Game tooling is in scope")) return true;
  if (/NULLHAND|V\.I\.I\.B\.E|You are Grok Build/i.test(text)) return true;
  if (text.startsWith("Bạn là Sable, trợ lý riêng")) return true;
  if (text.startsWith("Bạn là Sable, builder")) return true;
  if (text.startsWith("Bạn là Sable, bot trên bàn")) return true;
  // The Phase 1–2 default (before learned memory): identical except its memory line.
  if (text.trim() === PHASE2_DEFAULT.trim()) return true;
  return false;
}

export function defaultPreset(now = 0): PromptPreset {
  return { id: DEFAULT_PRESET_ID, name: DEFAULT_PRESET_NAME, body: DEFAULT_INSTRUCTIONS, updatedAt: now };
}

export function isDefaultPreset(id: string | null | undefined) {
  return id === DEFAULT_PRESET_ID;
}

export function findPreset(state: Pick<PresetState, "presets">, id: string | null | undefined) {
  return id ? state.presets.find((preset) => preset.id === id) : undefined;
}

/** Editor text differs from the preset it was loaded from (or no preset is active). */
export function isDirty(state: PresetState, instructions: string) {
  const active = findPreset(state, state.activePresetId);
  return !active || active.body !== instructions;
}

export function modelsBoundTo(state: Pick<PresetState, "modelBindings">, presetId: string) {
  return Object.entries(state.modelBindings)
    .filter(([, id]) => id === presetId)
    .map(([model]) => model)
    .sort();
}

function cleanName(name: string, fallback: string) {
  const trimmed = name.replace(/\s+/g, " ").trim().slice(0, MAX_PRESET_NAME);
  return trimmed || fallback;
}

function cleanBody(body: string) {
  return body.slice(0, MAX_PRESET_BODY);
}

function isPreset(value: unknown): value is PromptPreset {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && !!item.id && typeof item.name === "string" && typeof item.body === "string";
}

/**
 * Build a valid preset state from whatever was persisted.
 * - The default preset always exists and always carries the current DEFAULT_INSTRUCTIONS
 *   (so a code update refreshes it).
 * - First run (no presets saved): non-default, non-stale instructions become "Prompt của tôi".
 * - Stale preset bodies are dropped; bindings to missing presets are dropped.
 */
export function migratePresets(
  saved: Partial<PresetState> | undefined,
  instructions: string,
  now = Date.now(),
  newId: () => string = () => crypto.randomUUID(),
): PresetState & { instructions: string } {
  const text = staleInstructions(instructions) ? DEFAULT_INSTRUCTIONS : instructions;
  const savedList = Array.isArray(saved?.presets) ? saved.presets.filter(isPreset) : null;

  const presets: PromptPreset[] = [defaultPreset(now)];
  let activePresetId: string | null = null;

  if (savedList === null) {
    if (text === DEFAULT_INSTRUCTIONS) activePresetId = DEFAULT_PRESET_ID;
    else {
      const mine: PromptPreset = { id: newId(), name: MIGRATED_PRESET_NAME, body: cleanBody(text), updatedAt: now };
      presets.push(mine);
      activePresetId = mine.id;
    }
  } else {
    const seen = new Set([DEFAULT_PRESET_ID]);
    for (const item of savedList) {
      if (seen.has(item.id) || staleInstructions(item.body) || presets.length >= MAX_PRESETS) continue;
      seen.add(item.id);
      presets.push({
        id: item.id,
        name: cleanName(item.name, MIGRATED_PRESET_NAME),
        body: cleanBody(item.body),
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now,
      });
    }
    const wanted = typeof saved?.activePresetId === "string" ? saved.activePresetId : null;
    activePresetId = wanted && presets.some((preset) => preset.id === wanted) ? wanted : null;
  }

  const modelBindings: Record<string, string> = {};
  for (const [model, id] of Object.entries(saved?.modelBindings ?? {})) {
    if (typeof id === "string" && presets.some((preset) => preset.id === id)) modelBindings[model] = id;
  }
  return { presets, activePresetId, modelBindings, instructions: text };
}

/** Load a preset into the editor. Unknown id → unchanged. */
export function applyPreset(state: PresetState, instructions: string, id: string) {
  const preset = findPreset(state, id);
  if (!preset) return { activePresetId: state.activePresetId, instructions };
  return { activePresetId: preset.id, instructions: preset.body };
}

/**
 * Create (no id) or update (id) a preset. The default preset is read-only:
 * saving to it creates a new preset instead. Returns the saved preset id.
 */
export function savePreset(
  state: PresetState,
  input: { id?: string; name: string; body: string },
  now = Date.now(),
  newId: () => string = () => crypto.randomUUID(),
): { state: PresetState; id: string } {
  const body = cleanBody(input.body);
  const existing = input.id && !isDefaultPreset(input.id) ? findPreset(state, input.id) : undefined;
  if (existing) {
    const updated = { ...existing, name: cleanName(input.name, existing.name), body, updatedAt: now };
    return {
      state: { ...state, presets: state.presets.map((preset) => (preset.id === existing.id ? updated : preset)), activePresetId: existing.id },
      id: existing.id,
    };
  }
  if (state.presets.length >= MAX_PRESETS) throw new Error(`Tối đa ${MAX_PRESETS} preset.`);
  const created: PromptPreset = { id: newId(), name: cleanName(input.name, `Preset ${state.presets.length}`), body, updatedAt: now };
  return { state: { ...state, presets: [...state.presets, created], activePresetId: created.id }, id: created.id };
}

/** Delete a custom preset; the default preset stays. Bindings to it are removed. */
export function deletePreset(state: PresetState, id: string): PresetState {
  if (isDefaultPreset(id) || !findPreset(state, id)) return state;
  const presets = state.presets.filter((preset) => preset.id !== id);
  const modelBindings = Object.fromEntries(Object.entries(state.modelBindings).filter(([, presetId]) => presetId !== id));
  return { presets, modelBindings, activePresetId: state.activePresetId === id ? null : state.activePresetId };
}

/** presetId null → unbind. Unknown preset → unchanged. */
export function bindPresetToModel(state: PresetState, modelId: string, presetId: string | null): PresetState {
  if (!modelId) return state;
  const modelBindings = { ...state.modelBindings };
  if (presetId === null) delete modelBindings[modelId];
  else if (findPreset(state, presetId)) modelBindings[modelId] = presetId;
  else return state;
  return { ...state, modelBindings };
}

/** On model switch: a bound model loads its preset; an unbound model keeps the current text. */
export function presetForModel(state: PresetState, instructions: string, modelId: string) {
  const id = state.modelBindings[modelId];
  if (!id) return null;
  const preset = findPreset(state, id);
  if (!preset) return null;
  if (state.activePresetId === preset.id && instructions === preset.body) return null;
  return { activePresetId: preset.id, instructions: preset.body };
}
