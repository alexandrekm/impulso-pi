/**
 * @fileoverview SQLite schema + queries (Node port of omp-stats `db.ts`).
 *
 * Uses the built-in `node:sqlite` (`DatabaseSync`), so the package has zero
 * runtime dependencies and requires Node ≥ 22.5.
 *
 * Differences from the omp original:
 *  - **`bun:sqlite` → `node:sqlite`:** `db.run(ddl)` → `db.exec(ddl)`; the
 *    `db.transaction(fn)` helper is replaced by a local {@link tx} wrapper
 *    (`BEGIN`/`COMMIT`/`ROLLBACK`).
 *  - **No catalog (Diff 3):** the `omp pi-catalog` cost backfills are
 *    gone. `usage.cost` is trusted verbatim (earendil-works pi always emits
 *    it), and `cost_no_cache_input` — the uncached-input counterfactual that
 *    drives `cacheSavings` — is derived from each row's own `cost.input` /
 *    `input_tokens` (no per-model price table needed).
 *  - **No service tier (Diff 3):** `premium_requests` is kept as a column for
 *    shape compatibility but always 0; the priority-premium backfill is gone.
 *  - **No one-time backfills:** this is a fresh schema (no legacy omp DB to
 *    migrate), so the `meta`-sentinel backfill machinery is dropped. The fork
 *    `WHERE NOT EXISTS` guards in the insert paths are retained (correct and
 *    cheap).
 *
 * MIT, © Can Boluk (original omp-stats); ported for the impulso-pi package.
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveStatsDir } from "./parser.js";
import type {
  AgentType,
  BehaviorModelStats,
  BehaviorOverallStats,
  BehaviorTimeSeriesPoint,
  CompactionStats,
  CostTimeSeriesPoint,
  FolderStats,
  GuardEventStats,
  MemoryEventStats,
  MemoryKind,
  MessageStats,
  ModelPerformancePoint,
  ModelStats,
  ModelTimeSeriesPoint,
  ProviderAggregate,
  ProviderHourlyPoint,
  ProviderTimeSeriesPoint,
  TimeSeriesPoint,
  ToolCallStats,
  ToolModelStats,
  ToolResultLink,
  ToolTimeSeriesPoint,
  ToolUsageStats,
  UserMessageLink,
  UserMessageStats,
  SubagentRunStats,
} from "./types.js";
import type { AgentTypeStats } from "./shared-types.js";

const ZERO_USAGE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

let db: DatabaseSync | null = null;
let databaseName = "pi-omp-stats.db";

/** Select the database backing one dashboard profile view. */
export function setStatsDatabase(profile?: string | null): void {
  const name = profile && profile !== "all" ? `pi-omp-stats-${profile}.db` : "pi-omp-stats.db";
  if (name === databaseName) return;
  closeDb();
  databaseName = name;
}

/** Path to the stats SQLite database for the selected dashboard view. */
export function getStatsDbPath(): string {
  return path.join(resolveStatsDir(), databaseName);
}

/**
 * Run `fn` inside a SQLite transaction. `node:sqlite` has no
 * `db.transaction()` helper (bun:sqlite does), so this wraps
 * `BEGIN`/`COMMIT`/`ROLLBACK` manually.
 */
