/** Env knobs for spawn_agent; the runner itself is src/lib/agent/spawn.ts. */
import { createSpawner as create } from "@/lib/agent/spawn";
import type { ClientEvent } from "@/lib/agent/harness";
import { spawnToolsFor } from "@/lib/agent/profiles";
import type { ToolDef } from "@/lib/agent/tools/types";
import type { PreparedTurn } from "@/server/chat.server";
import { loadProfiles } from "@/server/profiles.server";

export const spawnOn = () => (process.env.SABLE_SPAWN ?? "1").trim() !== "0";

function num(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
}

export function spawnLimits() {
  return {
    maxChildren: Math.round(num("SABLE_SPAWN_MAX_CHILDREN", 3, 1, 6)),
    maxSteps: Math.round(num("SABLE_SPAWN_MAX_STEPS", 6, 1, 10)),
    timeoutMs: Math.round(num("SABLE_SPAWN_TIMEOUT_S", 180, 20, 600) * 1000),
  };
}

export function createSpawner(turn: PreparedTurn, active: ToolDef[], emit: (event: ClientEvent) => void) {
  return create(turn, active, emit, spawnLimits(), (id) => {
    try {
      return spawnToolsFor(loadProfiles(), id);
    } catch {
      return null;
    }
  });
}
