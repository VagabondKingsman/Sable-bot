/**
 * Tool contracts. Pure types: one schema per tool, rendered per provider by
 * `format.ts`, executed by `execute.ts`, dispatched by `../loop.ts`.
 */
import type { StepKind } from "../types.ts";

export type JsonSchema = {
  type: "object";
  properties: Record<string, JsonProp>;
  required?: string[];
  additionalProperties?: false;
};

export type JsonProp = {
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};

/** "memory" = Sable's own learned-memory file (not the workspace, never the outside world). */
export type ToolRisk = "read" | "write" | "network" | "memory" | "agent";

export type ToolMode = "interactive" | "background";

export type ApprovalAsk = {
  tool: string;
  summary: string;
  preview?: string;
  /** W3: same-origin screenshot URL shown on the card (desktop actions). */
  image?: string;
  /** W3: target point on that screenshot (screen pixels) + its size. */
  mark?: { x: number; y: number; w: number; h: number };
  /** W3: called with the approval id once the card is shown / when it settles (not serialized). */
  onId?: (id: string) => void;
  onSettle?: (id: string, state: "approved" | "rejected" | "expired") => void;
};

export type ToolContext = {
  /** Root of the path-jailed workspace for this (single) user. */
  workspaceDir: string;
  signal: AbortSignal;
  mode: ToolMode;
  /** Resolves true when the user approved. Absent → write tools are refused. */
  approve?: (ask: ApprovalAsk) => Promise<boolean>;
  /** Learned memory, only when memory is on for this turn. Absent → memory tools refuse. */
  memory?: MemoryAccess;
  /** Trace id of the tool step being run (set by the loop). */
  stepId?: string;
  /** Runs a sub-agent; only the top-level turn has one (depth limit 1). */
  spawn?: SpawnFn;
  /** Skill runtime for load_skill (absent → refused). */
  skills?: { load(name: string): string | null; names(): string[] };
  /** Active owner-approved scope id for ACT tools (ScopeGate). */
  scopeId?: string | null;
  /** Server-side ScopeGate; when set, tools with requiresScope must pass. */
  assertScope?: (tool: string, requiresScope: boolean) => { ok: true } | { ok: false; reason: string };
  /** W2a: who started the chain this call belongs to. */
  initiator?: import("../audit/types.ts").Initiator;
  /** W2a: audit sink for side-effecting calls (non-read tools). */
  audit?: (entry: { tool: string; risk: ToolRisk; summary: string; ok: boolean; stepId?: string; initiator: import("../audit/types.ts").Initiator; reason?: string }) => void;
};

/** Builtin research|writer|coder, or a custom profile id from Settings → Profiles. */
export type SpawnProfile = string;
export type SpawnFn = (req: { task: string; profile: SpawnProfile; context?: string }, ctx: ToolContext) => Promise<ToolResult>;

export type MemoryAccess = {
  /** May save (false for background runs and "don't remember this chat"). */
  canWrite: boolean;
  recall(query: string, limit: number): { id: string; kind: string; text: string; eventDate?: string }[];
  save(text: string, kind: "profile" | "journal", eventDate?: string): { status: "added" | "merged" | "skipped"; text?: string };
  forget(query: string): string[];
};

export type ToolResult = {
  ok: boolean;
  /** Text handed back to the model (clipped to maxOutput). */
  output: string;
  /** Shown in the trace UI. */
  detail?: string;
  sources?: string[];
};

export type Args = Record<string, unknown>;

/** A tool Sable runs itself (any provider that supports function calling). */
export interface FunctionTool<A extends Args = Args> {
  kind: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: ToolRisk;
  timeoutMs: number;
  maxOutput: number;
  /** Ask the user before running (write tools). */
  needsApproval?: boolean;
  /** When true, ScopeGate must allow ACT (declared target). Background never bypasses. */
  requiresScope?: boolean;
  /** Short trace label, e.g. "fs_read · notes.md". */
  label(args: A): string;
  /** Approval card text for needsApproval tools. */
  describe?(args: A): ApprovalAsk;
  /** Optional cheap validation run before the approval gate; return an error string to refuse. */
  check?(args: A, ctx: ToolContext): Promise<string | null>;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/** A tool the provider runs server-side (xAI Responses only). */
export interface ServerTool {
  kind: "server";
  name: string;
  description: string;
  /** `{ type }` sent in the Responses `tools` array. */
  responsesType: string;
  trace: StepKind;
}

export type ToolDef = FunctionTool<any> | ServerTool;

/** A completed function call from the model (arguments fully accumulated). */
export type ToolCall = { id: string; name: string; args: string };