function tx<T>(fn: () => T): T {
  if (!db) throw new Error("db not initialised");
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Init                                                                        */
/* -------------------------------------------------------------------------- */

/** Initialize the database and create tables. */
export async function initDb(): Promise<DatabaseSync> {
  if (db) return db;

  await fs.mkdir(resolveStatsDir(), { recursive: true });

  db = new DatabaseSync(getStatsDbPath());
  // Install the busy handler before any lock-taking statement.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			premium_requests REAL NOT NULL DEFAULT 0,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			cost_no_cache_input REAL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
		CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_file);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_model_provider ON messages(timestamp, model, provider);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_folder ON messages(timestamp, folder);
		CREATE INDEX IF NOT EXISTS idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_agent_type ON messages(timestamp, agent_type);

		CREATE TABLE IF NOT EXISTS file_offsets (
			session_file TEXT PRIMARY KEY,
			offset INTEGER NOT NULL,
			last_modified INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			chars INTEGER NOT NULL,
			words INTEGER NOT NULL,
			yelling INTEGER NOT NULL,
			profanity INTEGER NOT NULL,
			anguish INTEGER NOT NULL,
			negation INTEGER NOT NULL DEFAULT 0,
			repetition INTEGER NOT NULL DEFAULT 0,
			blame INTEGER NOT NULL DEFAULT 0,
			UNIQUE(session_file, entry_id)
		);
		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);

		CREATE TABLE IF NOT EXISTS tool_calls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			tool_call_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			calls_in_turn INTEGER NOT NULL DEFAULT 1,
			args_chars INTEGER NOT NULL DEFAULT 0,
			result_chars INTEGER,
			duration_ms INTEGER,
			is_error INTEGER,
			UNIQUE(session_file, tool_call_id)
		);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		-- Maps session_file → the folder/cwd label currently applied to its rows.
		-- When the parser's label changes (e.g. a header cwd becomes available),
		-- the file's offset is reset so its rows are re-labelled (INSERT OR
		-- REPLACE) without re-inserting message rows (dedup guard).
		CREATE TABLE IF NOT EXISTS folder_sessions (
			session_file TEXT PRIMARY KEY,
			folder TEXT NOT NULL
		);

		-- Compaction events (impulso-pi). One row per 'compaction' session entry.
		-- 'tokens_before' is the context size at trigger; 'from_hook' splits
		-- obs-memory-driven compactions from pi-native window-pressure ones.
		-- '*_tokens'/'cost' are the summary-generation LLM call's usage (nullable).
		CREATE TABLE IF NOT EXISTS compaction_stats (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			tokens_before INTEGER NOT NULL,
			from_hook INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER,
			output_tokens INTEGER,
			cache_read_tokens INTEGER,
			cache_write_tokens INTEGER,
			cost REAL,
			-- Phase 2 fields (nullable; populated once the upstream pi patch lands).
			reason TEXT,
			will_retry INTEGER,
			tokens_after INTEGER,
			UNIQUE(session_file, entry_id)
		);
		CREATE INDEX IF NOT EXISTS idx_compaction_stats_timestamp ON compaction_stats(timestamp);
		CREATE INDEX IF NOT EXISTS idx_compaction_stats_model ON compaction_stats(model);
		CREATE INDEX IF NOT EXISTS idx_compaction_stats_session ON compaction_stats(session_file);

		-- Observational-memory events (impulso-pi). One row per memory in an
		-- 'om.observations.recorded' / 'om.reflections.recorded' /
		-- 'om.observations.dropped' custom entry, plus memories carried through a
		-- compaction via 'om.folded' (folded = 1). 'entry_id' is null for
		-- recorded/reflections entries (which carry no top-level id).
		CREATE TABLE IF NOT EXISTS memory_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			kind TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			relevance TEXT,
			token_count INTEGER NOT NULL DEFAULT 0,
			covers_up_to_id TEXT,
			content TEXT,
			source_count INTEGER,
			folded INTEGER NOT NULL DEFAULT 0,
			UNIQUE(session_file, memory_id, kind, folded)
		);
		CREATE INDEX IF NOT EXISTS idx_memory_events_timestamp ON memory_events(timestamp);
		CREATE INDEX IF NOT EXISTS idx_memory_events_kind ON memory_events(kind);
		CREATE INDEX IF NOT EXISTS idx_memory_events_relevance ON memory_events(relevance);
		CREATE INDEX IF NOT EXISTS idx_memory_events_session ON memory_events(session_file);
		CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id ON memory_events(memory_id);

		-- Guard blocks (impulso-pi). One row per commit-guard / command-guard
		-- block: pi persists a 'tool_call' hook block as an error toolResult
		-- whose first text block is the guard's reason, prefixed '[<guard>]'.
		-- 'kind' is a coarse category parsed from the reason text.
		CREATE TABLE IF NOT EXISTS guard_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			guard TEXT NOT NULL,
			kind TEXT NOT NULL,
			model TEXT,
			provider TEXT,
			command TEXT,
			reason TEXT,
			UNIQUE(session_file, entry_id)
		);
		CREATE INDEX IF NOT EXISTS idx_guard_events_timestamp ON guard_events(timestamp);
		CREATE INDEX IF NOT EXISTS idx_guard_events_guard ON guard_events(guard);
		CREATE INDEX IF NOT EXISTS idx_guard_events_kind ON guard_events(kind);
		CREATE INDEX IF NOT EXISTS idx_guard_events_session ON guard_events(session_file);

		-- Passive pi-subagents lifecycle records. No task text, child output, or
		-- artifact path is stored: these are aggregate-safe terminal metadata only.
		CREATE TABLE IF NOT EXISTS subagent_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			run_id TEXT NOT NULL,
			role TEXT NOT NULL,
			mode TEXT NOT NULL,
			context TEXT NOT NULL,
			async INTEGER NOT NULL,
			state TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			ended_at INTEGER,
			duration_ms INTEGER,
			total_tokens INTEGER,
			total_cost REAL,
			turns INTEGER,
			tools INTEGER,
			timed_out INTEGER NOT NULL DEFAULT 0,
			stopped INTEGER NOT NULL DEFAULT 0,
			model TEXT,
			source_version TEXT NOT NULL,
			lifecycle_artifact_version INTEGER NOT NULL,
			UNIQUE(session_file, run_id)
		);
		CREATE INDEX IF NOT EXISTS idx_subagent_runs_started_at ON subagent_runs(started_at);
		CREATE INDEX IF NOT EXISTS idx_subagent_runs_role ON subagent_runs(role);
	`);

  // Schema-version sentinel: when new extraction tables are added (or any
  // change that needs rows from already-synced bytes), bump SCHEMA_VERSION.
  // On mismatch we reset every file offset so the next sync re-parses all
  // files once — the dedup guards make the re-inserts idempotent, and parsing
  // is cheap. Without this, a pre-existing DB would never backfill the new
  // compaction/memory/guard/subagent tables from files whose mtime is unchanged.
  // 6→7: same schema, but the first v6 release still guarded tool-result
  // updates on `result_chars IS NULL`, so the v6 offset-reset re-parse
  // repopulated offsets without backfilling duration_ms. v7 forces one more
  // full re-parse under the widened `duration_ms IS NULL` guard.
  const SCHEMA_VERSION = "7-tool-duration-backfill";
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined;
  if (db && (!row || row.value !== SCHEMA_VERSION)) {
    // Add the Phase 2 columns to a DB created under schema v2. ALTER TABLE
    // ADD COLUMN is a no-op error when the column already exists (fresh DB
    // has them from the CREATE TABLE), so swallow the duplicate-column error.
    const addColumn = (col: string, ddl: string) => {
      try {
        db!.exec(ddl);
      } catch (err) {
        // "duplicate column name" → already present; anything else rethrows.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column/i.test(msg)) throw err;
      }
      void col;
    };
    addColumn("reason", "ALTER TABLE compaction_stats ADD COLUMN reason TEXT");
    addColumn("will_retry", "ALTER TABLE compaction_stats ADD COLUMN will_retry INTEGER");
    addColumn("tokens_after", "ALTER TABLE compaction_stats ADD COLUMN tokens_after INTEGER");
    addColumn("duration_ms", "ALTER TABLE tool_calls ADD COLUMN duration_ms INTEGER");
    // The reason index can't be in the initial CREATE block (the column may
    // not exist yet on a v2 DB), so create it here after the ALTERs.
    db.exec("CREATE INDEX IF NOT EXISTS idx_compaction_stats_reason ON compaction_stats(reason)");
    db.exec("DELETE FROM file_offsets");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      SCHEMA_VERSION,
    );
  }

  return db;
}

/** No-op in the port (no one-time backfills to settle). Kept for API parity. */
export function markSessionBackfillsComplete(): void {
  /* no-op: fresh schema, no legacy migrations */
}

/* -------------------------------------------------------------------------- */
/* Cost helpers (no catalog — Diff 3)                                         */
/* -------------------------------------------------------------------------- */

/**
 * The uncached-input cost counterfactual: what the prompt tokens
 * (input + cacheRead + cacheWrite) would have cost billed at the full input
 * rate. The per-token input rate is derived from the row's own `cost.input` /
 * `input_tokens`; when `input_tokens` is 0 the rate is unknown and the row
 * contributes 0 to `cacheSavings` (no catalog to fall back on).
 */
function computeNoCacheInputCost(stats: MessageStats): number {
  const u = stats.usage;
  const promptTokens = u.input + u.cacheRead + u.cacheWrite;
  if (u.input > 0 && promptTokens > 0) {
    const inputRate = u.cost.input / u.input; // per token
    return promptTokens * inputRate;
  }
  return 0;
}

/** Trust the session's `usage.cost` verbatim; fall back to zero when absent. */
function resolveStoredCost(stats: MessageStats) {
  return stats.usage.cost ?? ZERO_USAGE_COST;
}

/* -------------------------------------------------------------------------- */
/* File offsets                                                                */
/* -------------------------------------------------------------------------- */

export function getFileOffset(
  sessionFile: string,
): { offset: number; lastModified: number } | null {
  if (!db) return null;
  const row = db
    .prepare("SELECT offset, last_modified FROM file_offsets WHERE session_file = ?")
    .get(sessionFile) as { offset: number; last_modified: number } | undefined;
  return row ? { offset: row.offset, lastModified: row.last_modified } : null;
}

export function setFileOffset(sessionFile: string, offset: number, lastModified: number): void {
  if (!db) return;
  db.prepare(
    "INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)",
  ).run(sessionFile, offset, lastModified);
}

/** The folder/cwd label last applied to a session file's rows, if known. */
export function getFolderLabel(sessionFile: string): string | null {
  if (!db) return null;
  const row = db
    .prepare("SELECT folder FROM folder_sessions WHERE session_file = ?")
    .get(sessionFile) as { folder: string } | undefined;
  return row ? row.folder : null;
}

export function setFolderLabel(sessionFile: string, folder: string): void {
  if (!db) return;
  db.prepare("INSERT OR REPLACE INTO folder_sessions (session_file, folder) VALUES (?, ?)").run(
    sessionFile,
    folder,
  );
}

/** Relabel every row a session file owns with a (new) folder. Indexed by
 * `session_file`; idempotent. Used to fix rows persisted before header-cwd
 * folder parsing landed. */
export function relabelSessionFolder(sessionFile: string, folder: string): void {
  if (!db) return;
  for (const table of [
    "messages",
    "user_messages",
    "tool_calls",
    "compaction_stats",
    "memory_events",
    "guard_events",
  ]) {
    db.prepare(`UPDATE ${table} SET folder = ? WHERE session_file = ?`).run(folder, sessionFile);
  }
}

/** Reset all file offsets so the next sync re-reads every file (used to
 * re-label folders when the label source changes, e.g. header cwd parsing). */
export function resetAllFileOffsets(): void {
  if (!db) return;
  db.exec("DELETE FROM file_offsets");
}

/* -------------------------------------------------------------------------- */
/* Inserts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Insert message stats. Forked/branched sessions deep-copy a parent's
 * entries into a new JSONL — same `entry_id`, `timestamp`, model, tokens — so
 * the `WHERE NOT EXISTS` guard skips duplicates across the lineage
 * (first-write-wins). Same-file re-syncs hit the `ON CONFLICT` upsert.
 */
export function insertMessageStats(stats: MessageStats[]): number {
  if (!db || stats.length === 0) return 0;

  const stmt = db.prepare(`
		INSERT INTO messages (
			session_file, entry_id, folder, model, provider, api, timestamp,
			duration, ttft, stop_reason, error_message,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
			cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM messages
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
		ON CONFLICT(session_file, entry_id) DO UPDATE SET
			premium_requests = excluded.premium_requests
		WHERE messages.premium_requests < excluded.premium_requests
	`);

  let inserted = 0;
  tx(() => {
    for (const s of stats) {
      const cost = resolveStoredCost(s);
      const noCacheInputCost = computeNoCacheInputCost(s);
      const result = stmt.run(
        s.sessionFile,
        s.entryId,
        s.folder,
        s.model,
        s.provider,
        s.api,
        s.timestamp,
        s.duration,
        s.ttft,
        s.stopReason,
        s.errorMessage,
        s.usage.input,
        s.usage.output,
        s.usage.cacheRead,
        s.usage.cacheWrite,
        s.usage.totalTokens,
        s.usage.premiumRequests ?? 0,
        cost.input,
        cost.output,
        cost.cacheRead,
        cost.cacheWrite,
        cost.total,
        noCacheInputCost,
        s.agentType,
        // `WHERE NOT EXISTS` binds.
        s.entryId,
        s.timestamp,
        s.sessionFile,
      );
      if (Number(result.changes) > 0) inserted++;
    }
  });
  return inserted;
}

export function insertUserMessageStats(stats: UserMessageStats[]): number {
  if (!db || stats.length === 0) return 0;

  const stmt = db.prepare(`
		INSERT OR IGNORE INTO user_messages (
			session_file, entry_id, folder, timestamp, model, provider,
			chars, words, yelling, profanity, anguish,
			negation, repetition, blame
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM user_messages
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
	`);

  let inserted = 0;
  tx(() => {
    for (const s of stats) {
      const result = stmt.run(
        s.sessionFile,
        s.entryId,
        s.folder,
        s.timestamp,
        s.model,
        s.provider,
        s.chars,
        s.words,
        s.yelling,
        s.profanity,
        s.anguish,
        s.negation,
        s.repetition,
        s.blame,
        s.entryId,
        s.timestamp,
        s.sessionFile,
      );
      if (Number(result.changes) > 0) inserted++;
    }
  });
  return inserted;
}

/** Backfill the responding `model`/`provider` on user rows persisted before
 * their assistant reply was parsed. The `model IS NULL` guard makes it
 * idempotent across incremental passes. */
export function updateUserMessageLinks(links: UserMessageLink[]): number {
  if (!db || links.length === 0) return 0;
  const stmt = db.prepare(
    "UPDATE user_messages SET model = ?, provider = ? WHERE session_file = ? AND entry_id = ? AND model IS NULL",
  );
  let updated = 0;
  tx(() => {
    for (const link of links) {
      const result = stmt.run(link.model, link.provider, link.sessionFile, link.entryId);
      if (Number(result.changes) > 0) updated++;
    }
  });
  return updated;
}

export function insertToolCalls(calls: ToolCallStats[]): number {
  if (!db || calls.length === 0) return 0;

  const stmt = db.prepare(`
		INSERT OR IGNORE INTO tool_calls (
			session_file, entry_id, tool_call_id, folder, tool_name,
			model, provider, timestamp, agent_type, calls_in_turn, args_chars
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM tool_calls
			WHERE entry_id = ? AND timestamp = ? AND tool_call_id = ? AND session_file <> ?
		)
	`);

  let inserted = 0;
  tx(() => {
    for (const c of calls) {
      const result = stmt.run(
        c.sessionFile,
        c.entryId,
        c.toolCallId,
        c.folder,
        c.toolName,
        c.model,
        c.provider,
        c.timestamp,
        c.agentType,
        c.callsInTurn,
        c.argsChars,
        c.entryId,
        c.timestamp,
        c.toolCallId,
        c.sessionFile,
      );
      if (Number(result.changes) > 0) inserted++;
    }
  });
  return inserted;
}

export function updateToolResults(links: ToolResultLink[]): number {
  if (!db || links.length === 0) return 0;
  // Duration: the toolResult entry's ISO timestamp minus the assistant
  // entry's tool-call timestamp. Entry timestamps are only written when an
  // entry is persisted, so a long human pause mid-turn would inflate the
  // first pending call's delta — cap at 1h and discard negatives instead.
  // With several parallel calls in one turn the delta is per-call queue
  // time, not pure execution time (still the right signal for "how long did
  // the agent wait on this tool").
  //
  // Guard: fill any row whose duration_ms is still NULL. This covers both
  // fresh calls (row inserted by the toolCall message, result not yet seen)
  // and the schema-v6 backfill, which re-parses historical sessions whose
  // result_chars was already populated. Re-running on an already-measured
  // row is impossible (duration set), and rows whose delta was capped to
  // NULL just recompute the same NULL — the deltas are deterministic, so
  // nothing is ever overwritten with a different value.
  const TOOL_DURATION_CAP_MS = 3_600_000;
  const stmt = db.prepare(
    `UPDATE tool_calls SET result_chars = ?, is_error = ?,
       duration_ms = CASE WHEN ? - timestamp BETWEEN 0 AND ${TOOL_DURATION_CAP_MS}
                          THEN ? - timestamp ELSE NULL END
     WHERE session_file = ? AND tool_call_id = ? AND duration_ms IS NULL`,
  );
  let updated = 0;
  tx(() => {
    for (const link of links) {
      const result = stmt.run(
        link.resultChars,
        link.isError ? 1 : 0,
        link.timestamp,
        link.timestamp,
        link.sessionFile,
        link.toolCallId,
      );
      updated += Number(result.changes);
    }
  });
  return updated;
}

/* -------------------------------------------------------------------------- */
/* Compaction + memory inserts (impulso-pi)                                   */
/* -------------------------------------------------------------------------- */

/** Insert compaction stats. Idempotent upsert on `UNIQUE(session_file, entry_id)`;
 *  forked/branched sessions that deep-copy a parent's compaction entry share the
 *  same `entry_id`, so the `WHERE NOT EXISTS` guard skips cross-lineage dupes. */
export function insertCompactionStats(stats: CompactionStats[]): number {
  if (!db || stats.length === 0) return 0;
  const stmt = db.prepare(`
		INSERT INTO compaction_stats (
			session_file, entry_id, folder, timestamp, model, provider, tokens_before,
			from_hook, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost,
			reason, will_retry, tokens_after
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM compaction_stats
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
		ON CONFLICT(session_file, entry_id) DO UPDATE SET
			reason = COALESCE(excluded.reason, compaction_stats.reason),
			will_retry = COALESCE(excluded.will_retry, compaction_stats.will_retry),
			tokens_after = COALESCE(excluded.tokens_after, compaction_stats.tokens_after)
	`);
  let inserted = 0;
  tx(() => {
    for (const s of stats) {
      const result = stmt.run(
        s.sessionFile,
        s.entryId,
        s.folder,
        s.timestamp,
        s.model,
        s.provider,
        s.tokensBefore,
        s.fromHook ? 1 : 0,
        s.inputTokens,
        s.outputTokens,
        s.cacheReadTokens,
        s.cacheWriteTokens,
        s.cost,
        s.reason,
        s.willRetry == null ? null : s.willRetry ? 1 : 0,
        s.tokensAfter,
        // `WHERE NOT EXISTS` binds.
        s.entryId,
        s.timestamp,
        s.sessionFile,
      );
      if (Number(result.changes) > 0) inserted++;
    }
  });
  return inserted;
}

/** Insert observational-memory event rows. Idempotent upsert on
 *  `UNIQUE(session_file, memory_id, kind, folded)` — a memory id is recorded
 *  once per session and may re-appear only as a `folded=1` row carried through
 *  a later compaction, so the (kind, folded) qualifier keeps both visible. */
export function insertMemoryEvents(events: MemoryEventStats[]): number {
  if (!db || events.length === 0) return 0;
  const stmt = db.prepare(`
		INSERT INTO memory_events (
			session_file, entry_id, folder, timestamp, kind, memory_id, relevance,
			token_count, covers_up_to_id, content, source_count, folded
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_file, memory_id, kind, folded) DO NOTHING
	`);
  let inserted = 0;
  tx(() => {
    for (const e of events) {
      const result = stmt.run(
        e.sessionFile,
        e.entryId,
        e.folder,
        e.timestamp,
        e.kind,
        e.memoryId,
        e.relevance,
        e.tokenCount,
        e.coversUpToId,
        e.content,
        e.sourceCount,
        e.folded ? 1 : 0,
      );
      if (Number(result.changes) > 0) inserted++;
    }
  });
  return inserted;
}

/** Insert guard-block rows (commit-guard / command-guard). Idempotent
 *  upsert on `UNIQUE(session_file, entry_id)`; the fork-style `WHERE NOT
 *  EXISTS` guard skips cross-lineage duplicates from forked sessions that
 *  deep-copy a parent's entries. */
export function insertGuardEvents(events: GuardEventStats[]): number {
  if (!db || events.length === 0) return 0;
  const stmt = db.prepare(`
		INSERT INTO guard_events (
			session_file, entry_id, folder, timestamp, guard, kind,
			model, provider, command, reason
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM guard_events
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
		ON CONFLICT(session_file, entry_id) DO NOTHING
	`);
  let inserted = 0;
  tx(() => {
    for (const e of events) {
      const result = stmt.run(
        e.sessionFile,
        e.entryId,
        e.folder,
        e.timestamp,
        e.guard,
        e.kind,
        e.model,
        e.provider,
        e.command,
        e.reason,
        // `WHERE NOT EXISTS` binds.
        e.entryId,
        e.timestamp,
        e.sessionFile,
      );
      if (Number(result.changes) > 0) inserted++;
    }
  });
  return inserted;
}

/** Insert terminal pi-subagents run records. A start and terminal custom entry
 * share one run id; the parser emits only terminals, and this upsert makes a
 * full backfill or resync idempotent. */
export function insertSubagentRuns(runs: SubagentRunStats[]): number {
  if (!db || runs.length === 0) return 0;
  const stmt = db.prepare(`
		INSERT INTO subagent_runs (
			session_file, run_id, role, mode, context, async, state, started_at, ended_at,
			duration_ms, total_tokens, total_cost, turns, tools, timed_out, stopped,
			model, source_version, lifecycle_artifact_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_file, run_id) DO UPDATE SET
			state = excluded.state, ended_at = excluded.ended_at,
			duration_ms = excluded.duration_ms, total_tokens = excluded.total_tokens,
			total_cost = excluded.total_cost, turns = excluded.turns, tools = excluded.tools,
			timed_out = excluded.timed_out, stopped = excluded.stopped, model = excluded.model
	`);
  let inserted = 0;
  tx(() => {
    for (const run of runs) {
      const result = stmt.run(
        run.sessionFile,
        run.runId,
        run.role,
        run.mode,
        run.context,
        run.async ? 1 : 0,
        run.state,
        run.startedAt,
        run.endedAt,
        run.durationMs,
        run.totalTokens,
        run.totalCost,
        run.turns,
        run.tools,
        run.timedOut ? 1 : 0,
        run.stopped ? 1 : 0,
        run.model,
        run.sourceVersion,
        run.lifecycleArtifactVersion,
      );
      if (Number(result.changes) > 0) inserted++;
    }
  });
  return inserted;
}

export function getSubagentRunDashboard(cutoff?: number | null) {
  const empty = {
    totalRuns: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    partial: 0,
    rejected: 0,
    totalDurationMs: 0,
    medianDurationMs: null as number | null,
    totalTokens: 0,
    totalCost: 0,
  };
  if (!db)
    return {
      summary: empty,
      breakdown: [] as Array<{
        role: string;
        model: string;
        context: string;
        runs: number;
        totalTokens: number;
        totalCost: number;
      }>,
    };
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const where = hasCutoff ? "WHERE started_at >= ?" : "";
  const row = (
    hasCutoff
      ? db
          .prepare(
            `SELECT COUNT(*) AS total_runs, SUM(state = 'complete') AS completed, SUM(state = 'failed') AS failed, SUM(state = 'stopped') AS stopped, SUM(state = 'partial') AS partial, SUM(state = 'rejected') AS rejected, SUM(COALESCE(duration_ms, 0)) AS total_duration_ms, SUM(COALESCE(total_tokens, 0)) AS total_tokens, SUM(COALESCE(total_cost, 0)) AS total_cost FROM subagent_runs ${where}`,
          )
          .get(cutoff)
      : db
          .prepare(
            `SELECT COUNT(*) AS total_runs, SUM(state = 'complete') AS completed, SUM(state = 'failed') AS failed, SUM(state = 'stopped') AS stopped, SUM(state = 'partial') AS partial, SUM(state = 'rejected') AS rejected, SUM(COALESCE(duration_ms, 0)) AS total_duration_ms, SUM(COALESCE(total_tokens, 0)) AS total_tokens, SUM(COALESCE(total_cost, 0)) AS total_cost FROM subagent_runs`,
          )
          .get()
  ) as Record<string, number | null>;
  const durations = (
    hasCutoff
      ? db
          .prepare(
            `SELECT duration_ms FROM subagent_runs ${where} AND duration_ms IS NOT NULL ORDER BY duration_ms`,
          )
          .all(cutoff)
      : db
          .prepare(
            "SELECT duration_ms FROM subagent_runs WHERE duration_ms IS NOT NULL ORDER BY duration_ms",
          )
          .all()
  ) as Array<{ duration_ms: number }>;
  const breakdown = (
    hasCutoff
      ? db
          .prepare(
            `SELECT role, COALESCE(model, 'unknown') AS model, context, COUNT(*) AS runs, SUM(COALESCE(total_tokens, 0)) AS total_tokens, SUM(COALESCE(total_cost, 0)) AS total_cost FROM subagent_runs ${where} GROUP BY role, model, context ORDER BY runs DESC`,
          )
          .all(cutoff)
      : db
          .prepare(
            "SELECT role, COALESCE(model, 'unknown') AS model, context, COUNT(*) AS runs, SUM(COALESCE(total_tokens, 0)) AS total_tokens, SUM(COALESCE(total_cost, 0)) AS total_cost FROM subagent_runs GROUP BY role, model, context ORDER BY runs DESC",
          )
          .all()
  ) as Array<{
    role: string;
    model: string;
    context: string;
    runs: number;
    total_tokens: number;
    total_cost: number;
  }>;
  const medianDurationMs = durations.length
    ? durations[Math.floor((durations.length - 1) / 2)]!.duration_ms
    : null;
  return {
    summary: {
      totalRuns: row.total_runs ?? 0,
      completed: row.completed ?? 0,
      failed: row.failed ?? 0,
      stopped: row.stopped ?? 0,
      partial: row.partial ?? 0,
      rejected: row.rejected ?? 0,
      totalDurationMs: row.total_duration_ms ?? 0,
      medianDurationMs,
      totalTokens: row.total_tokens ?? 0,
      totalCost: row.total_cost ?? 0,
    },
    breakdown: breakdown.map((item) => ({
      role: item.role,
      model: item.model,
      context: item.context,
      runs: item.runs,
      totalTokens: item.total_tokens ?? 0,
      totalCost: item.total_cost ?? 0,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Aggregation helpers                                                         */
/* -------------------------------------------------------------------------- */

interface AggregatedStatsRow {
  total_requests: number;
  failed_requests: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_read_tokens: number | null;
  total_cache_write_tokens: number | null;
  total_premium_requests: number | null;
  total_cost: number | null;
  total_cached_prompt_cost: number | null;
  total_no_cache_input_cost: number | null;
  avg_duration: number | null;
  avg_ttft: number | null;
  avg_tokens_per_second: number | null;
  first_timestamp: number | null;
  last_timestamp: number | null;
}

function buildAggregatedStats(rows: AggregatedStatsRow[]) {
  if (rows.length === 0) {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      errorRate: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      cacheRate: 0,
      cacheSavings: 0,
      totalCost: 0,
      totalPremiumRequests: 0,
      avgDuration: null,
      avgTtft: null,
      avgTokensPerSecond: null,
      firstTimestamp: 0,
      lastTimestamp: 0,
    };
  }
  const row = rows[0];
  const totalRequests = row.total_requests || 0;
  const failedRequests = row.failed_requests || 0;
  const totalInputTokens = row.total_input_tokens || 0;
  const totalCacheReadTokens = row.total_cache_read_tokens || 0;
  const noCacheInputCost = row.total_no_cache_input_cost || 0;
  const cachedPromptCost = row.total_cached_prompt_cost || 0;
  return {
    totalRequests,
    successfulRequests: totalRequests - failedRequests,
    failedRequests,
    errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
    totalInputTokens,
    totalOutputTokens: row.total_output_tokens || 0,
    totalCacheReadTokens,
    totalCacheWriteTokens: row.total_cache_write_tokens || 0,
    cacheRate:
      totalInputTokens + totalCacheReadTokens > 0
        ? totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)
        : 0,
    cacheSavings:
      noCacheInputCost > 0 ? (noCacheInputCost - cachedPromptCost) / noCacheInputCost : 0,
    totalCost: row.total_cost || 0,
    totalPremiumRequests: row.total_premium_requests || 0,
    avgDuration: row.avg_duration,
    avgTtft: row.avg_ttft,
    avgTokensPerSecond: row.avg_tokens_per_second,
    firstTimestamp: row.first_timestamp || 0,
    lastTimestamp: row.last_timestamp || 0,
  };
}

const AGGREGATE_COLUMNS = `
	COUNT(*) as total_requests,
	SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
	SUM(input_tokens) as total_input_tokens,
	SUM(output_tokens) as total_output_tokens,
	SUM(cache_read_tokens) as total_cache_read_tokens,
	SUM(cache_write_tokens) as total_cache_write_tokens,
	SUM(premium_requests) as total_premium_requests,
	SUM(cost_total) as total_cost,
	SUM(CASE WHEN cost_no_cache_input > 0
		THEN cost_input + cost_cache_read + cost_cache_write
		ELSE 0 END) as total_cached_prompt_cost,
	SUM(cost_no_cache_input) as total_no_cache_input_cost,
	AVG(duration) as avg_duration,
	AVG(ttft) as avg_ttft,
	AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
	MIN(timestamp) as first_timestamp,
	MAX(timestamp) as last_timestamp
`;

export function getOverallStats(cutoff?: number) {
  if (!db) return buildAggregatedStats([]);
  const hasCutoff = cutoff !== undefined && cutoff > 0;
  const sql = `SELECT ${AGGREGATE_COLUMNS} FROM messages ${hasCutoff ? "WHERE timestamp >= ?" : ""}`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as AggregatedStatsRow[];
  return buildAggregatedStats(rows);
}

interface ModelStatsRow extends AggregatedStatsRow {
  model: string;
  provider: string;
}

export function getStatsByModel(cutoff?: number): ModelStats[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT model, provider, ${AGGREGATE_COLUMNS}
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model, provider
		ORDER BY total_requests DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as ModelStatsRow[];
  return rows.map((row) => ({
    model: row.model,
    provider: row.provider,
    ...buildAggregatedStats([row]),
  }));
}

interface FolderStatsRow extends AggregatedStatsRow {
  folder: string;
}

export function getStatsByFolder(cutoff?: number): FolderStats[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT folder, ${AGGREGATE_COLUMNS}
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY folder
		ORDER BY total_requests DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as FolderStatsRow[];
  return rows.map((row) => ({ folder: row.folder, ...buildAggregatedStats([row]) }));
}

export function getStatsByAgentType(cutoff?: number): AgentTypeStats[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT agent_type,
			COUNT(*) as total_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(cost_total) as total_cost
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY agent_type
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as Array<{
    agent_type: string;
    total_requests: number;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_cache_read_tokens: number | null;
    total_cache_write_tokens: number | null;
    total_cost: number | null;
  }>;
  return rows.map((row) => ({
    agentType: (row.agent_type as AgentType) ?? "main",
    totalRequests: row.total_requests || 0,
    totalInputTokens: row.total_input_tokens || 0,
    totalOutputTokens: row.total_output_tokens || 0,
    totalCacheReadTokens: row.total_cache_read_tokens || 0,
    totalCacheWriteTokens: row.total_cache_write_tokens || 0,
    totalCost: row.total_cost || 0,
  }));
}

export function getTimeSeries(
  hours = 24,
  cutoff?: number | null,
  bucketMs = 60 * 60 * 1000,
): TimeSeriesPoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - hours * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket,
			COUNT(*) as requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as errors,
			SUM(total_tokens) as tokens,
			SUM(cost_total) as cost
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    requests: number;
    errors: number | null;
    tokens: number | null;
    cost: number | null;
  }>;
  return rows.map((row) => ({
    timestamp: row.bucket,
    requests: row.requests,
    errors: row.errors ?? 0,
    tokens: row.tokens ?? 0,
    cost: row.cost ?? 0,
  }));
}

export function getModelTimeSeries(
  days = 14,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): ModelTimeSeriesPoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket, model, provider, COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    model: string;
    provider: string;
    requests: number;
  }>;
  return rows.map((row) => ({
    timestamp: row.bucket,
    model: row.model,
    provider: row.provider,
    requests: row.requests,
  }));
}

export function getModelPerformanceSeries(
  days = 14,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): ModelPerformancePoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket, model, provider,
			COUNT(*) as requests,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    model: string;
    provider: string;
    requests: number;
    avg_ttft: number | null;
    avg_tokens_per_second: number | null;
  }>;
  return rows.map((row) => ({
    timestamp: row.bucket,
    model: row.model,
    provider: row.provider,
    requests: row.requests,
    avgTtft: row.avg_ttft,
    avgTokensPerSecond: row.avg_tokens_per_second,
  }));
}

export function getCostTimeSeries(
  days = 90,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): CostTimeSeriesPoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket, model, provider,
			SUM(cost_total) as cost,
			SUM(cost_input) as cost_input,
			SUM(cost_output) as cost_output,
			SUM(cost_cache_read) as cost_cache_read,
			SUM(cost_cache_write) as cost_cache_write,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    model: string;
    provider: string;
    cost: number | null;
    cost_input: number | null;
    cost_output: number | null;
    cost_cache_read: number | null;
    cost_cache_write: number | null;
    requests: number;
  }>;
  return rows.map((row) => ({
    timestamp: row.bucket,
    model: row.model,
    provider: row.provider,
    cost: row.cost ?? 0,
    costInput: row.cost_input ?? 0,
    costOutput: row.cost_output ?? 0,
    costCacheRead: row.cost_cache_read ?? 0,
    costCacheWrite: row.cost_cache_write ?? 0,
    requests: row.requests,
  }));
}

export function getMessageCount(): number {
  if (!db) return 0;
  const row = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
  return row.count;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Recent / by-id                                                              */
/* -------------------------------------------------------------------------- */

function rowToMessageStats(row: Record<string, unknown>): MessageStats {
  return {
    id: row.id as number,
    sessionFile: row.session_file as string,
    entryId: row.entry_id as string,
    folder: row.folder as string,
    model: row.model as string,
    provider: row.provider as string,
    api: row.api as string,
    timestamp: row.timestamp as number,
    duration: (row.duration as number | null) ?? null,
    ttft: (row.ttft as number | null) ?? null,
    stopReason: row.stop_reason as MessageStats["stopReason"],
    errorMessage: (row.error_message as string | null) ?? null,
    usage: {
      input: row.input_tokens as number,
      output: row.output_tokens as number,
      cacheRead: row.cache_read_tokens as number,
      cacheWrite: row.cache_write_tokens as number,
      totalTokens: row.total_tokens as number,
      premiumRequests: (row.premium_requests as number) ?? 0,
      cost: {
        input: row.cost_input as number,
        output: row.cost_output as number,
        cacheRead: row.cost_cache_read as number,
        cacheWrite: row.cost_cache_write as number,
        total: row.cost_total as number,
      },
    },
    agentType: (row.agent_type as AgentType) ?? "main",
  };
}

export function getRecentRequests(limit = 100): MessageStats[] {
  if (!db) return [];
  const rows = db
    .prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToMessageStats);
}

export function getRecentErrors(limit = 100, cutoff?: number | null): MessageStats[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff !== null;
  const sql = `SELECT * FROM messages WHERE stop_reason = 'error' ${
    hasCutoff ? "AND timestamp >= ? " : ""
  }ORDER BY timestamp DESC LIMIT ?`;
  const rows = (
    hasCutoff ? db.prepare(sql).all(cutoff, limit) : db.prepare(sql).all(limit)
  ) as Record<string, unknown>[];
  return rows.map(rowToMessageStats);
}

export function getMessageById(id: number): MessageStats | null {
  if (!db) return null;
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  return row ? rowToMessageStats(row as Record<string, unknown>) : null;
}

/* -------------------------------------------------------------------------- */
/* Behavior                                                                    */
/* -------------------------------------------------------------------------- */

const UNKNOWN_MODEL = "unknown";

export function getBehaviorOverall(cutoff?: number | null): BehaviorOverallStats {
  const empty: BehaviorOverallStats = {
    totalMessages: 0,
    totalYelling: 0,
    totalProfanity: 0,
    totalAnguish: 0,
    totalNegation: 0,
    totalRepetition: 0,
    totalBlame: 0,
    totalChars: 0,
    firstTimestamp: 0,
    lastTimestamp: 0,
  };
  if (!db) return empty;
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT COUNT(*) as total_messages,
			SUM(yelling) as total_yelling,
			SUM(profanity) as total_profanity,
			SUM(anguish) as total_anguish,
			SUM(negation) as total_negation,
			SUM(repetition) as total_repetition,
			SUM(blame) as total_blame,
			SUM(chars) as total_chars,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
	`;
  const row = (hasCutoff ? db.prepare(sql).get(cutoff) : db.prepare(sql).get()) as
    | {
        total_messages: number;
        total_yelling: number | null;
        total_profanity: number | null;
        total_anguish: number | null;
        total_negation: number | null;
        total_repetition: number | null;
        total_blame: number | null;
        total_chars: number | null;
        first_timestamp: number | null;
        last_timestamp: number | null;
      }
    | undefined;
  if (!row?.total_messages) return empty;
  return {
    totalMessages: row.total_messages,
    totalYelling: row.total_yelling ?? 0,
    totalProfanity: row.total_profanity ?? 0,
    totalAnguish: row.total_anguish ?? 0,
    totalNegation: row.total_negation ?? 0,
    totalRepetition: row.total_repetition ?? 0,
    totalBlame: row.total_blame ?? 0,
    totalChars: row.total_chars ?? 0,
    firstTimestamp: row.first_timestamp ?? 0,
    lastTimestamp: row.last_timestamp ?? 0,
  };
}

export function getBehaviorByModel(cutoff?: number | null): BehaviorModelStats[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT COALESCE(model, ?) as model, COALESCE(provider, ?) as provider,
			COUNT(*) as total_messages,
			SUM(yelling) as total_yelling,
			SUM(profanity) as total_profanity,
			SUM(anguish) as total_anguish,
			SUM(negation) as total_negation,
			SUM(repetition) as total_repetition,
			SUM(blame) as total_blame,
			SUM(chars) as total_chars,
			MAX(timestamp) as last_timestamp
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model, provider
		ORDER BY total_messages DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(UNKNOWN_MODEL, UNKNOWN_MODEL, cutoff)
    : db.prepare(sql).all(UNKNOWN_MODEL, UNKNOWN_MODEL)) as unknown as Array<{
    model: string;
    provider: string;
    total_messages: number;
    total_yelling: number | null;
    total_profanity: number | null;
    total_anguish: number | null;
    total_negation: number | null;
    total_repetition: number | null;
    total_blame: number | null;
    total_chars: number | null;
    last_timestamp: number | null;
  }>;
  return rows.map((row) => ({
    model: row.model,
    provider: row.provider,
    totalMessages: row.total_messages,
    totalYelling: row.total_yelling ?? 0,
    totalProfanity: row.total_profanity ?? 0,
    totalAnguish: row.total_anguish ?? 0,
    totalNegation: row.total_negation ?? 0,
    totalRepetition: row.total_repetition ?? 0,
    totalBlame: row.total_blame ?? 0,
    totalChars: row.total_chars ?? 0,
    lastTimestamp: row.last_timestamp ?? 0,
  }));
}

export function getBehaviorTimeSeries(cutoff?: number | null): BehaviorTimeSeriesPoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT (timestamp / 86400000) * 86400000 as bucket,
			COALESCE(model, ?) as model,
			COALESCE(provider, ?) as provider,
			COUNT(*) as messages,
			SUM(yelling) as yelling,
			SUM(profanity) as profanity,
			SUM(anguish) as anguish,
			SUM(negation) as negation,
			SUM(repetition) as repetition,
			SUM(blame) as blame,
			SUM(chars) as chars
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(UNKNOWN_MODEL, UNKNOWN_MODEL, cutoff)
    : db.prepare(sql).all(UNKNOWN_MODEL, UNKNOWN_MODEL)) as unknown as Array<{
    bucket: number;
    model: string;
    provider: string;
    messages: number;
    yelling: number | null;
    profanity: number | null;
    anguish: number | null;
    negation: number | null;
    repetition: number | null;
    blame: number | null;
    chars: number | null;
  }>;
  return rows.map((row) => ({
    timestamp: row.bucket,
    model: row.model,
    provider: row.provider,
    messages: row.messages,
    yelling: row.yelling ?? 0,
    profanity: row.profanity ?? 0,
    anguish: row.anguish ?? 0,
    negation: row.negation ?? 0,
    repetition: row.repetition ?? 0,
    blame: row.blame ?? 0,
    chars: row.chars ?? 0,
  }));
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

const TOOL_AGGREGATE_COLUMNS = `
	COUNT(*) as calls,
	SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) as errors,
	SUM(t.args_chars) as args_chars,
	SUM(COALESCE(t.result_chars, 0)) as result_chars,
	SUM(COALESCE(m.total_tokens, 0) * 1.0 / t.calls_in_turn) as total_tokens_share,
	SUM(COALESCE(m.output_tokens, 0) * 1.0 / t.calls_in_turn) as output_tokens_share,
	SUM(COALESCE(m.cost_total, 0) / t.calls_in_turn) as cost_share,
	MAX(t.timestamp) as last_used,
	AVG(t.duration_ms) as avg_duration_ms,
	SUM(COALESCE(t.duration_ms, 0)) as total_duration_ms
`;

interface ToolAggregateRow {
  tool_name: string;
  model?: string;
  provider?: string;
  calls: number;
  errors: number | null;
  args_chars: number | null;
  result_chars: number | null;
  total_tokens_share: number | null;
  output_tokens_share: number | null;
  cost_share: number | null;
  last_used: number;
  avg_duration_ms: number | null;
  total_duration_ms: number | null;
}

function rowToToolUsage(row: ToolAggregateRow): ToolUsageStats {
  return {
    tool: row.tool_name,
    calls: row.calls,
    errors: row.errors ?? 0,
    argsChars: row.args_chars ?? 0,
    resultChars: row.result_chars ?? 0,
    totalTokensShare: row.total_tokens_share ?? 0,
    outputTokensShare: row.output_tokens_share ?? 0,
    costShare: row.cost_share ?? 0,
    lastUsed: row.last_used,
    avgDurationMs: row.avg_duration_ms != null ? Math.round(row.avg_duration_ms) : null,
    totalDurationMs: row.total_duration_ms ?? 0,
  };
}

export function getToolStats(cutoff?: number): ToolUsageStats[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT t.tool_name, ${TOOL_AGGREGATE_COLUMNS}
		FROM tool_calls t
		LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
		${hasCutoff ? "WHERE t.timestamp >= ?" : ""}
		GROUP BY t.tool_name
		ORDER BY calls DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as ToolAggregateRow[];
  return rows.map(rowToToolUsage);
}

export function getToolStatsByModel(cutoff?: number): ToolModelStats[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT t.tool_name, t.model, t.provider, ${TOOL_AGGREGATE_COLUMNS}
		FROM tool_calls t
		LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
		${hasCutoff ? "WHERE t.timestamp >= ?" : ""}
		GROUP BY t.tool_name, t.model, t.provider
		ORDER BY calls DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as ToolAggregateRow[];
  return rows.map((row) => ({
    ...rowToToolUsage(row),
    model: row.model ?? "",
    provider: row.provider ?? "",
  }));
}

export function getToolTimeSeries(
  days = 14,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): ToolTimeSeriesPoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket, tool_name,
			COUNT(*) as calls,
			SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors
		FROM tool_calls
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, tool_name
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    tool_name: string;
    calls: number;
    errors: number | null;
  }>;
  return rows.map((row) => ({
    timestamp: row.bucket,
    tool: row.tool_name,
    calls: row.calls,
    errors: row.errors ?? 0,
  }));
}

