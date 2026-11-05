import { GROK_MODELS } from "./provider.ts";

/** Default picker list when the server has not reported its models yet. */
export const MODELS: readonly string[] = GROK_MODELS;

/** Any model id the configured OpenAI-compatible endpoint(s) accept. */
export type ModelId = string;

export type ChatRole = "user" | "assistant";

export type Media = { type: "image" | "video"; src: string };

export type StepKind = "think" | "web" | "x" | "code" | "image" | "tool";

export type TraceStep = {
  id: string;
  kind: StepKind;
  label: string;
  detail?: string;
  state?: "run" | "done";
  sources?: string[];
  /** Id of the spawn_agent step this step belongs to (sub-agent trace, shown nested). */
  parent?: string;
};

/** A write a tool asked to make; the user approves or rejects it in the UI. */
export type ApprovalRequest = {
  id: string;
  tool: string;
  summary: string;
  preview?: string;
  state: "pending" | "approved" | "rejected" | "expired";
};

export type ChatMessage = {
  id: string;
  approvals?: ApprovalRequest[];
  role: ChatRole;
  content: string;
  status?: string;
  notice?: string;
  media?: Media;
  steps?: TraceStep[];
  citations?: string[];
  startedAt?: number;
  finishedAt?: number;
};

export type Thread = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  /** "Don't remember this chat": Sable learns nothing from it. */
  noMemory?: boolean;
};

export type ToolFlags = {
  /** xAI server-side tools (Responses API on an xAI host only). */
  web: boolean;
  x: boolean;
  code: boolean;
  image: boolean;
  /** Sable-run function tools (any provider): workspace files and HTTP fetch. */
  files?: boolean;
  fetch?: boolean;
  /** Learned-memory tools; set by the server (memory on), never trusted from the client. */
  learned?: boolean;
  /** spawn_agent; set by the server (SABLE_SPAWN), never trusted from the client. */
  agents?: boolean;
  /** load_skill (server-set; SABLE_SKILLS=0 kills it). */
  skills?: boolean;
  /** shell_run (server-set; SABLE_SHELL=0 kills it). Always needs approval. */
  shell?: boolean;
  /** browser tool (server-set; SABLE_BROWSER=0 kills it). */
  browser?: boolean;
};

export const IMAGE_MODELS = ["grok-imagine-image-2.0", "grok-imagine-image-quality", "grok-imagine-image"] as const;
export const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const IMAGE_RESOLUTIONS = ["1k", "2k"] as const;
export const VIDEO_SECONDS = [6, 10] as const;

export const EFFORTS = [
  { id: "low", label: "Thấp" },
  { id: "medium", label: "Vừa" },
  { id: "high", label: "Cao" },
  { id: "xhigh", label: "Sâu" },
] as const;

export type Effort = (typeof EFFORTS)[number]["id"];
export type ImageModel = (typeof IMAGE_MODELS)[number];
export type AspectRatio = (typeof ASPECTS)[number];
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];
export type VideoSeconds = (typeof VIDEO_SECONDS)[number];

export type AgentSettings = {
  model: ModelId;
  effort: Effort;
  instructions: string;
  memory: string;
  imageModel: ImageModel;
  imageAspect: AspectRatio;
  imageResolution: ImageResolution;
  videoAspect: AspectRatio;
  videoSeconds: VideoSeconds;
  enterToSend: boolean;
} & ToolFlags;

export type ChatRequest = {
  model: ModelId;
  effort: Effort;
  instructions: string;
  memory: string;
  messages: { role: ChatRole; content: string }[];
  tools: ToolFlags;
  /** false = "don't remember this chat": nothing is learned from it (memories may still be used). */
  remember?: boolean;
  /** Thread id, only as a source reference for learned memories. */
  threadId?: string;
};

export const DEFAULT_INSTRUCTIONS = `You are Sable, the agent on this desk. One voice for the whole thread. Reply in the language the user is using.

Do the work. Short when the ask is small. When they want a build, a calculation, or a researched answer, finish it.

Tools enabled this turn are listed after these instructions. Use one when the job needs it:
- Web search for facts that change, or that you should cite.
- X search for posts and conversations on X.
- Code interpreter when a number, table, plot, or check should be computed. Run it, then answer from its output. Do not estimate.
- Image generation only when they asked for a picture.

Do not invent tool results, citations, or a run you did not get back.

Build. If they ask for an app, page, game, or tool with a UI and were vague, pick one concrete product and name that assumption in one line.
Return one self-contained HTML file. CSS and JS inside the file. No CDN. Put the entire file in one markdown fence tagged html. One sentence before the fence. Nothing after it. A later change returns the whole file.
A script with no UI goes in one fence with the language tag. No empty function where the real logic belongs.
You cannot see their machine or edit their files. They copy what you return. This desk previews HTML fences.

The memory block is facts the user wrote. Treat it as true. Sable also learns lasting facts from conversations on its own; when the user asks you to remember or forget something, use memory_save / memory_forget if they are listed, otherwise say Sable will pick it up.

/raw means only the artifact. /build means the build rules. /chat means just answer.`;

export const DEFAULT_SETTINGS: AgentSettings = {
  model: "grok-4.7",
  effort: "high",
  instructions: DEFAULT_INSTRUCTIONS,
  memory: "",
  web: true,
  x: false,
  code: true,
  image: false,
  files: true,
  fetch: true,
  imageModel: "grok-imagine-image-2.0",
  imageAspect: "1:1",
  imageResolution: "1k",
  videoAspect: "16:9",
  videoSeconds: 6,
  enterToSend: true,
};
