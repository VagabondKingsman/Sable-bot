/** W2 observability: one normalized timeline per chat turn, background job or planner task. */

export type TraceSource = "chat" | "job" | "plan";

export type TraceEventType = "tool" | "search" | "think" | "subagent" | "approval" | "plan_step" | "notice" | "model";

export type TraceEvent = {
  id: string;
  type: TraceEventType;
  label: string;
  /** Function tool name when known (filter key). */
  tool?: string;
  state: string;
  /** Epoch ms; absent on records made before W2 (shown in order only). */
  at?: number;
  ms?: number;
  /** Parent event id (sub-agent steps nest under their spawn_agent step). */
  parent?: string;
  detail?: string;
  ok?: boolean;
};

export type TraceStats = {
  events: number;
  toolCalls: number;
  approvals: number;
  approvalsPending: number;
  subAgents: number;
  errors: number;
  /** tool name → call count */
  tools: Record<string, number>;
  /** Sum of known step latencies. */
  toolMs: number;
};

export type Trace = {
  /** `<source>.<id>` (chat: `chat.<threadId>.<messageId>`). */
  id: string;
  source: TraceSource;
  sourceId: string;
  title: string;
  status: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  /** Last change (used to skip rewriting the archive). */
  updatedAt: number;
  events: TraceEvent[];
  stats: TraceStats;
};

export type TraceSummary = Omit<Trace, "events">;

export const TRACE_SCHEMA = "sable.trace.v1";

export type TraceExport = {
  schema: typeof TRACE_SCHEMA;
  exportedAt: number;
  trace: Trace;
};