/* -------------------------------------------------------------------------- */
/* Providers (portable subset only — Diff 3)                                  */
/* -------------------------------------------------------------------------- */

export function getStatsByProvider(cutoff?: number | null): ProviderAggregate[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff !== null && cutoff > 0;
  const sql = `
		SELECT provider,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			COUNT(DISTINCT model) as models,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total_tokens,
			SUM(cost_total) as total_cost,
			SUM(premium_requests) as total_premium_requests,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY provider
		ORDER BY total_tokens DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as Array<{
    provider: string;
    total_requests: number;
    failed_requests: number | null;
    models: number;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_cache_read_tokens: number | null;
    total_cache_write_tokens: number | null;
    total_tokens: number | null;
    total_cost: number | null;
    total_premium_requests: number | null;
    avg_tokens_per_second: number | null;
  }>;
  return rows.map((row) => ({
    provider: row.provider,
    totalRequests: row.total_requests,
    failedRequests: row.failed_requests ?? 0,
    models: row.models,
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    totalCacheReadTokens: row.total_cache_read_tokens ?? 0,
    totalCacheWriteTokens: row.total_cache_write_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    totalCost: row.total_cost ?? 0,
    totalPremiumRequests: row.total_premium_requests ?? 0,
    avgTokensPerSecond: row.avg_tokens_per_second,
  }));
}

export function getProviderHourlyBurn(cutoff?: number | null): ProviderHourlyPoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff !== null && cutoff > 0;
  const sql = `
		SELECT provider,
			CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total_tokens,
			SUM(output_tokens) as output_tokens,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY provider, hour
		ORDER BY provider, hour
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as Array<{
    provider: string;
    hour: number;
    total_tokens: number | null;
    output_tokens: number | null;
    requests: number;
  }>;
  return rows.map((row) => ({
    provider: row.provider,
    hour: row.hour,
    totalTokens: row.total_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    requests: row.requests,
  }));
}

