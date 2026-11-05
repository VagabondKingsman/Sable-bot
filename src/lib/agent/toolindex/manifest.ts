/**
 * Benign tool catalog for PATH scan + install *proposals* (never auto-run).
 * No RE/pentest-specific installers (jadx/frida/nmap/…) in this pack.
 */
export type ToolManifestEntry = {
  id: string;
  binary: string;
  purpose: string;
  /** Exact install command proposals by OS id. */
  install: Partial<Record<"debian" | "macos" | "unknown", string>>;
};

export const BENIGN_TOOLS: ToolManifestEntry[] = [
  {
    id: "git",
    binary: "git",
    purpose: "Version control for own repos",
    install: { debian: "sudo apt-get update && sudo apt-get install -y git", macos: "brew install git" },
  },
  {
    id: "curl",
    binary: "curl",
    purpose: "HTTP client",
    install: { debian: "sudo apt-get update && sudo apt-get install -y curl", macos: "brew install curl" },
  },
  {
    id: "jq",
    binary: "jq",
    purpose: "JSON processor",
    install: { debian: "sudo apt-get update && sudo apt-get install -y jq", macos: "brew install jq" },
  },
  {
    id: "rg",
    binary: "rg",
    purpose: "ripgrep code search",
    install: {
      debian: "sudo apt-get update && sudo apt-get install -y ripgrep",
      macos: "brew install ripgrep",
    },
  },
  {
    id: "python3",
    binary: "python3",
    purpose: "Python runtime",
    install: { debian: "sudo apt-get update && sudo apt-get install -y python3", macos: "brew install python" },
  },
  {
    id: "node",
    binary: "node",
    purpose: "Node.js runtime",
    install: { debian: "sudo apt-get update && sudo apt-get install -y nodejs", macos: "brew install node" },
  },
  {
    id: "ffmpeg",
    binary: "ffmpeg",
    purpose: "Media convert (optional)",
    install: { debian: "sudo apt-get update && sudo apt-get install -y ffmpeg", macos: "brew install ffmpeg" },
  },
];
