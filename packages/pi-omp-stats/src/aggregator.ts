/**
 * @fileoverview Sync orchestration + dashboard stats accessors.
 *
 * Node port of omp-stats `aggregator.ts`. The port simplifies away omp's
 * worker pool (parsing is serial — omp already does this on macOS), the
 * cross-process sync lock (the CLI is the only writer and the
 * `file_offsets` mtime check makes overlapping syncs cheap no-ops), the
 * usage-window/auth-broker provider analytics, and the gain aggregator
 * (omp-specific). The HTTP API shapes are kept byte-compatible with omp.
 *
 * MIT, © Can Boluk (original omp-stats); ported for the impulso-pi package.
 */

import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import {
  getBehaviorByModel,
  getBehaviorOverall,
  getBehaviorTimeSeries,
  getCompactionByModel,
  getCompactionByReason,
  getCompactionSummary,
  getCompactionTimeseries,
  getCompactionTokensBeforeDistribution,
  getCostTimeSeries,
  getFileOffset,
  getFolderLabel,
  getGuardByKind,
  getGuardByModel,
  getGuardSummary,
  getGuardTimeseries,
  getMemoryById,
  getMemoryPoolGrowth,
  getMemoryRelevanceDistribution,
  getMemorySummary,
  getMemoryTimeseries,
  getMessageById,
  getMessageCount,
  getStatsDbPath,
  getModelPerformanceSeries,
  getModelTimeSeries,
  getOverallStats,
  getProviderHourlyBurn,
  getProviderTimeSeries,
  getRecentErrors as dbGetRecentErrors,
  getRecentRequests as dbGetRecentRequests,
  getStatsByAgentType,
  getStatsByFolder,
  getStatsByModel,
  getStatsByProvider,
  getToolStats,
  getToolStatsByModel,
  getToolTimeSeries,
  getTimeSeries,
  initDb,
  insertCompactionStats,
  insertGuardEvents,
  insertMemoryEvents,
  insertMessageStats,
  insertToolCalls,
  insertUserMessageStats,
  listGuardEvents,
  listGuardSessions,
  listMemoryEvents,
  listMemorySessions,
  markSessionBackfillsComplete,
  relabelSessionFolder,
  setStatsDatabase,
  setFileOffset,
  setFolderLabel,
  updateToolResults,
  updateUserMessageLinks,
} from "./db.js";
import {
  getSessionEntry,
  listAllSessionFiles,
  parseSessionFile,
  readSessionFolder,
  resolveSessionsDir,
  resolveSessionsSources,
  type SessionsSource,
} from "./parser.js";
import type {
  BehaviorDashboardStats,
  DashboardStats,
  ProviderDashboardStats,
  ToolDashboardStats,
} from "./shared-types.js";
import type {
  CostTimeSeriesPoint,
  MessageStats,
  ParseSessionResult,
  RequestDetails,
  TimeSeriesPoint,
} from "./types.js";

/** Apply a freshly parsed result to the database (single SQLite handle). */
function applyParseResult(
  sessionFile: string,
  lastModified: number,
  result: ParseSessionResult,
): number {
  if (result.stats.length > 0) insertMessageStats(result.stats);
  if (result.userStats.length > 0) insertUserMessageStats(result.userStats);
  if (result.userLinks.length > 0) updateUserMessageLinks(result.userLinks);
  if (result.toolCalls.length > 0) insertToolCalls(result.toolCalls);
  if (result.toolResults.length > 0) updateToolResults(result.toolResults);
  if (result.compactions.length > 0) insertCompactionStats(result.compactions);
  if (result.memoryEvents.length > 0) insertMemoryEvents(result.memoryEvents);
  if (result.guardEvents.length > 0) insertGuardEvents(result.guardEvents);
  if (result.folder) {
    // Relabel all of this file's rows (old + new) with the header-derived
    // folder. Indexed UPDATE; idempotent, and fixes rows persisted before
    // header-cwd parsing landed.
    relabelSessionFolder(sessionFile, result.folder);
    setFolderLabel(sessionFile, result.folder);
  }
  setFileOffset(sessionFile, result.newOffset, lastModified);
  return result.stats.length + result.userStats.length;
}

/** Progress event emitted after each session file is processed. */
export interface SyncProgress {
  current: number;
  total: number;
  processed: number;
  sessionFile: string;
}