export function getProviderTimeSeries(
  days = 14,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): ProviderTimeSeriesPoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket, provider,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total_tokens,
			SUM(cost_total) as cost,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, provider
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    provider: string;
    total_tokens: number | null;
    cost: number | null;
    requests: number;
  }>;
  return rows.map((row) => ({
    timestamp: row.bucket,
    provider: row.provider,
    totalTokens: row.total_tokens ?? 0,
    cost: row.cost ?? 0,
    requests: row.requests,
  }));
}

/* -------------------------------------------------------------------------- */
/* Compaction aggregation (impulso-pi)                                        */
/* -------------------------------------------------------------------------- */

export interface CompactionSummary {
  totalCompactions: number;
  fromHook: number;
  piNative: number;
  totalCost: number;
  meanTokensBefore: number | null;
  medianTokensBefore: number | null;
  p90TokensBefore: number | null;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface CompactionByModel {
  model: string;
  compactions: number;
  fromHook: number;
  meanTokensBefore: number | null;
  totalCost: number;
}

export interface CompactionByDay {
  timestamp: number;
  compactions: number;
  fromHook: number;
  cost: number;
}

export interface CompactionTokensBeforeBucket {
  bucket: number;
  count: number;
  fromHook: number;
}

const COMPACT_SUMMARY = `
		SELECT COUNT(*) as total_compactions,
			SUM(CASE WHEN from_hook = 1 THEN 1 ELSE 0 END) as from_hook,
			SUM(CASE WHEN from_hook = 0 THEN 1 ELSE 0 END) as pi_native,
			SUM(cost) as total_cost,
			AVG(tokens_before) as mean_tokens_before,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM compaction_stats
`;

/** Compute median and p90 of `tokens_before` for a cutoff via a
 *  percentile-ish SQL trick (sqlite has no PERCENTILE). */
function tokensBeforePercentiles(cutoff: number | null): {
  median: number | null;
  p90: number | null;
} {
  if (!db) return { median: null, p90: null };
  const hasCutoff = cutoff !== null && cutoff > 0;
  const where = hasCutoff ? "WHERE timestamp >= ?" : "";
  const orderSql = `SELECT tokens_before FROM compaction_stats ${where} ORDER BY tokens_before`;
  const rows = (hasCutoff
    ? db.prepare(orderSql).all(cutoff)
    : db.prepare(orderSql).all()) as unknown as Array<{ tokens_before: number }>;
  if (rows.length === 0) return { median: null, p90: null };
  const vals = rows.map((r) => r.tokens_before);
  const pick = (q: number) => {
    const idx = Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)));
    return vals[idx] ?? null;
  };
  return { median: pick(0.5), p90: pick(0.9) };
}

