/** xAI-hosted tools. Pure data (safe to import from browser code). */
import type { ServerTool } from "./types.ts";

export const SERVER_TOOLS: ServerTool[] = [
  { kind: "server", name: "web_search", responsesType: "web_search", trace: "web", description: "Search the web (xAI server tool)." },
  { kind: "server", name: "x_search", responsesType: "x_search", trace: "x", description: "Search posts on X (xAI server tool)." },
  { kind: "server", name: "code_interpreter", responsesType: "code_interpreter", trace: "code", description: "Run Python in xAI's sandbox." },
  { kind: "server", name: "image_generation", responsesType: "image_generation", trace: "image", description: "Generate an image (xAI only)." },
];
