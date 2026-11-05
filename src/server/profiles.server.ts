import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "@/lib/agent/jobs/db";
import {
  deleteProfile,
  mergeState,
  profilesOn,
  setActive,
  upsertProfile,
  type ProfilesState,
} from "@/lib/agent/profiles";
import { dataDir } from "@/server/paths";

const KEY = "__sable_profiles__";
type Scope = { [KEY]?: ProfilesState };
const scope = () => globalThis as unknown as Scope;

function file() {
  return path.join(dataDir(), "profiles.json");
}

export function loadProfiles(): ProfilesState {
  if (!profilesOn()) return mergeState(null);
  const cached = scope()[KEY];
  if (cached) return cached;
  let saved: unknown = null;
  try {
    saved = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      /* quarantine handled by starting clean */
    }
  }
  const state = mergeState(saved);
  scope()[KEY] = state;
  return state;
}

function persist(state: ProfilesState) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeAtomic(file(), JSON.stringify({ activeId: state.activeId, profiles: state.profiles }, null, 2));
  scope()[KEY] = state;
}

export function profilesStatus() {
  const state = loadProfiles();
  return {
    enabled: profilesOn(),
    activeId: state.activeId,
    profiles: state.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      builtin: Boolean(p.builtin),
      model: p.model,
      tools: p.tools,
      spawnTools: p.spawnTools,
      instructions: p.instructions,
      updatedAt: p.updatedAt,
    })),
  };
}

export function saveProfile(input: unknown) {
  if (!profilesOn()) return { ok: false as const, message: "Profile đang tắt (SABLE_PROFILES=0)." };
  const cur = loadProfiles();
  const next = upsertProfile(cur, input);
  if (!next.ok) return { ok: false as const, message: next.error };
  persist(next.state);
  return { ok: true as const, state: profilesStatus() };
}

export function removeProfile(id: string) {
  if (!profilesOn()) return { ok: false as const, message: "Profile đang tắt (SABLE_PROFILES=0)." };
  const next = deleteProfile(loadProfiles(), id);
  if (!next.ok) return { ok: false as const, message: next.error };
  persist(next.state);
  return { ok: true as const, state: profilesStatus() };
}

export function activateProfile(id: string) {
  if (!profilesOn()) return { ok: false as const, message: "Profile đang tắt (SABLE_PROFILES=0)." };
  const next = setActive(loadProfiles(), id);
  if (!next.ok) return { ok: false as const, message: next.error };
  persist(next.state);
  return { ok: true as const, state: profilesStatus(), profile: next.state.profiles.find((p) => p.id === id)! };
}

/** Test hook. */
export function resetProfilesCache() {
  scope()[KEY] = undefined;
}