export function getCompactionSummary(cutoff?: number | null): CompactionSummary {
  const empty: CompactionSummary = {
    totalCompactions: 0,
    fromHook: 0,
    piNative: 0,
    totalCost: 0,
    meanTokensBefore: null,
    medianTokensBefore: null,
    p90TokensBefore: null,
    firstTimestamp: 0,
    lastTimestamp: 0,
  };
  if (!db) return empty;
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = hasCutoff ? `${COMPACT_SUMMARY} WHERE timestamp >= ?` : COMPACT_SUMMARY;
  const row = (hasCutoff ? db.prepare(sql).get(cutoff) : db.prepare(sql).get()) as
    | {
        total_compactions: number;
        from_hook: number | null;
        pi_native: number | null;
        total_cost: number | null;
        mean_tokens_before: number | null;
        first_timestamp: number | null;
        last_timestamp: number | null;
      }
    | undefined;
  if (!row || !row.total_compactions) return empty;
  const pct = tokensBeforePercentiles(hasCutoff ? cutoff : null);
  return {
    totalCompactions: row.total_compactions,
    fromHook: row.from_hook ?? 0,
    piNative: row.pi_native ?? 0,
    totalCost: row.total_cost ?? 0,
    meanTokensBefore: row.mean_tokens_before,
    medianTokensBefore: pct.median,
    p90TokensBefore: pct.p90,
    firstTimestamp: row.first_timestamp ?? 0,
    lastTimestamp: row.last_timestamp ?? 0,
  };
}