export interface SyncOptions {
  onProgress?: (event: SyncProgress) => void;
}

/**
 * Sync all session files to the database. Parses serially (no worker pool);
 * each file is parsed only past its stored byte offset, and skipped entirely
 * when its mtime is unchanged. `onProgress` fires once per completed file.
 */
async function syncSessionsSource(
  source: SessionsSource,
  opts?: SyncOptions,
): Promise<{ processed: number; files: number }> {
  await initDb();

  const files = await listAllSessionFiles(source.dir);
  let totalProcessed = 0;
  let filesProcessed = 0;
  let completed = 0;

  if (files.length === 0) {
    markSessionBackfillsComplete();
    return { processed: 0, files: 0 };
  }

  for (const sessionFile of files) {
    let fileStats: Stats;
    try {
      fileStats = await fs.stat(sessionFile);
    } catch {
      completed++;
      opts?.onProgress?.({
        current: completed,
        total: files.length,
        processed: totalProcessed,
        sessionFile,
      });
      continue;
    }
    const lastModified = fileStats.mtimeMs;
    const stored = getFileOffset(sessionFile);
    if (stored && stored.lastModified >= lastModified) {
      // File unchanged. The folder label may still be outdated (e.g. synced
      // before header-cwd parsing). Read just the header to refine it; if it
      // changed, relabel this file's rows with a cheap indexed UPDATE (no
      // re-parse, no offset reset).
      const folder = await readSessionFolder(sessionFile);
      if (folder !== getFolderLabel(sessionFile)) {
        relabelSessionFolder(sessionFile, folder);
        setFolderLabel(sessionFile, folder);
      }
      completed++;
      opts?.onProgress?.({
        current: completed,
        total: files.length,
        processed: totalProcessed,
        sessionFile,
      });
      continue;
    }

    const fromOffset = stored?.offset ?? 0;
    const result = await parseSessionFile(sessionFile, fromOffset);
    const inserted = applyParseResult(sessionFile, lastModified, result);
    if (inserted > 0) {
      totalProcessed += inserted;
      filesProcessed++;
    }
    completed++;
    opts?.onProgress?.({
      current: completed,
      total: files.length,
      processed: totalProcessed,
      sessionFile,
    });
  }

  markSessionBackfillsComplete();
  return { processed: totalProcessed, files: filesProcessed };
}

/**
 * Sync every discovered profile to both its own database and the aggregate
 * database. Without `PI_STATS_PROFILES_DIR`, retain legacy single-directory
 * behavior and store it in the aggregate database only.
 */
export async function syncAllSessions(
  opts?: SyncOptions,
): Promise<{ processed: number; files: number }> {
  const sources = await resolveSessionsSources();
  if (sources.length === 0) {
    setStatsDatabase();
    await initDb();
    markSessionBackfillsComplete();
    return { processed: 0, files: 0 };
  }

  let processed = 0;
  let files = 0;
  const profilesMode = Boolean(process.env.PI_STATS_PROFILES_DIR?.trim());
  for (const source of sources) {
    if (profilesMode) {
      setStatsDatabase(source.id);
      const result = await syncSessionsSource(source, opts);
      processed += result.processed;
      files += result.files;
    }
    setStatsDatabase();
    const result = await syncSessionsSource(source, opts);
    processed += result.processed;
    files += result.files;
  }
  setStatsDatabase();
  return { processed, files };
}

/** Profile names available to the dashboard, including the aggregate view. */
export async function getAvailableProfiles(): Promise<string[]> {
  const sources = await resolveSessionsSources();
  return process.env.PI_STATS_PROFILES_DIR?.trim() ? ["all", ...sources.map((s) => s.id)] : ["all"];
}

/** Select the aggregate database or an individual profile database. */
export function selectProfile(profile?: string | null): void {
  setStatsDatabase(profile);
}

/* -------------------------------------------------------------------------- */
/* Time-range config (ported from omp)                                        */
/* -------------------------------------------------------------------------- */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_MIN_MS = 5 * 60 * 1000;

type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

interface TimeRangeConfig {
  timeSeriesHours: number;
  timeSeriesBucketMs: number;
  modelSeriesDays: number;
  modelSeriesBucketMs: number;
  modelPerformanceDays: number;
  modelPerformanceBucketMs: number;
  costSeriesDays: number;
  cutoff: number | null;
}

