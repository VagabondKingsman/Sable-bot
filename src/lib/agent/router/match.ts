/**
 * 3-axis skill router. JSON config is the source of truth (reverse-skill pattern).
 * Kill switch: SABLE_ROUTER=0.
 */
import fs from "node:fs";
import type { RouteHit, RoutingConfig } from "./types.ts";

export function routerOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SABLE_ROUTER ?? "1").trim() !== "0";
}

export function loadRoutingConfig(file: string): RoutingConfig {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RoutingConfig;
  if (!raw || raw.schemaVersion !== 1 || !raw.routes || !Array.isArray(raw.priority))
    throw new Error("invalid routing.json");
  return raw;
}

export function classify(hint: string, config: RoutingConfig): RouteHit {
  const text = (hint || "").trim();
  const fallbackId = config.meta.fallbackId || "G0";
  for (const id of config.priority) {
    if (id === fallbackId) continue;
    const route = config.routes[id];
    if (!route) continue;
    for (const kw of route.keywords || []) {
      try {
        if (new RegExp(kw.must, "iu").test(text)) {
          return {
            routeId: id,
            label: route.label,
            skill: route.skill,
            axes: route.axes,
            rationale: `matched ${id} (${route.label}) via /${kw.must}/`,
          };
        }
      } catch {
        /* bad regex in config — skip */
      }
    }
  }
  const fb = config.routes[fallbackId] || {
    label: "General",
    skill: "research-summary",
    axes: { targetType: "general", intent: "assist", toolchain: "chat" },
    keywords: [],
  };
  return {
    routeId: fallbackId,
    label: fb.label,
    skill: fb.skill,
    axes: fb.axes,
    rationale: `fallback ${fallbackId}`,
  };
}