export function getCompactionByModel(cutoff?: number | null): CompactionByModel[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT COALESCE(model, 'unknown') as model,
			COUNT(*) as compactions,
			SUM(CASE WHEN from_hook = 1 THEN 1 ELSE 0 END) as from_hook,
			AVG(tokens_before) as mean_tokens_before,
			SUM(cost) as total_cost
		FROM compaction_stats
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model
		ORDER BY compactions DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as Array<{
    model: string;
    compactions: number;
    from_hook: number | null;
    mean_tokens_before: number | null;
    total_cost: number | null;
  }>;
  return rows.map((r) => ({
    model: r.model,
    compactions: r.compactions,
    fromHook: r.from_hook ?? 0,
    meanTokensBefore: r.mean_tokens_before,
    totalCost: r.total_cost ?? 0,
  }));
}

export function getCompactionTimeseries(
  days = 14,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): CompactionByDay[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket,
			COUNT(*) as compactions,
			SUM(CASE WHEN from_hook = 1 THEN 1 ELSE 0 END) as from_hook,
			SUM(cost) as cost
		FROM compaction_stats
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    compactions: number;
    from_hook: number | null;
    cost: number | null;
  }>;
  return rows.map((r) => ({
    timestamp: r.bucket,
    compactions: r.compactions,
    fromHook: r.from_hook ?? 0,
    cost: r.cost ?? 0,
  }));
}

/** Histogram of `tokens_before` rounded to `bucketSize` tokens. The dashboard
 *  overlays the active model's context window + the 0.9 line on this. */
