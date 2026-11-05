import path from "node:path";

export function workspaceDir() {
  return process.env.SABLE_WORKSPACE?.trim() || "/workspace/sable-workspace";
}

/** Data dir: outside the web root and never inside the fs-tool jail. */
export function dataDir() {
  const fallback = "/workspace/sable-data";
  const chosen = path.resolve(process.env.SABLE_DATA_DIR?.trim() || fallback);
  const jail = path.resolve(workspaceDir());
  const rel = path.relative(jail, chosen);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return inside ? fallback : chosen;
}

