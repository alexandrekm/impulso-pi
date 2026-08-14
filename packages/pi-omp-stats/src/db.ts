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
	CostTimeSeriesPoint,
	FolderStats,
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
} from "./types.js";
import type { AgentTypeStats } from "./shared-types.js";

const ZERO_USAGE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

let db: DatabaseSync | null = null;

/** Path to the stats SQLite database: `<statsDir>/pi-omp-stats.db`. */
export function getStatsDbPath(): string {
	return path.join(resolveStatsDir(), "pi-omp-stats.db");
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
	`);

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

export function getFileOffset(sessionFile: string): { offset: number; lastModified: number } | null {
	if (!db) return null;
	const row = db.prepare("SELECT offset, last_modified FROM file_offsets WHERE session_file = ?").get(sessionFile) as
		| { offset: number; last_modified: number }
		| undefined;
	return row ? { offset: row.offset, lastModified: row.last_modified } : null;
}

export function setFileOffset(sessionFile: string, offset: number, lastModified: number): void {
	if (!db) return;
	db.prepare("INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
		sessionFile,
		offset,
		lastModified,
	);
}

/** The folder/cwd label last applied to a session file's rows, if known. */
export function getFolderLabel(sessionFile: string): string | null {
	if (!db) return null;
	const row = db.prepare("SELECT folder FROM folder_sessions WHERE session_file = ?").get(sessionFile) as
		| { folder: string }
		| undefined;
	return row ? row.folder : null;
}

export function setFolderLabel(sessionFile: string, folder: string): void {
	if (!db) return;
	db.prepare("INSERT OR REPLACE INTO folder_sessions (session_file, folder) VALUES (?, ?)").run(sessionFile, folder);
}

/** Relabel every row a session file owns with a (new) folder. Indexed by
 * `session_file`; idempotent. Used to fix rows persisted before header-cwd
 * folder parsing landed. */
export function relabelSessionFolder(sessionFile: string, folder: string): void {
	if (!db) return;
	for (const table of ["messages", "user_messages", "tool_calls"]) {
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
	const stmt = db.prepare(
		"UPDATE tool_calls SET result_chars = ?, is_error = ? WHERE session_file = ? AND tool_call_id = ? AND result_chars IS NULL",
	);
	let updated = 0;
	tx(() => {
		for (const link of links) {
			const result = stmt.run(link.resultChars, link.isError ? 1 : 0, link.sessionFile, link.toolCallId);
			updated += Number(result.changes);
		}
	});
	return updated;
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
		cacheRate: totalInputTokens + totalCacheReadTokens > 0 ? totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens) : 0,
		cacheSavings: noCacheInputCost > 0 ? (noCacheInputCost - cachedPromptCost) / noCacheInputCost : 0,
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
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all()) as unknown as AggregatedStatsRow[];
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
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all()) as unknown as ModelStatsRow[];
	return rows.map(row => ({ model: row.model, provider: row.provider, ...buildAggregatedStats([row]) }));
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
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all()) as unknown as FolderStatsRow[];
	return rows.map(row => ({ folder: row.folder, ...buildAggregatedStats([row]) }));
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
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all()) as unknown as Array<{
		agent_type: string;
		total_requests: number;
		total_input_tokens: number | null;
		total_output_tokens: number | null;
		total_cache_read_tokens: number | null;
		total_cache_write_tokens: number | null;
		total_cost: number | null;
	}>;
	return rows.map(row => ({
		agentType: (row.agent_type as AgentType) ?? "main",
		totalRequests: row.total_requests || 0,
		totalInputTokens: row.total_input_tokens || 0,
		totalOutputTokens: row.total_output_tokens || 0,
		totalCacheReadTokens: row.total_cache_read_tokens || 0,
		totalCacheWriteTokens: row.total_cache_write_tokens || 0,
		totalCost: row.total_cost || 0,
	}));
}

export function getTimeSeries(hours = 24, cutoff?: number | null, bucketMs = 60 * 60 * 1000): TimeSeriesPoint[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? cutoff ?? Date.now() - hours * 60 * 60 * 1000 : 0;
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
	const rows = (hasCutoff ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff) : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
		bucket: number;
		requests: number;
		errors: number | null;
		tokens: number | null;
		cost: number | null;
	}>;
	return rows.map(row => ({
		timestamp: row.bucket,
		requests: row.requests,
		errors: row.errors ?? 0,
		tokens: row.tokens ?? 0,
		cost: row.cost ?? 0,
	}));
}

export function getModelTimeSeries(days = 14, cutoff?: number | null, bucketMs = 24 * 60 * 60 * 1000): ModelTimeSeriesPoint[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
	const sql = `
		SELECT (timestamp / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucket, model, provider, COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`;
	const rows = (hasCutoff
		? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff)
		: db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{ bucket: number; model: string; provider: string; requests: number }>;
	return rows.map(row => ({ timestamp: row.bucket, model: row.model, provider: row.provider, requests: row.requests }));
}

export function getModelPerformanceSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ModelPerformancePoint[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
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
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
	}));
}

export function getCostTimeSeries(days = 90, cutoff?: number | null, bucketMs = 24 * 60 * 60 * 1000): CostTimeSeriesPoint[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
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
	const rows = (hasCutoff ? db.prepare(sql).all(bucketMs, bucketMs, seriesCutoff) : db.prepare(sql).all(bucketMs, bucketMs)) as unknown as Array<{
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
	return rows.map(row => ({
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
	const rows = db.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?").all(limit) as Record<string, unknown>[];
	return rows.map(rowToMessageStats);
}

export function getRecentErrors(limit = 100, cutoff?: number | null): MessageStats[] {
	if (!db) return [];
	const hasCutoff = cutoff !== undefined && cutoff !== null;
	const sql = `SELECT * FROM messages WHERE stop_reason = 'error' ${
		hasCutoff ? "AND timestamp >= ? " : ""
	}ORDER BY timestamp DESC LIMIT ?`;
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff, limit) : db.prepare(sql).all(limit)) as Record<string, unknown>[];
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
	return rows.map(row => ({
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
	return rows.map(row => ({
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
	MAX(t.timestamp) as last_used
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
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all()) as unknown as ToolAggregateRow[];
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
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all()) as unknown as ToolAggregateRow[];
	return rows.map(row => ({ ...rowToToolUsage(row), model: row.model ?? "", provider: row.provider ?? "" }));
}

export function getToolTimeSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ToolTimeSeriesPoint[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
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
	return rows.map(row => ({
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
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all()) as unknown as Array<{
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
	return rows.map(row => ({
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
	const rows = (hasCutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all()) as unknown as Array<{
		provider: string;
		hour: number;
		total_tokens: number | null;
		output_tokens: number | null;
		requests: number;
	}>;
	return rows.map(row => ({
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
	const seriesCutoff = hasCutoff ? cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
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
	return rows.map(row => ({
		timestamp: row.bucket,
		provider: row.provider,
		totalTokens: row.total_tokens ?? 0,
		cost: row.cost ?? 0,
		requests: row.requests,
	}));
}