export function getCompactionTokensBeforeDistribution(
  bucketSize = 10000,
  cutoff?: number | null,
  model?: string | null,
): CompactionTokensBeforeBucket[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const hasModel = model && model !== "all" && model !== "unknown";
  const where = [];
  if (hasCutoff) where.push("timestamp >= ?");
  if (hasModel) where.push("COALESCE(model, 'unknown') = ?");
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
		SELECT (tokens_before / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket,
			COUNT(*) as count,
			SUM(CASE WHEN from_hook = 1 THEN 1 ELSE 0 END) as from_hook
		FROM compaction_stats
		${whereSql}
		GROUP BY bucket
		ORDER BY bucket ASC
	`;
  const binds: (string | number | null)[] = [bucketSize, bucketSize];
  if (hasCutoff) binds.push(cutoff);
  if (hasModel) binds.push(model);
  const rows = db.prepare(sql).all(...binds) as unknown as Array<{
    bucket: number;
    count: number;
    from_hook: number | null;
  }>;
  return rows.map((r) => ({ bucket: r.bucket, count: r.count, fromHook: r.from_hook ?? 0 }));
}

export interface CompactionByReason {
  reason: string;
  compactions: number;
  fromHook: number;
  willRetry: number;
  meanTokensBefore: number | null;
  meanTokensAfter: number | null;
}

/** Compaction counts grouped by trigger reason (manual / threshold / overflow).
 *  Rows with NULL reason (written before the upstream Phase 2 patch) are grouped
 *  under 'unknown'. */
export function getCompactionByReason(cutoff?: number | null): CompactionByReason[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT COALESCE(reason, 'unknown') as reason,
			COUNT(*) as compactions,
			SUM(CASE WHEN from_hook = 1 THEN 1 ELSE 0 END) as from_hook,
			SUM(CASE WHEN will_retry = 1 THEN 1 ELSE 0 END) as will_retry,
			AVG(tokens_before) as mean_tokens_before,
			AVG(tokens_after) as mean_tokens_after
		FROM compaction_stats
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY reason
		ORDER BY compactions DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as Array<{
    reason: string;
    compactions: number;
    from_hook: number | null;
    will_retry: number | null;
    mean_tokens_before: number | null;
    mean_tokens_after: number | null;
  }>;
  return rows.map((r) => ({
    reason: r.reason,
    compactions: r.compactions,
    fromHook: r.from_hook ?? 0,
    willRetry: r.will_retry ?? 0,
    meanTokensBefore: r.mean_tokens_before,
    meanTokensAfter: r.mean_tokens_after,
  }));
}

/* -------------------------------------------------------------------------- */
/* Observational-memory aggregation (impulso-pi)                               */
/* -------------------------------------------------------------------------- */

export interface MemorySummary {
  observations: number;
  reflections: number;
  drops: number;
  // Excludes folded rows (freshly recorded only).
  relevanceLow: number;
  relevanceMedium: number;
  relevanceHigh: number;
  relevanceCritical: number;
  meanObservationTokens: number | null;
  // Live memory pool: distinct non-dropped observation+reflection tokens,
  // using the latest ledger state per session (folded snapshots win).
  poolTokens: number;
  dropRate: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface MemoryByDay {
  timestamp: number;
  observations: number;
  reflections: number;
  drops: number;
}

export interface MemoryRelevanceBucket {
  relevance: string;
  count: number;
}

export interface MemoryPoolPoint {
  timestamp: number;
  poolTokens: number;
}

export interface MemoryListItem {
  id: number;
  sessionFile: string;
  entryId: string | null;
  timestamp: number;
  kind: MemoryKind;
  memoryId: string;
  relevance: string | null;
  tokenCount: number;
  coversUpToId: string | null;
  content: string | null;
  sourceCount: number | null;
  folded: boolean;
  folder: string;
}

export interface MemoryListResult {
  items: MemoryListItem[];
  total: number;
}

export interface MemoryDetail extends MemoryListItem {
  sourceEntryIds: string[];
  supportingObservationIds: string[];
}

const RELEVANCE_COLS = `
		SUM(CASE WHEN kind = 'observation' AND folded = 0 AND relevance = 'low' THEN 1 ELSE 0 END) as rel_low,
		SUM(CASE WHEN kind = 'observation' AND folded = 0 AND relevance = 'medium' THEN 1 ELSE 0 END) as rel_medium,
		SUM(CASE WHEN kind = 'observation' AND folded = 0 AND relevance = 'high' THEN 1 ELSE 0 END) as rel_high,
		SUM(CASE WHEN kind = 'observation' AND folded = 0 AND relevance = 'critical' THEN 1 ELSE 0 END) as rel_critical
`;

export function getMemorySummary(cutoff?: number | null): MemorySummary {
  const empty: MemorySummary = {
    observations: 0,
    reflections: 0,
    drops: 0,
    relevanceLow: 0,
    relevanceMedium: 0,
    relevanceHigh: 0,
    relevanceCritical: 0,
    meanObservationTokens: null,
    poolTokens: 0,
    dropRate: 0,
    firstTimestamp: 0,
    lastTimestamp: 0,
  };
  if (!db) return empty;
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const where = hasCutoff ? "WHERE timestamp >= ?" : "";
  const sql = `
		SELECT
			SUM(CASE WHEN kind = 'observation' AND folded = 0 THEN 1 ELSE 0 END) as observations,
			SUM(CASE WHEN kind = 'reflection' AND folded = 0 THEN 1 ELSE 0 END) as reflections,
			SUM(CASE WHEN kind = 'drop' AND folded = 0 THEN 1 ELSE 0 END) as drops,
			${RELEVANCE_COLS},
			AVG(CASE WHEN kind = 'observation' AND folded = 0 THEN token_count END) as mean_obs_tokens,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM memory_events
		${where}
	`;
  const row = (hasCutoff ? db.prepare(sql).get(cutoff) : db.prepare(sql).get()) as
    | {
        observations: number | null;
        reflections: number | null;
        drops: number | null;
        rel_low: number | null;
        rel_medium: number | null;
        rel_high: number | null;
        rel_critical: number | null;
        mean_obs_tokens: number | null;
        first_timestamp: number | null;
        last_timestamp: number | null;
      }
    | undefined;
  if (!row || !(row.observations || row.reflections || row.drops)) return empty;
  const observations = row.observations ?? 0;
  const drops = row.drops ?? 0;
  // Live pool tokens: for each session, take the latest folded snapshot's
  // token sum (if any), else the sum of non-folded observation+reflection
  // tokens. Sum across sessions in range.
  const poolTokens = computePoolTokens(hasCutoff ? cutoff : null);
  return {
    observations,
    reflections: row.reflections ?? 0,
    drops,
    relevanceLow: row.rel_low ?? 0,
    relevanceMedium: row.rel_medium ?? 0,
    relevanceHigh: row.rel_high ?? 0,
    relevanceCritical: row.rel_critical ?? 0,
    meanObservationTokens: row.mean_obs_tokens,
    poolTokens,
    dropRate: observations > 0 ? drops / observations : 0,
    firstTimestamp: row.first_timestamp ?? 0,
    lastTimestamp: row.last_timestamp ?? 0,
  };
}

/** Live memory-pool token size: per session, prefer the latest `om.folded`
 *  snapshot's token sum (it represents the ledger state after the most recent
 *  compaction); otherwise sum the freshly-recorded (folded=0) observation+
 *  reflection tokens. Sum across sessions. */
function computePoolTokens(cutoff: number | null): number {
  if (!db) return 0;
  const hasCutoff = cutoff !== null && cutoff > 0;
  // Sessions that have at least one folded snapshot in range.
  const foldedSql = `
		SELECT session_file, MAX(timestamp) as ts, SUM(token_count) as tokens
		FROM memory_events
		WHERE folded = 1 ${hasCutoff ? "AND timestamp >= ?" : ""}
		GROUP BY session_file
	`;
  const foldedRows = (hasCutoff
    ? db.prepare(foldedSql).all(cutoff)
    : db.prepare(foldedSql).all()) as unknown as Array<{
    session_file: string;
    ts: number;
    tokens: number | null;
  }>;
  const foldedSessions = new Set(foldedRows.map((r) => r.session_file));
  let total = foldedRows.reduce((s, r) => s + (r.tokens ?? 0), 0);
  // Sessions without a folded snapshot: sum freshly-recorded obs+reflection tokens.
  if (foldedSessions.size > 0) {
    const placeholders = foldedSessions.size
      ? Array(foldedSessions.size).fill("?").join(",")
      : "''";
    const freshSql = `
			SELECT session_file, SUM(token_count) as tokens
			FROM memory_events
			WHERE folded = 0 AND kind IN ('observation','reflection') ${hasCutoff ? "AND timestamp >= ?" : ""}
			  AND session_file NOT IN (${placeholders})
			GROUP BY session_file
		`;
    const binds: (string | number | null)[] = [];
    if (hasCutoff) binds.push(cutoff);
    binds.push(...foldedSessions);
    const freshRows = db.prepare(freshSql).all(...binds) as unknown as Array<{
      tokens: number | null;
    }>;
    total += freshRows.reduce((s, r) => s + (r.tokens ?? 0), 0);
  } else {
    const freshSql = `
			SELECT SUM(token_count) as tokens FROM memory_events
			WHERE folded = 0 AND kind IN ('observation','reflection') ${hasCutoff ? "AND timestamp >= ?" : ""}
		`;
    const row = (hasCutoff ? db.prepare(freshSql).get(cutoff) : db.prepare(freshSql).get()) as
      { tokens: number | null } | undefined;
    total += row?.tokens ?? 0;
  }
  return total;
}

export function getMemoryTimeseries(
  days = 14,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): MemoryByDay[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket,
			SUM(CASE WHEN kind = 'observation' AND folded = 0 THEN 1 ELSE 0 END) as observations,
			SUM(CASE WHEN kind = 'reflection' AND folded = 0 THEN 1 ELSE 0 END) as reflections,
			SUM(CASE WHEN kind = 'drop' AND folded = 0 THEN 1 ELSE 0 END) as drops
		FROM memory_events
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    observations: number | null;
    reflections: number | null;
    drops: number | null;
  }>;
  return rows.map((r) => ({
    timestamp: r.bucket,
    observations: r.observations ?? 0,
    reflections: r.reflections ?? 0,
    drops: r.drops ?? 0,
  }));
}

export function getMemoryRelevanceDistribution(cutoff?: number | null): MemoryRelevanceBucket[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT relevance, COUNT(*) as count
		FROM memory_events
		WHERE kind = 'observation' AND folded = 0 AND relevance IS NOT NULL
		${hasCutoff ? "AND timestamp >= ?" : ""}
		GROUP BY relevance
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as Array<{
    relevance: string;
    count: number;
  }>;
  const order = ["low", "medium", "high", "critical"];
  return rows.sort((a, b) => order.indexOf(a.relevance) - order.indexOf(b.relevance));
}

/** Live memory-pool token size over time (per day). For each day bucket, the
 *  pool size is approximated by the cumulative freshly-recorded obs+reflection
 *  tokens minus dropped observation tokens up to the end of that bucket. */
export function getMemoryPoolGrowth(
  days = 30,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): MemoryPoolPoint[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  // Cumulative recorded tokens (obs+reflection, folded=0) per bucket, then
  // subtract cumulative dropped observation tokens. Drops carry no token_count,
  // so we subtract the token_count of dropped observation ids that were
  // recorded earlier in the same session — approximated by joining drops to
  // the recorded observation row by memory_id.
  // Cumulative recorded obs+reflection tokens (folded=0) per bucket, minus
  // the token_count of recorded observations that were later dropped in the
  // same session (joined by memory_id). Gives a running live-pool estimate.
  const fixedSql = `
		WITH recorded AS (
			SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket,
				memory_id, session_file, token_count, timestamp
			FROM memory_events
			WHERE kind = 'observation' AND folded = 0 ${hasCutoff ? "AND timestamp >= ?" : ""}
		),
		dropped AS (
			SELECT d.session_file, d.memory_id, (d.timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket
			FROM memory_events d
			WHERE d.kind = 'drop' AND d.folded = 0
		)
		SELECT r.bucket,
			SUM(r.token_count) as recorded_tokens,
			SUM(CASE WHEN dr.memory_id IS NOT NULL THEN r.token_count ELSE 0 END) as dropped_tokens
		FROM recorded r
		LEFT JOIN dropped dr
			ON dr.session_file = r.session_file AND dr.memory_id = r.memory_id
		GROUP BY r.bucket
		ORDER BY r.bucket ASC
	`;
  const binds: (string | number | null)[] = [bucketMs, bucketMs];
  if (hasCutoff) binds.push(seriesCutoff);
  binds.push(bucketMs, bucketMs);
  const rows = db.prepare(fixedSql).all(...binds) as unknown as Array<{
    bucket: number;
    recorded_tokens: number | null;
    dropped_tokens: number | null;
  }>;
  let cumulative = 0;
  return rows.map((r) => {
    cumulative += (r.recorded_tokens ?? 0) - (r.dropped_tokens ?? 0);
    return { timestamp: r.bucket, poolTokens: Math.max(0, cumulative) };
  });
}

export interface MemoryListOptions {
  kind?: string | null;
  relevance?: string | null;
  session?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
  folded?: boolean | null;
}

export function listMemoryEvents(opts: MemoryListOptions = {}): MemoryListResult {
  if (!db) return { items: [], total: 0 };
  const where: string[] = [];
  const binds: (string | number | null)[] = [];
  if (opts.kind && opts.kind !== "all") {
    where.push("kind = ?");
    binds.push(opts.kind);
  }
  if (opts.relevance && opts.relevance !== "all") {
    where.push("relevance = ?");
    binds.push(opts.relevance);
  }
  if (opts.session && opts.session !== "all") {
    where.push("session_file = ?");
    binds.push(opts.session);
  }
  if (opts.q && opts.q.trim()) {
    where.push("content LIKE ?");
    binds.push(`%${opts.q.trim()}%`);
  }
  if (opts.folded === false) {
    where.push("folded = 0");
  } else if (opts.folded === true) {
    where.push("folded = 1");
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);
  const countSql = `SELECT COUNT(*) as total FROM memory_events ${whereSql}`;
  const total = (db.prepare(countSql).get(...binds) as { total: number }).total;
  const listSql = `
		SELECT id, session_file, entry_id, folder, timestamp, kind, memory_id, relevance,
			token_count, covers_up_to_id, content, source_count, folded
		FROM memory_events
		${whereSql}
		ORDER BY timestamp DESC, id DESC
		LIMIT ? OFFSET ?
	`;
  const rows = db.prepare(listSql).all(...binds, limit, offset) as unknown as Array<{
    id: number;
    session_file: string;
    entry_id: string | null;
    folder: string;
    timestamp: number;
    kind: MemoryKind;
    memory_id: string;
    relevance: string | null;
    token_count: number;
    covers_up_to_id: string | null;
    content: string | null;
    source_count: number | null;
    folded: number;
  }>;
  const items: MemoryListItem[] = rows.map((r) => ({
    id: r.id,
    sessionFile: r.session_file,
    entryId: r.entry_id,
    folder: r.folder,
    timestamp: r.timestamp,
    kind: r.kind,
    memoryId: r.memory_id,
    relevance: r.relevance,
    tokenCount: r.token_count,
    coversUpToId: r.covers_up_to_id,
    content: r.content,
    sourceCount: r.source_count,
    folded: r.folded === 1,
  }));
  return { items, total };
}

/** Single memory + the source/support ids stored on its recorded row.
 *  `sourceEntryIds` for observations, `supportingObservationIds` for reflections. */
export function getMemoryById(id: number): MemoryDetail | null {
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT id, session_file, entry_id, folder, timestamp, kind, memory_id, relevance,
				token_count, covers_up_to_id, content, source_count, folded
			FROM memory_events WHERE id = ?`,
    )
    .get(id) as
    | {
        id: number;
        session_file: string;
        entry_id: string | null;
        folder: string;
        timestamp: number;
        kind: MemoryKind;
        memory_id: string;
        relevance: string | null;
        token_count: number;
        covers_up_to_id: string | null;
        content: string | null;
        source_count: number | null;
        folded: number;
      }
    | undefined;
  if (!row) return null;
  const base: MemoryListItem = {
    id: row.id,
    sessionFile: row.session_file,
    entryId: row.entry_id,
    folder: row.folder,
    timestamp: row.timestamp,
    kind: row.kind,
    memoryId: row.memory_id,
    relevance: row.relevance,
    tokenCount: row.token_count,
    coversUpToId: row.covers_up_to_id,
    content: row.content,
    sourceCount: row.source_count,
    folded: row.folded === 1,
  };
  // The source ids weren't stored as an array (only the count was), so expose
  // empty arrays — the raw ids are recoverable from the session JSONL via the
  // entry id / coversUpToId if a future detail pane needs them.
  return {
    ...base,
    sourceEntryIds: row.kind === "observation" ? [] : [],
    supportingObservationIds: row.kind === "reflection" ? [] : [],
  };
}

/** Distinct session files that have memory events (for the browser filter). */
export function listMemorySessions(): string[] {
  if (!db) return [];
  const rows = db
    .prepare("SELECT DISTINCT session_file FROM memory_events ORDER BY session_file")
    .all() as unknown as Array<{ session_file: string }>;
  return rows.map((r) => r.session_file);
}

/* -------------------------------------------------------------------------- */
/* Guard-block queries (impulso-pi)                                          */
/* -------------------------------------------------------------------------- */

export interface GuardSummary {
  totalBlocks: number;
  commitGuard: number;
  commandGuard: number;
  sessions: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export function getGuardSummary(cutoff?: number | null): GuardSummary {
  const empty: GuardSummary = {
    totalBlocks: 0,
    commitGuard: 0,
    commandGuard: 0,
    sessions: 0,
    firstTimestamp: 0,
    lastTimestamp: 0,
  };
  if (!db) return empty;
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT COUNT(*) as total_blocks,
			SUM(CASE WHEN guard = 'commit-guard' THEN 1 ELSE 0 END) as commit_guard,
			SUM(CASE WHEN guard = 'command-guard' THEN 1 ELSE 0 END) as command_guard,
			COUNT(DISTINCT session_file) as sessions,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM guard_events
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
	`;
  const row = (hasCutoff ? db.prepare(sql).get(cutoff) : db.prepare(sql).get()) as
    | {
        total_blocks: number | null;
        commit_guard: number | null;
        command_guard: number | null;
        sessions: number | null;
        first_timestamp: number | null;
        last_timestamp: number | null;
      }
    | undefined;
  if (!row || !row.total_blocks) return empty;
  return {
    totalBlocks: row.total_blocks,
    commitGuard: row.commit_guard ?? 0,
    commandGuard: row.command_guard ?? 0,
    sessions: row.sessions ?? 0,
    firstTimestamp: row.first_timestamp ?? 0,
    lastTimestamp: row.last_timestamp ?? 0,
  };
}

export interface GuardByKind {
  guard: string;
  kind: string;
  blocks: number;
  lastTimestamp: number;
}

export function getGuardByKind(cutoff?: number | null): GuardByKind[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT guard, kind, COUNT(*) as blocks, MAX(timestamp) as last_timestamp
		FROM guard_events
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY guard, kind
		ORDER BY guard, blocks DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as Array<{
    guard: string;
    kind: string;
    blocks: number;
    last_timestamp: number;
  }>;
  return rows.map((r) => ({
    guard: r.guard,
    kind: r.kind,
    blocks: r.blocks,
    lastTimestamp: r.last_timestamp,
  }));
}

export interface GuardByModel {
  model: string;
  blocks: number;
  commitGuard: number;
  commandGuard: number;
}

export function getGuardByModel(cutoff?: number | null): GuardByModel[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT COALESCE(model, 'unknown') as model,
			COUNT(*) as blocks,
			SUM(CASE WHEN guard = 'commit-guard' THEN 1 ELSE 0 END) as commit_guard,
			SUM(CASE WHEN guard = 'command-guard' THEN 1 ELSE 0 END) as command_guard
		FROM guard_events
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model
		ORDER BY blocks DESC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as unknown as Array<{
    model: string;
    blocks: number;
    commit_guard: number | null;
    command_guard: number | null;
  }>;
  return rows.map((r) => ({
    model: r.model,
    blocks: r.blocks,
    commitGuard: r.commit_guard ?? 0,
    commandGuard: r.command_guard ?? 0,
  }));
}

export interface GuardByDay {
  timestamp: number;
  commitGuard: number;
  commandGuard: number;
}

export function getGuardTimeseries(
  days = 14,
  cutoff?: number | null,
  bucketMs = 24 * 60 * 60 * 1000,
): GuardByDay[] {
  if (!db) return [];
  const hasCutoff = cutoff !== null;
  const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;
  const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket,
			SUM(CASE WHEN guard = 'commit-guard' THEN 1 ELSE 0 END) as commit_guard,
			SUM(CASE WHEN guard = 'command-guard' THEN 1 ELSE 0 END) as command_guard
		FROM guard_events
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket
		ORDER BY bucket ASC
	`;
  const rows = (hasCutoff
    ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
    : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
    bucket: number;
    commit_guard: number | null;
    command_guard: number | null;
  }>;
  return rows.map((r) => ({
    timestamp: r.bucket,
    commitGuard: r.commit_guard ?? 0,
    commandGuard: r.command_guard ?? 0,
  }));
}

export interface GuardListItem {
  id: number;
  sessionFile: string;
  entryId: string;
  folder: string;
  timestamp: number;
  guard: string;
  kind: string;
  model: string | null;
  provider: string | null;
  command: string | null;
  reason: string | null;
}

export interface GuardListOptions {
  guard?: string | null;
  kind?: string | null;
  session?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
  cutoff?: number | null;
}

export interface GuardListResult {
  items: GuardListItem[];
  total: number;
}

export function listGuardEvents(opts: GuardListOptions = {}): GuardListResult {
  if (!db) return { items: [], total: 0 };
  const where: string[] = [];
  const binds: (string | number | null)[] = [];
  if (opts.guard && opts.guard !== "all") {
    where.push("guard = ?");
    binds.push(opts.guard);
  }
  if (opts.kind && opts.kind !== "all") {
    where.push("kind = ?");
    binds.push(opts.kind);
  }
  if (opts.session && opts.session !== "all") {
    where.push("session_file = ?");
    binds.push(opts.session);
  }
  if (opts.q && opts.q.trim()) {
    where.push("(command LIKE ? OR reason LIKE ?)");
    const needle = `%${opts.q.trim()}%`;
    binds.push(needle, needle);
  }
  if (opts.cutoff != null && opts.cutoff > 0) {
    where.push("timestamp >= ?");
    binds.push(opts.cutoff);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);
  const total = (
    db.prepare(`SELECT COUNT(*) as total FROM guard_events ${whereSql}`).get(...binds) as {
      total: number;
    }
  ).total;
  const listSql = `
		SELECT id, session_file, entry_id, folder, timestamp, guard, kind,
			model, provider, command, reason
		FROM guard_events
		${whereSql}
		ORDER BY timestamp DESC, id DESC
		LIMIT ? OFFSET ?
	`;
  const rows = db.prepare(listSql).all(...binds, limit, offset) as unknown as Array<{
    id: number;
    session_file: string;
    entry_id: string;
    folder: string;
    timestamp: number;
    guard: string;
    kind: string;
    model: string | null;
    provider: string | null;
    command: string | null;
    reason: string | null;
  }>;
  const items: GuardListItem[] = rows.map((r) => ({
    id: r.id,
    sessionFile: r.session_file,
    entryId: r.entry_id,
    folder: r.folder,
    timestamp: r.timestamp,
    guard: r.guard,
    kind: r.kind,
    model: r.model,
    provider: r.provider,
    command: r.command,
    reason: r.reason,
  }));
  return { items, total };
}

/** Distinct session files that have guard events (for the browser filter). */
export function listGuardSessions(): string[] {
  if (!db) return [];
  const rows = db
    .prepare("SELECT DISTINCT session_file FROM guard_events ORDER BY session_file")
    .all() as unknown as Array<{ session_file: string }>;
  return rows.map((r) => r.session_file);
}

/** Per-call rows for search-related tools, in per-session insertion order
 *  (rowid = parse order = JSONL order; session files are append-only) so the
 *  search-mix aggregator can detect cross-turn "exact search after
 *  zvec_search" fallbacks. */
export interface SearchCallRow {
  sessionFile: string;
  entryId: string;
  toolName: string;
  timestamp: number;
  durationMs: number | null;
  isError: boolean;
}

const SEARCH_TOOLS = ["zvec_search", "grep", "find", "zvec_status", "zvec_index"];

export function getSearchCallRows(cutoff?: number): SearchCallRow[] {
  if (!db) return [];
  const hasCutoff = cutoff !== undefined && cutoff > 0;
  const sql = `
		SELECT session_file, entry_id, tool_name, timestamp, duration_ms, is_error
		FROM tool_calls
		WHERE tool_name IN (${SEARCH_TOOLS.map(() => "?").join(", ")})
		${hasCutoff ? "AND timestamp >= ?" : ""}
		ORDER BY session_file, id
	`;
  const binds = hasCutoff ? [...SEARCH_TOOLS, cutoff] : SEARCH_TOOLS;
  const rows = db.prepare(sql).all(...binds) as unknown as Array<{
    session_file: string;
    entry_id: string;
    tool_name: string;
    timestamp: number;
    duration_ms: number | null;
    is_error: number | null;
  }>;
  return rows.map((row) => ({
    sessionFile: row.session_file,
    entryId: row.entry_id,
    toolName: row.tool_name,
    timestamp: row.timestamp,
    durationMs: row.duration_ms,
    isError: row.is_error === 1,
  }));
}

/** User-message timestamps per session (insertion order) — the turn
 *  boundaries used by the search-mix fallback detector. */
export function getUserTurnTimestamps(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!db) return out;
  const rows = db
    .prepare("SELECT session_file, timestamp FROM user_messages ORDER BY session_file, id")
    .all() as unknown as Array<{ session_file: string; timestamp: number }>;
  for (const row of rows) {
    const arr = out.get(row.session_file) ?? [];
    arr.push(row.timestamp);
    out.set(row.session_file, arr);
  }
  return out;
}
