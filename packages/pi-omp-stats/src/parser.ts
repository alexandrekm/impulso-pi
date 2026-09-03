/**
 * @fileoverview Session JSONL parser (Node port of omp-stats `parser.ts`).
 *
 * Reads pi session JSONL files and extracts assistant-message stats, tool
 * calls, tool-result links, user-message stats, and user-message links. The
 * parser is incremental (byte-offset tracked) and lenient on malformed lines
 * — a single bad JSON line never aborts a sync.
 *
 * Differences from the omp original (the port's four diffs):
 *  - **Diff 1 (Bun to Node):** `the omp file-read API` → `fs/promises.readFile`;
 *    `the omp stream API` + `readLines` → `node:readline`.
 *  - **Diff 2 (no pi imports):** `getSessionsDir` from `omp pi-utils` is
 *    replaced by a local {@link resolveSessionsDir} with env-var precedence.
 *    `isEnoent` is inlined. The `Usage`/`AssistantMessage`/`ToolCall`/
 *    `ToolResultMessage` shapes are inlined in `./types` (no `omp pi-ai`).
 *  - **Diff 3 (drop omp features):** service-tier / premium-request logic is
 *    removed (`premiumRequests` is always 0); `agentType` collapses to
 *    `"main"` for v1 with a TODO(port) marker.
 *
 * MIT, © Can Boluk (original omp-stats); ported for the impulso-pi package.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { computeUserMessageMetrics } from "./user-metrics.js";
import type {
  AgentMessage,
  AgentType,
  AssistantMessage,
  CompactionStats,
  ContentBlock,
  MemoryEventStats,
  MemoryKind,
  MessageStats,
  ParseSessionResult,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
  ToolCallStats,
  ToolResultLink,
  ToolResultMessage,
  Usage,
  UserMessageLink,
  UserMessageStats,
  SubagentRunStats,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* observational-memory custom-entry discriminators (impulso-pi addition)      */
/* -------------------------------------------------------------------------- */

/** `customType` values pi-observational-memory writes to session JSONL. */
const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
const OM_FOLDED = "om.folded";

/** Terminal records written by extensions/subagent-telemetry. */
const SUBAGENT_RUN_V1 = "impulso.subagent-run.v1";

/* -------------------------------------------------------------------------- */
/* Sessions dir resolution (Diff 2 — no pi imports)                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the sessions directory, first match wins:
 *  1. `PI_STATS_SESSIONS_DIR` (this package's own override)
 *  2. `PI_CODING_AGENT_SESSION_DIR` (pi's own session-dir override)
 *  3. `<PI_CODING_AGENT_DIR>/sessions` (when `PI_CODING_AGENT_DIR` is set)
 *  4. `~/.pi/agent/sessions` (default)
 *
 * A leading `~/` is expanded against `os.homedir()`. Pointing this at any
 * pi-lineage sessions dir via env makes the tool fork-agnostic.
 */
