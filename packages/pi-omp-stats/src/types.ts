/**
 * @fileoverview Inlined type shapes for pi-omp-stats.
 *
 * This package is self-contained: it imports nothing from any pi package at
 * runtime (Diff 2 of the port). The few shapes omp-stats imports from
 * `omp pi-ai` are inlined here as local TypeScript interfaces, trimmed
 * to exactly the fields the parser and aggregator read from session JSONL.
 *
 * Ported from `omp-stats` (MIT, © Can Boluk); the `Usage`,
 * `AssistantMessage`, `ToolCall`, and `ToolResultMessage` shapes mirror the
 * ones in `earendil-works pi-ai` / `omp pi-ai` so the same session
 * JSONL parses identically across forks.
 */

/* -------------------------------------------------------------------------- */
/* Inlined pi-ai shapes (the only ones the parser touches)                    */
/* -------------------------------------------------------------------------- */

/** Cost breakdown reported on a single assistant request. */
export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Token usage for one assistant request. Mirrors `Usage` in pi-ai. The
 * `reasoning` and `orchestration` fields are emitted by some forks (notably
 * earendil-works pi records `reasoning`) and are ignored by aggregation —
 * kept here only so JSON.parse rows type-check when introspected.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Premium/priority request count. earendil-works pi does not emit
   * service-tier changes, so this is always 0 in the port (Diff 3). */
  premiumRequests?: number;
  /** Reasoning-token count (earendil-works pi). Ignored by aggregation. */
  reasoning?: number;
  cost: UsageCost;
  /** Orchestration sub-usage some forks record. Ignored by aggregation. */
  orchestration?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/**
 * Stop reason for an assistant turn. The port is lenient: any unrecognised
 * string is carried through verbatim (the `(string & {})` union) so foreign
 * forks don't crash the parser. Observed earendil-works values: `stop`,
 * `toolUse`, `error`, `aborted`.
 */
export type StopReason =
  "stop" | "toolUse" | "error" | "aborted" | "length" | "content_filter" | (string & {});

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

/** Image content block — shape kept loose; not parsed by the stats layer. */
export interface ImageBlock {
  type: "image";
  source: unknown;
}

export type ContentBlock =
  TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock | { type: string; [k: string]: unknown };

/** An assistant message as recorded in session JSONL. */
export interface AssistantMessage {
  role: "assistant";
  content?: ContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: StopReason;
  /** Unix milliseconds. Falls back to the entry's ISO timestamp. */
  timestamp?: number;
  /** Request duration in ms (not emitted by earendil-works pi as of this port). */
  duration?: number;
  /** Time-to-first-token in ms (not emitted by earendil-works pi as of this port). */
  ttft?: number;
  errorMessage?: string | null;
  responseId?: string;
  rawStopReason?: string;
}

/** A user prompt as recorded in session JSONL. */
export interface UserMessage {
  role: "user";
  content?: unknown;
  /** Harness-synthesised prompts (e.g. hook injections) are skipped. */
  synthetic?: boolean;
  timestamp?: number;
}

/** A tool result fed back into context. */
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
  isError?: boolean;
}

export type AgentMessage = AssistantMessage | UserMessage | ToolResultMessage;

/* -------------------------------------------------------------------------- */
/* Session JSONL entry types (ported from omp-stats types.ts)                 */
/* -------------------------------------------------------------------------- */

export interface SessionHeader {
  type: "session";
  version?: number; // v1 sessions don't carry this
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  title?: string;
}

export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
}

/** Any other entry type the session format emits (model_change, compaction, …). */
export interface SessionOtherEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [k: string]: unknown;
}

export type SessionEntry = SessionHeader | SessionMessageEntry | SessionOtherEntry;

/* -------------------------------------------------------------------------- */
/* Extracted stats (ported from omp-stats types.ts)                           */
/* -------------------------------------------------------------------------- */

/** Which agent produced a message. The port collapses to `"main"` for v1
 * (Diff 3): earendil-works pi lays transcripts out flat, so the omp
 * path-depth classification does not apply. Kept as a union for shape
 * compatibility with omp's `AgentTypeStats`. */
export type AgentType = "main" | "subagent" | "advisor";

/**
 * Extracted stats from an assistant message.
 *
 * Session JSONL on disk is not guaranteed to match the current
 * `AssistantMessage` shape: crash-truncated turns, sessions written by older
 * versions, and foreign producers all flow through the parser. Every field
 * returned here feeds a NOT NULL column in the stats DB, so malformed entries
 * are coerced (missing `stopReason`, token counts, `timestamp`) or skipped
 * (missing `model`/`provider`/`api`/`usage`) instead of crashing the whole
 * sync with a constraint violation.
 */
export interface MessageStats {
  id?: number;
  sessionFile: string;
  entryId: string;
  folder: string;
  model: string;
  provider: string;
  api: string;
  timestamp: number;
  duration: number | null;
  ttft: number | null;
  stopReason: StopReason;
  errorMessage: string | null;
  usage: Usage;
  agentType: AgentType;
}

/** Full details of a request, including the raw session entry. */
export interface RequestDetails extends MessageStats {
  messages: unknown[];
  output: unknown;
}

/**
 * Behavioral stats extracted from a single user message (ported verbatim —
 * pure string analysis, no omp deps; see `user-metrics.ts`).
 */
export interface UserMessageStats {
  id?: number;
  sessionFile: string;
  entryId: string;
  folder: string;
  timestamp: number;
  model: string | null;
  provider: string | null;
  chars: number;
  words: number;
  yelling: number;
  profanity: number;
  anguish: number;
  negation: number;
  repetition: number;
  blame: number;
}

/** Link emitted when an assistant message's parentId points to a user message
 * parsed in an earlier incremental sync pass. */
export interface UserMessageLink {
  sessionFile: string;
  entryId: string;
  model: string;
  provider: string;
}

/**
 * One tool call extracted from an assistant message's `toolCall` content
 * blocks. `callsInTurn` records how many calls that assistant turn contained
 * so aggregation can split the turn's real provider usage evenly per call.
 */
export interface ToolCallStats {
  sessionFile: string;
  entryId: string;
  toolCallId: string;
  folder: string;
  toolName: string;
  model: string;
  provider: string;
  timestamp: number;
  agentType: AgentType;
  callsInTurn: number;
  argsChars: number;
}

/** Result linkage for a `toolResult` entry, applied as an UPDATE on the call. */
export interface ToolResultLink {
  sessionFile: string;
  toolCallId: string;
  resultChars: number;
  isError: boolean;
}

export interface ParseSessionResult {
  stats: MessageStats[];
  userStats: UserMessageStats[];
  userLinks: UserMessageLink[];
  toolCalls: ToolCallStats[];
  toolResults: ToolResultLink[];
  /** Best-known folder/cwd for this session (header cwd, else lossy path decode). */
  folder?: string;
  newOffset: number;
}

// Re-export the shared aggregation shapes so callers can import everything from ./types (mirrors omp).
export * from "./shared-types.js";