const DEFAULT_TIME_RANGE: TimeRange = "24h";

const TIME_RANGE_TO_CONFIG: Record<TimeRange, Omit<TimeRangeConfig, "cutoff">> = {
  "1h": {
    timeSeriesHours: 1,
    timeSeriesBucketMs: FIVE_MIN_MS,
    modelSeriesDays: 1,
    modelSeriesBucketMs: FIVE_MIN_MS,
    modelPerformanceDays: 1,
    modelPerformanceBucketMs: FIVE_MIN_MS,
    costSeriesDays: 1,
  },
  "24h": {
    timeSeriesHours: 24,
    timeSeriesBucketMs: HOUR_MS,
    modelSeriesDays: 1,
    modelSeriesBucketMs: HOUR_MS,
    modelPerformanceDays: 1,
    modelPerformanceBucketMs: HOUR_MS,
    costSeriesDays: 1,
  },
  "7d": {
    timeSeriesHours: 24 * 7,
    timeSeriesBucketMs: DAY_MS,
    modelSeriesDays: 7,
    modelSeriesBucketMs: DAY_MS,
    modelPerformanceDays: 7,
    modelPerformanceBucketMs: DAY_MS,
    costSeriesDays: 7,
  },
  "30d": {
    timeSeriesHours: 24 * 30,
    timeSeriesBucketMs: DAY_MS,
    modelSeriesDays: 30,
    modelSeriesBucketMs: DAY_MS,
    modelPerformanceDays: 30,
    modelPerformanceBucketMs: DAY_MS,
    costSeriesDays: 30,
  },
  "90d": {
    timeSeriesHours: 24 * 90,
    timeSeriesBucketMs: DAY_MS,
    modelSeriesDays: 90,
    modelSeriesBucketMs: DAY_MS,
    modelPerformanceDays: 90,
    modelPerformanceBucketMs: DAY_MS,
    costSeriesDays: 90,
  },
  all: {
    timeSeriesHours: 24 * 3650,
    timeSeriesBucketMs: DAY_MS,
    modelSeriesDays: 3650,
    modelSeriesBucketMs: DAY_MS,
    modelPerformanceDays: 3650,
    modelPerformanceBucketMs: DAY_MS,
    costSeriesDays: 3650,
  },
};

export function getTimeRangeConfig(range?: string | null): TimeRangeConfig {
  const normalized = range?.trim().toLowerCase() ?? DEFAULT_TIME_RANGE;
  const config = TIME_RANGE_TO_CONFIG[normalized as TimeRange];
  if (config) {
    const cutoff =
      normalized === "all"
        ? null
        : Date.now() - Math.max(1, config.timeSeriesHours * 60 * 60 * 1000);
    return { ...config, cutoff };
  }
  const fallback = TIME_RANGE_TO_CONFIG[DEFAULT_TIME_RANGE];
  return { ...fallback, cutoff: Date.now() - fallback.timeSeriesHours * 60 * 60 * 1000 };
}

/* -------------------------------------------------------------------------- */
/* Dashboard accessors                                                         */
/* -------------------------------------------------------------------------- */

export async function getDashboardStats(range?: string | null): Promise<DashboardStats> {
  await initDb();
  const {
    timeSeriesHours,
    timeSeriesBucketMs,
    modelSeriesDays,
    modelSeriesBucketMs,
    modelPerformanceDays,
    modelPerformanceBucketMs,
    costSeriesDays,
    cutoff,
  } = getTimeRangeConfig(range);
  return {
    overall: getOverallStats(cutoff ?? undefined),
    byModel: getStatsByModel(cutoff ?? undefined),
    byFolder: getStatsByFolder(cutoff ?? undefined),
    byAgentType: getStatsByAgentType(cutoff ?? undefined),
    timeSeries: getTimeSeries(timeSeriesHours, cutoff, timeSeriesBucketMs),
    modelSeries: getModelTimeSeries(modelSeriesDays, cutoff, modelSeriesBucketMs),
    modelPerformanceSeries: getModelPerformanceSeries(
      modelPerformanceDays,
      cutoff,
      modelPerformanceBucketMs,
    ),
    costSeries: getCostTimeSeries(costSeriesDays, cutoff),
  };
}