export function resolveSessionsDir(override?: string): string {
  const expand = (p: string): string =>
    p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

  if (override && override.trim()) return expand(override.trim());

  const env = process.env;
  if (env.PI_STATS_SESSIONS_DIR && env.PI_STATS_SESSIONS_DIR.trim()) {
    return expand(env.PI_STATS_SESSIONS_DIR.trim());
  }
  if (env.PI_CODING_AGENT_SESSION_DIR && env.PI_CODING_AGENT_SESSION_DIR.trim()) {
    return expand(env.PI_CODING_AGENT_SESSION_DIR.trim());
  }
  if (env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR.trim()) {
    return path.join(expand(env.PI_CODING_AGENT_DIR.trim()), "sessions");
  }
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

export interface SessionsSource {
  id: string;
  dir: string;
}

/**
 * Resolve every configured profile sessions directory. `PI_STATS_PROFILES_DIR`
 * enables the dashboard's all-profile mode; otherwise retain the legacy single
 * directory resolution above. Profile names are directory names, so a new ppi
 * profile becomes visible without changing the service configuration.
 */
export async function resolveSessionsSources(): Promise<SessionsSource[]> {
  const profilesDir = process.env.PI_STATS_PROFILES_DIR?.trim();
  if (!profilesDir) return [{ id: "default", dir: resolveSessionsDir() }];

  const root = profilesDir.startsWith("~/")
    ? path.join(os.homedir(), profilesDir.slice(2))
    : profilesDir;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ id: entry.name, dir: path.join(root, entry.name, "sessions") }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/** Resolve the stats (DB) directory: `PI_STATS_DIR` or `~/.pi/agent`. */
export function resolveStatsDir(): string {
  const env = process.env;
  if (env.PI_STATS_DIR && env.PI_STATS_DIR.trim()) {
    const p = env.PI_STATS_DIR.trim();
    return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

/* -------------------------------------------------------------------------- */
/* Lenient JSON-line parsing (ported verbatim — the byte-level walker)         */
/* -------------------------------------------------------------------------- */

const LF = 0x0a;
const CR = 0x0d;
const jsonLineDecoder = new TextDecoder();

function parseJsonLine(bytes: Uint8Array, start: number, end: number): SessionEntry | null {
  while (end > start && bytes[end - 1] === CR) end--;
  if (end <= start) return null;
  try {
    return JSON.parse(jsonLineDecoder.decode(bytes.subarray(start, end))) as SessionEntry;
  } catch {
    return null;
  }
}

/**
 * Walk every JSONL line in `bytes`, calling `visit` for each parseable entry.
 * Returns the byte offset just past the last fully-consumed line.
 *
 * Lenient by design (port the omp comment verbatim): a line that fails to
 * parse is skipped without aborting the walk, and a trailing partial line
 * (no newline before EOF — e.g. a write mid-flush) is left unparsed so the
 * next incremental sync can retry it from `read`.
 */
function visitSessionEntriesLenient(
  bytes: Uint8Array,
  visit: (entry: SessionEntry) => void,
): number {
  let cursor = 0;
  let read = 0;

  while (cursor < bytes.length) {
    const newline = bytes.indexOf(LF, cursor);
    const hasNewline = newline !== -1;
    const lineEnd = hasNewline ? newline : bytes.length;
    const entry = parseJsonLine(bytes, cursor, lineEnd);
    if (entry) {
      visit(entry);
      read = hasNewline ? newline + 1 : lineEnd;
    } else if (hasNewline) {
      read = newline + 1;
    } else {
      break;
    }
    cursor = hasNewline ? newline + 1 : lineEnd;
  }

  return read;
}

function parseSessionEntriesLenient(bytes: Uint8Array): { entries: SessionEntry[]; read: number } {
  const entries: SessionEntry[] = [];
  const read = visitSessionEntriesLenient(bytes, (entry) => entries.push(entry));
  return { entries, read };
}

/* -------------------------------------------------------------------------- */
/* Helpers (ported; service-tier machinery stripped — Diff 3)                  */
/* -------------------------------------------------------------------------- */

/**
 * Classify which agent produced a transcript from its path. earendil-works
 * pi lays session files out flat (`<project>/<file>.jsonl`) and does not nest
 * subagent/advisor transcripts the way omp does, so the port collapses every
 * transcript to `"main"` for v1.
 *
 * TODO(port): if earendil-works pi starts emitting nested subagent/advisor
 * transcripts, restore omp's path-depth + `__advisor.jsonl` classification
 * (see `classifyAgentType` in the omp original).
 */
function classifyAgentType(_sessionPath: string): AgentType {
  return "main";
}

/**
 * Extract the project folder from a session file's path. Session files live at
 * `<sessionsDir>/<projectDir>/<file>.jsonl`, where `<projectDir>` encodes the
 * cwd with `--` as the path separator (e.g. `--Users-foo-bar--` → `/Users/foo/bar/`).
 *
 * The port derives the project dir from `path.basename(path.dirname(...))`
 * rather than `path.relative(sessionsDir, ...)` so it does not need to know
 * the resolved sessions dir (and stays correct for nested transcripts). The
 * `--` → `/` transform is identical to omp's and works unchanged across forks.
 */
function extractFolderFromPath(sessionPath: string): string {
  const projectDir = path.basename(path.dirname(sessionPath));
  return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

function isAssistantMessage(entry: SessionEntry): entry is SessionMessageEntry {
  if (entry.type !== "message") return false;
  const msgEntry = entry as SessionMessageEntry;
  // Legacy sessions (pre-id tracking) recorded message entries without an
  // `id`. They're not linkable and would violate the messages.entry_id NOT
  // NULL constraint, so skip them at the parser boundary.
  if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
  return (msgEntry.message as AgentMessage)?.role === "assistant";
}

function isUserMessage(entry: SessionEntry): entry is SessionMessageEntry {
  if (entry.type !== "message") return false;
  const msgEntry = entry as SessionMessageEntry;
  if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
  return (msgEntry.message as AgentMessage)?.role === "user";
}

function isToolResultMessage(entry: SessionEntry): entry is SessionMessageEntry {
  if (entry.type !== "message") return false;
  return (entry as SessionMessageEntry).message?.role === "toolResult";
}

function isSessionHeader(entry: SessionEntry): entry is SessionHeader {
  return entry.type === "session";
}

/** The real cwd recorded in a session header, if present. */
function extractCwd(entry: SessionHeader): string | null {
  return typeof entry.cwd === "string" && entry.cwd.length > 0 ? entry.cwd : null;
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

function extractUserStats(
  sessionFile: string,
  folder: string,
  entry: SessionMessageEntry,
): UserMessageStats | null {
  const msg = entry.message as { role: "user"; content?: unknown; synthetic?: boolean };
  if (msg.role !== "user" || msg.synthetic) return null;
  const text = extractUserText(msg.content);
  if (!text.trim()) return null;
  const metrics = computeUserMessageMetrics(text);
  const ts = Date.parse(entry.timestamp);
  return {
    sessionFile,
    entryId: entry.id,
    folder,
    timestamp: Number.isFinite(ts) ? ts : 0,
    model: null,
    provider: null,
    chars: metrics.chars,
    words: metrics.words,
    yelling: metrics.yelling,
    profanity: metrics.profanity,
    anguish: metrics.anguish,
    negation: metrics.negation,
    repetition: metrics.repetition,
    blame: metrics.blame,
  };
}

/** Message timestamp, falling back to the entry's ISO timestamp, then 0. */
function coerceEntryTimestamp(timestamp: number | undefined, entry: SessionMessageEntry): number {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  const ts = Date.parse(entry.timestamp);
  return Number.isFinite(ts) ? ts : 0;
}

const ZERO_USAGE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/**
 * Extract stats from an assistant message entry (Diff 3: no service-tier
 * carry-over; `premiumRequests` is always 0).
 *
 * Session JSONL on disk is not guaranteed to match the current
 * `AssistantMessage` shape: crash-truncated turns, sessions written by older
 * versions, and foreign producers all flow through this parser. Every field
 * returned here feeds a NOT NULL column in the stats DB, so malformed entries
 * are coerced (missing `stopReason`, token counts, `timestamp`) or skipped
 * (missing `model`/`provider`/`api`/`usage`) instead of crashing the whole
 * sync with a constraint violation.
 */
function extractStats(
  sessionFile: string,
  folder: string,
  entry: SessionMessageEntry,
  agentType: AgentType,
): MessageStats | null {
  const msg = entry.message as AssistantMessage;
  if (msg?.role !== "assistant") return null;
  if (
    typeof msg.model !== "string" ||
    typeof msg.provider !== "string" ||
    typeof msg.api !== "string"
  )
    return null;
  const rawUsage = msg.usage as Partial<Usage> | undefined;
  if (!rawUsage || typeof rawUsage !== "object") return null;

  const wellFormed =
    typeof rawUsage.input === "number" &&
    typeof rawUsage.output === "number" &&
    typeof rawUsage.cacheRead === "number" &&
    typeof rawUsage.cacheWrite === "number" &&
    typeof rawUsage.totalTokens === "number";
  const usage: Usage = wellFormed
    ? (rawUsage as Usage)
    : {
        ...rawUsage,
        input: rawUsage.input ?? 0,
        output: rawUsage.output ?? 0,
        cacheRead: rawUsage.cacheRead ?? 0,
        cacheWrite: rawUsage.cacheWrite ?? 0,
        totalTokens: rawUsage.totalTokens ?? 0,
        cost: rawUsage.cost ?? ZERO_USAGE_COST,
        premiumRequests: 0,
      };

  return {
    sessionFile,
    entryId: entry.id,
    folder,
    model: msg.model,
    provider: msg.provider,
    api: msg.api,
    timestamp: coerceEntryTimestamp(msg.timestamp, entry),
    duration: msg.duration ?? null,
    ttft: msg.ttft ?? null,
    // A message persisted without a terminal stop reason never completed
    // normally: classify by whether it carried an error.
    stopReason: msg.stopReason ?? (msg.errorMessage ? "error" : "aborted"),
    errorMessage: msg.errorMessage ?? null,
    usage,
    agentType,
  };
}

/** Extract one {@link ToolCallStats} per `toolCall` content block. */
function extractToolCalls(
  sessionFile: string,
  folder: string,
  entry: SessionMessageEntry,
  agentType: AgentType,
): ToolCallStats[] {
  const msg = entry.message as AssistantMessage;
  if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
  // `tool_calls` columns are NOT NULL: skip turns that can't be attributed
  // (malformed persisted entries — see extractStats) and blocks missing ids.
  if (typeof msg.model !== "string" || typeof msg.provider !== "string") return [];
  const model = msg.model;
  const provider = msg.provider;

  const blocks = msg.content.filter(
    (
      block: ContentBlock,
    ): block is { type: "toolCall"; id: string; name: string; arguments: unknown } =>
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "toolCall" &&
      typeof (block as { id?: unknown }).id === "string" &&
      typeof (block as { name?: unknown }).name === "string",
  );
  if (blocks.length === 0) return [];

  return blocks.map((block: { type: "toolCall"; id: string; name: string; arguments: unknown }) => {
    let argsChars = 0;
    try {
      argsChars = JSON.stringify(block.arguments ?? {}).length;
    } catch {
      // Non-serializable arguments (shouldn't happen in persisted JSONL); size unknown.
    }
    return {
      sessionFile,
      entryId: entry.id,
      toolCallId: block.id,
      folder,
      toolName: block.name,
      model,
      provider,
      timestamp: coerceEntryTimestamp(msg.timestamp, entry),
      agentType,
      callsInTurn: blocks.length,
      argsChars,
    };
  });
}

/** Build the result linkage for a `toolResult` entry. */
function extractToolResultLink(
  sessionFile: string,
  entry: SessionMessageEntry,
): ToolResultLink | null {
  const msg = entry.message as ToolResultMessage;
  if (
    msg.role !== "toolResult" ||
    typeof msg.toolCallId !== "string" ||
    msg.toolCallId.length === 0
  )
    return null;
  let resultChars = 0;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        resultChars += (block as { text: string }).text.length;
      }
    }
  }
  return {
    sessionFile,
    toolCallId: msg.toolCallId,
    resultChars,
    isError: msg.isError === true,
  };
}

/** Inline `isEnoent` (replaces `omp pi-utils`). */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/* -------------------------------------------------------------------------- */
/* Compaction + observational-memory extraction (impulso-pi addition)          */
/* -------------------------------------------------------------------------- */

/** Parse a timestamp that may be Unix ms (number) or an ISO string. */
function coerceAnyTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

/** Coerce a numeric field, returning null when absent/non-finite. */
function coerceNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** True for a plain non-null object (a tight check the extractors reuse). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Stats from a `compaction` entry, plus any memories carried via `om.folded`. */
function extractCompaction(
  sessionFile: string,
  folder: string,
  entry: SessionEntry,
  lastModel: string | null,
  lastProvider: string | null,
): { compaction: CompactionStats | null; folded: MemoryEventStats[] } {
  const e = entry as SessionEntry & {
    id?: string;
    timestamp?: unknown;
    tokensBefore?: unknown;
    fromHook?: unknown;
    usage?: Partial<Usage>;
    details?: unknown;
    reason?: unknown;
    willRetry?: unknown;
    tokensAfter?: unknown;
  };
  // `entry_id` is NOT NULL in the DB; a compaction entry persisted without an
  // id can't be linked, so skip it.
  if (typeof e.id !== "string" || e.id.length === 0) return { compaction: null, folded: [] };
  const tokensBefore = coerceNum(e.tokensBefore);
  if (tokensBefore === null) return { compaction: null, folded: [] };
  const ts = coerceAnyTimestamp(e.timestamp) ?? 0;
  const usage = isPlainRecord(e.usage) ? e.usage : null;
  const cost = isPlainRecord(usage?.cost) ? (usage!.cost as { total?: unknown }) : null;

  const compaction: CompactionStats = {
    sessionFile,
    entryId: e.id,
    folder,
    timestamp: ts,
    model: lastModel,
    provider: lastProvider,
    tokensBefore,
    fromHook: e.fromHook === true,
    inputTokens: coerceNum(usage?.input) ?? null,
    outputTokens: coerceNum(usage?.output) ?? null,
    cacheReadTokens: coerceNum(usage?.cacheRead) ?? null,
    cacheWriteTokens: coerceNum(usage?.cacheWrite) ?? null,
    cost: coerceNum(cost?.total) ?? null,
    // Phase 2 fields — null on entries written before the upstream pi patch.
    reason: typeof e.reason === "string" ? e.reason : null,
    willRetry: typeof e.willRetry === "boolean" ? e.willRetry : null,
    tokensAfter: coerceNum(e.tokensAfter) ?? null,
  };

  // An `om.folded` snapshot may live in the compaction entry's `details`,
  // carrying the memory ledger across the fold. Re-emit those memories as
  // `folded: true` rows so they remain visible in per-session rollups.
  const folded: MemoryEventStats[] = [];
  const details = e.details;
  if (isPlainRecord(details) && details.type === OM_FOLDED) {
    const foldTs = ts;
    const obs = Array.isArray(details.observations) ? details.observations : [];
    for (const o of obs) {
      if (!isPlainRecord(o)) continue;
      const id = typeof o.id === "string" ? o.id : null;
      if (!id) continue;
      folded.push({
        sessionFile,
        entryId: e.id,
        folder,
        timestamp: coerceAnyTimestamp(o.timestamp) ?? foldTs,
        kind: "observation",
        memoryId: id,
        relevance: typeof o.relevance === "string" ? o.relevance : null,
        tokenCount: coerceNum(o.tokenCount) ?? 0,
        coversUpToId: null,
        content: typeof o.content === "string" ? o.content : null,
        sourceCount: Array.isArray(o.sourceEntryIds) ? o.sourceEntryIds.length : null,
        folded: true,
      });
    }
    const refs = Array.isArray(details.reflections) ? details.reflections : [];
    for (const r of refs) {
      if (!isPlainRecord(r)) continue;
      const id = typeof r.id === "string" ? r.id : null;
      if (!id) continue;
      folded.push({
        sessionFile,
        entryId: e.id,
        folder,
        timestamp: foldTs,
        kind: "reflection",
        memoryId: id,
        relevance: null,
        tokenCount: coerceNum(r.tokenCount) ?? 0,
        coversUpToId: null,
        content: typeof r.content === "string" ? r.content : null,
        sourceCount: Array.isArray(r.supportingObservationIds)
          ? r.supportingObservationIds.length
          : null,
        folded: true,
      });
    }
  }
  return { compaction, folded };
}

/** Memory events from an `om.*` custom entry (observations / reflections / drops).
 *  Returns one row per memory in the batch. */
function extractMemoryEvents(
  sessionFile: string,
  folder: string,
  entry: SessionEntry,
): MemoryEventStats[] {
  const e = entry as SessionEntry & {
    id?: string;
    timestamp?: unknown;
    customType?: string;
    data?: unknown;
  };
  if (e.type !== "custom") return [];
  const customType = e.customType;
  if (
    customType !== OM_OBSERVATIONS_RECORDED &&
    customType !== OM_REFLECTIONS_RECORDED &&
    customType !== OM_OBSERVATIONS_DROPPED
  )
    return [];
  const data = isPlainRecord(e.data) ? e.data : null;
  if (!data) return [];
  const coversUpToId = typeof data.coversUpToId === "string" ? data.coversUpToId : null;
  // `dropped` entries carry a top-level id/timestamp; `recorded`/`reflections`
  // do not, so entryId is null and per-memory timestamps come from the memory.
  const entryId = typeof e.id === "string" && e.id.length > 0 ? e.id : null;
  const entryTs = coerceAnyTimestamp(e.timestamp);
  const out: MemoryEventStats[] = [];

  if (customType === OM_OBSERVATIONS_RECORDED) {
    const observations = Array.isArray(data.observations) ? data.observations : [];
    for (const o of observations) {
      if (!isPlainRecord(o)) continue;
      const id = typeof o.id === "string" ? o.id : null;
      if (!id) continue;
      out.push({
        sessionFile,
        entryId,
        folder,
        timestamp: coerceAnyTimestamp(o.timestamp) ?? entryTs ?? 0,
        kind: "observation",
        memoryId: id,
        relevance: typeof o.relevance === "string" ? o.relevance : null,
        tokenCount: coerceNum(o.tokenCount) ?? 0,
        coversUpToId,
        content: typeof o.content === "string" ? o.content : null,
        sourceCount: Array.isArray(o.sourceEntryIds) ? o.sourceEntryIds.length : null,
        folded: false,
      });
    }
  } else if (customType === OM_REFLECTIONS_RECORDED) {
    const reflections = Array.isArray(data.reflections) ? data.reflections : [];
    for (const r of reflections) {
      if (!isPlainRecord(r)) continue;
      const id = typeof r.id === "string" ? r.id : null;
      if (!id) continue;
      out.push({
        sessionFile,
        entryId,
        folder,
        timestamp: entryTs ?? 0,
        kind: "reflection",
        memoryId: id,
        relevance: null,
        tokenCount: coerceNum(r.tokenCount) ?? 0,
        coversUpToId,
        content: typeof r.content === "string" ? r.content : null,
        sourceCount: Array.isArray(r.supportingObservationIds)
          ? r.supportingObservationIds.length
          : null,
        folded: false,
      });
    }
  } else {
    // OM_OBSERVATIONS_DROPPED: one row per dropped id.
    const ids = Array.isArray(data.observationIds) ? data.observationIds : [];
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      out.push({
        sessionFile,
        entryId,
        folder,
        timestamp: entryTs ?? 0,
        kind: "drop",
        memoryId: id,
        relevance: null,
        tokenCount: 0,
        coversUpToId,
        content: null,
        sourceCount: null,
        folded: false,
      });
    }
  }
  return out;
}

/** Extract a terminal, privacy-bounded pi-subagents run record. Unknown schema
 * versions and malformed payloads are ignored fail-closed. */
function extractSubagentRun(sessionFile: string, entry: SessionEntry): SubagentRunStats | null {
  const e = entry as SessionEntry & { customType?: unknown; data?: unknown };
  if (e.type !== "custom" || e.customType !== SUBAGENT_RUN_V1 || !isPlainRecord(e.data))
    return null;
  const data = e.data;
  const source = isPlainRecord(data.source) ? data.source : null;
  if (
    data.schemaVersion !== 1 ||
    source?.package !== "pi-subagents" ||
    typeof source.version !== "string" ||
    typeof data.runId !== "string" ||
    typeof data.role !== "string" ||
    typeof data.mode !== "string" ||
    typeof data.startedAt !== "number" ||
    !Number.isFinite(data.startedAt)
  )
    return null;
  const state = data.state;
  if (
    state !== "complete" &&
    state !== "failed" &&
    state !== "partial" &&
    state !== "stopped" &&
    state !== "rejected"
  )
    return null;
  const context =
    data.context === "fresh" || data.context === "fork" || data.context === "mixed"
      ? data.context
      : "unknown";
  const finite = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  // pi-subagents may store totalTokens as {input,output,total} and totalCost
  // as {inputTokens,outputTokens,costUsd}; the telemetry extension sometimes
  // records plain numbers. Extract the aggregate value from either shape.
  const aggregate = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!isPlainRecord(value)) return null;
    return finite(value.total) ?? finite(value.costUsd) ?? finite(value.total) ?? null;
  };
  // Fallback: extract token/cost totals from pi-subagents' results[].usage
  // shape when top-level totalTokens/totalCost are absent.
  const results = Array.isArray(data.results) ? data.results.filter(isPlainRecord) : [];
  const firstUsage =
    results.length > 0 && isPlainRecord(results[0].usage) ? results[0].usage : null;
  const tokensFromUsage = firstUsage
    ? (finite(firstUsage.input) ?? 0) + (finite(firstUsage.output) ?? 0)
    : null;
  const costFromUsage = firstUsage ? finite(firstUsage.cost) : null;
  const turnsFromUsage = firstUsage ? finite(firstUsage.turns) : null;
  return {
    sessionFile,
    runId: data.runId,
    role: data.role,
    mode: data.mode,
    context,
    async: data.async === true,
    state,
    startedAt: data.startedAt,
    endedAt: finite(data.endedAt),
    durationMs: finite(data.durationMs),
    totalTokens: aggregate(data.totalTokens) ?? tokensFromUsage,
    totalCost: aggregate(data.totalCost) ?? costFromUsage,
    turns: finite(data.turns) ?? turnsFromUsage,
    tools: finite(data.tools),
    timedOut: data.timedOut === true,
    stopped: data.stopped === true,
    model:
      typeof data.model === "string"
        ? data.model
        : results[0] && typeof results[0].model === "string"
          ? results[0].model
          : null,
    sourceVersion: source.version,
    lifecycleArtifactVersion: finite(data.lifecycleArtifactVersion) ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Parse a session file and extract all assistant-message stats. Uses
 * incremental reading with byte-offset tracking: only the bytes past the last
 * committed offset are parsed, and the returned `newOffset` is the byte
 * position just past the last fully-consumed line (a trailing partial line is
 * left for the next pass).
 *
 * Lenient on malformed lines (see {@link visitSessionEntriesLenient}).
 */
export async function parseSessionFile(
  sessionPath: string,
  fromOffset = 0,
): Promise<ParseSessionResult> {
  const empty: ParseSessionResult = {
    stats: [],
    userStats: [],
    userLinks: [],
    toolCalls: [],
    toolResults: [],
    compactions: [],
    memoryEvents: [],
    newOffset: fromOffset,
    subagentRuns: [],
  };

  let bytes: Uint8Array;
  try {
    const buf = await fs.readFile(sessionPath);
    bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  } catch (err) {
    if (isEnoent(err)) return empty;
    throw err;
  }

  // `folder` is `let`: a later session-header entry may refine it (see the
  // loop below). The path-derived value is a lossy fallback — pi encodes the
  // cwd's `/` as `-`, which is not reversible for paths that contain `-`.
  let folder = extractFolderFromPath(sessionPath);
  const agentType = classifyAgentType(sessionPath);
  const stats: MessageStats[] = [];
  const userStats: UserMessageStats[] = [];
  const userLinks: UserMessageLink[] = [];
  const toolCalls: ToolCallStats[] = [];
  const toolResults: ToolResultLink[] = [];
  const compactions: CompactionStats[] = [];
  const memoryEvents: MemoryEventStats[] = [];
  const subagentRuns: SubagentRunStats[] = [];
  // Running last-seen assistant model/provider. `compaction` entries do not
  // carry a model; the compaction extractor inherits these so compaction
  // stats can be attributed to the model that was active at trigger time.
  // null when the parse chunk starts mid-stream (incremental sync past the
  // last assistant turn) — the aggregator groups nulls into `unknown`.
  let lastModel: string | null = null;
  let lastProvider: string | null = null;
  const userByEntryId = new Map<string, UserMessageStats>();
  const start = Math.max(0, Math.min(fromOffset, bytes.length));
  const unprocessed = bytes.subarray(start);
  const { entries, read } = parseSessionEntriesLenient(unprocessed);

  for (const entry of entries) {
    // The session header records the real cwd; prefer it over the lossy
    // path-derived label so folder labels are exact.
    if (isSessionHeader(entry)) {
      const cwd = extractCwd(entry);
      if (cwd) folder = cwd;
      continue;
    }
    if (isUserMessage(entry)) {
      const userMsg = extractUserStats(sessionPath, folder, entry);
      if (userMsg) {
        userStats.push(userMsg);
        userByEntryId.set(entry.id, userMsg);
      }
      continue;
    }
    if (isToolResultMessage(entry)) {
      const link = extractToolResultLink(sessionPath, entry);
      if (link) toolResults.push(link);
      continue;
    }
    if (isAssistantMessage(entry)) {
      const msgStats = extractStats(sessionPath, folder, entry, agentType);
      if (msgStats) {
        stats.push(msgStats);
        lastModel = msgStats.model;
        lastProvider = msgStats.provider;
      }
      toolCalls.push(...extractToolCalls(sessionPath, folder, entry, agentType));
      // Link assistant's responding model back to the user message it answered.
      const parentId = entry.parentId;
      if (parentId) {
        const msg = entry.message as AssistantMessage;
        if (msg.model && msg.provider) {
          // Emit unconditionally. The aggregator's UPDATE is guarded by
          // `model IS NULL` so this is idempotent: a no-op for already
          // linked rows, a fix-up for fresh inserts (which start NULL
          // because the user row is recorded before its reply lands) and
          // for cross-pass orphans whose parent was committed by an
          // earlier incremental sync.
          userLinks.push({
            sessionFile: sessionPath,
            entryId: parentId,
            model: msg.model,
            provider: msg.provider,
          });
        }
      }
      continue;
    }
    // `compaction` entry: pi-native fold (window-pressure/overflow) or an
    // obs-memory hook-produced fold (`fromHook: true`). May carry a memory
    // snapshot (`om.folded`) in `details`.
    if (entry.type === "compaction") {
      const { compaction, folded } = extractCompaction(
        sessionPath,
        folder,
        entry,
        lastModel,
        lastProvider,
      );
      if (compaction) compactions.push(compaction);
      if (folded.length > 0) memoryEvents.push(...folded);
      continue;
    }
    // `custom` entry: the privacy-bounded subagent recorder and
    // observational-memory records. Unknown custom entries are ignored.
    if (entry.type === "custom") {
      const run = extractSubagentRun(sessionPath, entry);
      if (run) subagentRuns.push(run);
      const events = extractMemoryEvents(sessionPath, folder, entry);
      if (events.length > 0) memoryEvents.push(...events);
      continue;
    }
  }

  return {
    stats,
    userStats,
    userLinks,
    toolCalls,
    toolResults,
    compactions,
    memoryEvents,
    subagentRuns,
    folder,
    newOffset: start + read,
  };
}

/**
 * Read just the folder/cwd label for a session file: the first parseable
 * line's session header cwd, else the lossy path-derived decode. Cheap —
 * reads only the first JSONL line, so it can run on every skip-path file.
 */
export async function readSessionFolder(sessionPath: string): Promise<string> {
  const fallback = extractFolderFromPath(sessionPath);
  try {
    const handle = await fs.open(sessionPath);
    const stream = handle.createReadStream();
    const rl = readline.createInterface({ crlfDelay: Infinity, input: stream });
    for await (const line of rl) {
      const entry = parseJsonLine(Buffer.from(line), 0, line.length);
      rl.close();
      stream.destroy();
      await handle.close();
      if (entry && isSessionHeader(entry)) {
        const cwd = extractCwd(entry);
        if (cwd) return cwd;
      }
      return fallback; // first parseable line isn't a header
    }
  } catch {
    /* fall through to the path-derived fallback */
  }
  return fallback;
}

/** List all session directories (folders) under the sessions dir. */
export async function listSessionFolders(sessionsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(sessionsDir, e.name));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/** List all `.jsonl` session files in a folder, recursively. */
export async function listSessionFiles(folderPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(e.parentPath, e.name));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/** List all `.jsonl` session files across all folders. */
export async function listAllSessionFiles(sessionsDir: string): Promise<string[]> {
  const folders = await listSessionFolders(sessionsDir);
  const allFiles: string[] = [];
  for (const folder of folders) {
    const files = await listSessionFiles(folder);
    allFiles.push(...files);
  }
  return allFiles;
}

/** Find a specific entry in a session file by entry id. */
export async function getSessionEntry(
  sessionPath: string,
  entryId: string,
): Promise<SessionEntry | null> {
  try {
    const stream = (await fs.open(sessionPath)).createReadStream();
    const rl = readline.createInterface({ crlfDelay: Infinity, input: stream });
    for await (const line of rl) {
      const entry = parseJsonLine(Buffer.from(line), 0, line.length);
      if (entry && "id" in entry && entry.id === entryId) {
        rl.close();
        stream.destroy();
        return entry;
      }
    }
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return null;
}
