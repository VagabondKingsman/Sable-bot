/** W2c: canvas share-link singleton + public-origin helper. */
import { ShareStore } from "@/lib/agent/canvas/shares";
import { dataDir } from "@/server/paths";

const KEY = Symbol.for("sable.shares.v1");
type G = typeof globalThis & { [KEY]?: { dir: string; store: ShareStore } };

export function shareStore(): ShareStore {
  const g = globalThis as G;
  const dir = dataDir();
  if (!g[KEY] || g[KEY].dir !== dir) g[KEY] = { dir, store: new ShareStore(dir) };
  return g[KEY].store;
}

/** Public base for share URLs: SABLE_SHARE_BASE, else the first trusted origin, else the request origin. */
export function shareBase(request: Request): string {
  const raw = (process.env.SABLE_SHARE_BASE || (process.env.SABLE_TRUSTED_ORIGINS ?? "").split(",")[0] || "").trim();
  try {
    if (raw) return new URL(raw).origin;
  } catch {
    /* fall through */
  }
  return new URL(request.url).origin;
}