export async function getOverviewStats(
  range?: string | null,
): Promise<Pick<DashboardStats, "overall" | "byAgentType" | "timeSeries">> {
  await initDb();
  const { timeSeriesHours, timeSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
  return {
    overall: getOverallStats(cutoff ?? undefined),
    byAgentType: getStatsByAgentType(cutoff ?? undefined),
    timeSeries: getTimeSeries(timeSeriesHours, cutoff, timeSeriesBucketMs),
  };
}

export async function getModelDashboardStats(
  range?: string | null,
): Promise<Pick<DashboardStats, "byModel" | "modelSeries" | "modelPerformanceSeries">> {
  await initDb();
  const {
    modelSeriesDays,
    modelSeriesBucketMs,
    modelPerformanceDays,
    modelPerformanceBucketMs,
    cutoff,
  } = getTimeRangeConfig(range);
  return {
    byModel: getStatsByModel(cutoff ?? undefined),
    modelSeries: getModelTimeSeries(modelSeriesDays, cutoff, modelSeriesBucketMs),
    modelPerformanceSeries: getModelPerformanceSeries(
      modelPerformanceDays,
      cutoff,
      modelPerformanceBucketMs,
    ),
  };
}

export async function getCostDashboardStats(
  range?: string | null,
): Promise<Pick<DashboardStats, "costSeries">> {
  await initDb();
  const { costSeriesDays, cutoff } = getTimeRangeConfig(range);
  return { costSeries: getCostTimeSeries(costSeriesDays, cutoff) };
}

/**
 * Time series for a range with an optional bucket-size override. The default
 * keeps the range-config granularity (byte-compatible with omp's
 * `/api/stats/timeseries`); `bucketMs` lets a client request finer buckets
 * (e.g. 2h) for a smoother curve over long windows.
 */
export async function getTimeSeriesForRange(
  range?: string | null,
  bucketMs?: number,
): Promise<TimeSeriesPoint[]> {
  await initDb();
  const { timeSeriesHours, timeSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
  return getTimeSeries(
    timeSeriesHours,
    cutoff,
    bucketMs && bucketMs > 0 ? bucketMs : timeSeriesBucketMs,
  );
}

/**
 * Per-(bucket, model) cost time series with an optional bucket-size override.
 * Default keeps the range-config granularity (day buckets, byte-compatible);
 * `bucketMs` enables finer per-model cost buckets for a stacked cost chart.
 */
export async function getCostSeriesForRange(
  range?: string | null,
  bucketMs?: number,
): Promise<CostTimeSeriesPoint[]> {
  await initDb();
  const { costSeriesDays, cutoff } = getTimeRangeConfig(range);
  return getCostTimeSeries(
    costSeriesDays,
    cutoff,
    bucketMs && bucketMs > 0 ? bucketMs : 24 * 60 * 60 * 1000,
  );
}

export async function getBehaviorDashboardStats(
  range?: string | null,
): Promise<BehaviorDashboardStats> {
  await initDb();
  const { cutoff } = getTimeRangeConfig(range);
  return {
    overall: getBehaviorOverall(cutoff),
    byModel: getBehaviorByModel(cutoff),
    behaviorSeries: getBehaviorTimeSeries(cutoff),
  };
}

export async function getToolDashboardStats(range?: string | null): Promise<ToolDashboardStats> {
  await initDb();
  const { modelSeriesDays, modelSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
  return {
    byTool: getToolStats(cutoff ?? undefined),
    byToolModel: getToolStatsByModel(cutoff ?? undefined),
    series: getToolTimeSeries(modelSeriesDays, cutoff, modelSeriesBucketMs),
  };
}

/**
 * Providers dashboard payload. Only the portable subset is populated;
 * `usageSeries`/`windowInsights` are always empty — they derive from omp's
 * auth-broker usage-limit snapshots, which the port does not read.
 * TODO(port): wire usage-window analytics if a fork-agnostic source exists.
 */
export async function getProviderDashboardStats(
  range?: string | null,
): Promise<ProviderDashboardStats> {
  await initDb();
  const { modelSeriesDays, modelSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
  return {
    providers: getStatsByProvider(cutoff ?? undefined),
    hourly: getProviderHourlyBurn(cutoff ?? undefined),
    series: getProviderTimeSeries(modelSeriesDays, cutoff, modelSeriesBucketMs),
    usageSeries: [],
    windowInsights: [],
  };
}

export async function getRecentRequests(limit?: number): Promise<MessageStats[]> {
  await initDb();
  return dbGetRecentRequests(limit);
}

export async function getRecentErrors(
  range?: string | null,
  limit?: number,
): Promise<MessageStats[]> {
  await initDb();
  const { cutoff } = getTimeRangeConfig(range);
  return dbGetRecentErrors(limit, cutoff);
}

export async function getRequestDetails(id: number): Promise<RequestDetails | null> {
  await initDb();
  const msg = getMessageById(id);
  if (!msg) return null;
  const entry = await getSessionEntry(msg.sessionFile, msg.entryId);
  if (entry?.type !== "message") return null;
  return { ...msg, messages: [entry], output: (entry as { message?: unknown }).message };
}

export async function getTotalMessageCount(): Promise<number> {
  await initDb();
  return getMessageCount();
}

/** Resolve the sessions dir the server/CLI will sync from (exposed for display). */
export function getSessionsDirPath(): string {
  return resolveSessionsDir();
}

/** Resolve the stats DB path (exposed for display). */
export function getStatsDbPathForDisplay(): string {
  return getStatsDbPath();
}

/** Resolve the stats dir (DB home). Exposed for display. */
export function getStatsDirPath(): string {
  return path.dirname(getStatsDbPath());
}

/* -------------------------------------------------------------------------- */
/* Compaction + memory dashboard accessors (impulso-pi)                        */
/* -------------------------------------------------------------------------- */

export async function getCompactionDashboardStats(range?: string | null) {
  await initDb();
  const { modelSeriesDays, modelSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
  return {
    summary: getCompactionSummary(cutoff),
    byModel: getCompactionByModel(cutoff),
    byReason: getCompactionByReason(cutoff),
    timeseries: getCompactionTimeseries(modelSeriesDays, cutoff, modelSeriesBucketMs),
    tokensBeforeDistribution: getCompactionTokensBeforeDistribution(10000, cutoff),
  };
}

export async function getCompactionTokensBefore(range?: string | null, model?: string | null) {
  await initDb();
  const { cutoff } = getTimeRangeConfig(range);
  return { buckets: getCompactionTokensBeforeDistribution(10000, cutoff, model) };
}

export async function getMemoryDashboardStats(range?: string | null) {
  await initDb();
  const { modelSeriesDays, modelSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
  return {
    summary: getMemorySummary(cutoff),
    timeseries: getMemoryTimeseries(modelSeriesDays, cutoff, modelSeriesBucketMs),
    relevance: getMemoryRelevanceDistribution(cutoff),
    poolGrowth: getMemoryPoolGrowth(30, cutoff),
  };
}

export async function getMemoryList(opts: {
  range?: string | null;
  kind?: string | null;
  relevance?: string | null;
  session?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
}) {
  await initDb();
  return listMemoryEvents({
    kind: opts.kind,
    relevance: opts.relevance,
    session: opts.session,
    q: opts.q,
    limit: opts.limit,
    offset: opts.offset,
    folded: false,
  });
}

export async function getMemoryDetail(id: number) {
  await initDb();
  return getMemoryById(id);
}

export async function getMemorySessions() {
  await initDb();
  return listMemorySessions();
}

/* -------------------------------------------------------------------------- */
/* Guard-block dashboard accessors (impulso-pi)                               */
/* -------------------------------------------------------------------------- */

export async function getGuardDashboardStats(range?: string | null) {
  await initDb();
  const { modelSeriesDays, modelSeriesBucketMs, cutoff } = getTimeRangeConfig(range);
  return {
    summary: getGuardSummary(cutoff),
    byKind: getGuardByKind(cutoff),
    byModel: getGuardByModel(cutoff),
    timeseries: getGuardTimeseries(modelSeriesDays, cutoff, modelSeriesBucketMs),
  };
}

export async function getGuardList(opts: {
  range?: string | null;
  guard?: string | null;
  kind?: string | null;
  session?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
}) {
  await initDb();
  const { cutoff } = getTimeRangeConfig(opts.range);
  return listGuardEvents({
    guard: opts.guard,
    kind: opts.kind,
    session: opts.session,
    q: opts.q,
    limit: opts.limit,
    offset: opts.offset,
    cutoff,
  });
}

export async function getGuardSessions() {
  await initDb();
  return listGuardSessions();
}
