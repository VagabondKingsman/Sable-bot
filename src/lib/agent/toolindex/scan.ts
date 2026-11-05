import { execFileSync } from "node:child_process";
import { BENIGN_TOOLS, type ToolManifestEntry } from "./manifest.ts";

export function toolIndexOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SABLE_TOOLINDEX ?? "1").trim() !== "0";
}

export type OsKind = "debian" | "macos" | "unknown";

export function detectOs(env: NodeJS.ProcessEnv = process.env): OsKind {
  if (env.SABLE_TOOLINDEX_OS === "debian" || env.SABLE_TOOLINDEX_OS === "macos") return env.SABLE_TOOLINDEX_OS;
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "debian";
  return "unknown";
}

export type ScanRow = {
  id: string;
  binary: string;
  purpose: string;
  available: boolean;
  path: string | null;
  version: string | null;
  installCommand: string | null;
};

function which(binary: string): string | null {
  try {
    const out = execFileSync("which", [binary], { encoding: "utf8", timeout: 3_000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function versionOf(binPath: string): string | null {
  for (const args of [["--version"], ["-version"], ["-v"]]) {
    try {
      const out = execFileSync(binPath, args, { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "pipe"] })
        .trim()
        .split("\n")[0];
      return out.slice(0, 120) || null;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function scanTools(
  manifest: ToolManifestEntry[] = BENIGN_TOOLS,
  os: OsKind = detectOs(),
): ScanRow[] {
  return manifest.map((entry) => {
    const found = which(entry.binary);
    return {
      id: entry.id,
      binary: entry.binary,
      purpose: entry.purpose,
      available: Boolean(found),
      path: found,
      version: found ? versionOf(found) : null,
      installCommand: found ? null : entry.install[os] || entry.install.debian || entry.install.unknown || null,
    };
  });
}

/** Propose installs for missing tools — never executes them. */
export function proposeInstalls(rows: ScanRow[]): { id: string; command: string }[] {
  return rows
    .filter((r) => !r.available && r.installCommand)
    .map((r) => ({ id: r.id, command: r.installCommand! }));
}
