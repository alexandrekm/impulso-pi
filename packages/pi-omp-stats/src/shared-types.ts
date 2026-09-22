/**
 * @fileoverview Shared aggregation shapes consumed by the server API and the
 * dashboard client.
 *
 * Ported from `omp-stats` `shared-types.ts` (MIT, © Can Boluk),
 * trimmed to the endpoints the port implements. The gain and usage-window
 * types are dropped (omp-specific: snapcompact / auth-broker); the provider
 * usage-window fields are retained as empty arrays on the response for byte
 * compatibility with a future omp-client swap.
 */

/** Aggregated stats for a model or folder. */
export interface AggregatedStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Percentage of prompt input tokens served from cache (0-1). */
  cacheRate: number;
  /**
   * Prompt-input cost saved relative to billing the same tokens uncached
   * (0-1; negative when cache writes cost more than reads save).
   */
  cacheSavings: number;
  totalCost: number;
  totalPremiumRequests: number;
  avgDuration: number | null;
  avgTtft: number | null;
  avgTokensPerSecond: number | null;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface ModelStats extends AggregatedStats {
  model: string;
  provider: string;
}

export interface FolderStats extends AggregatedStats {
  folder: string;
}

export interface TimeSeriesPoint {
  timestamp: number;
  requests: number;
  errors: number;
  tokens: number;
  cost: number;
}

export interface ModelTimeSeriesPoint {
  timestamp: number;
  model: string;
  provider: string;
  requests: number;
}

export interface ModelPerformancePoint {
  timestamp: number;
  model: string;
  provider: string;
  requests: number;
  avgTtft: number | null;
  avgTokensPerSecond: number | null;
}

export interface CostTimeSeriesPoint {
  timestamp: number;
  model: string;
  provider: string;
  cost: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  requests: number;
}

export type AgentType = "main" | "subagent" | "advisor";

export interface AgentTypeStats {
  agentType: AgentType;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCost: number;
}

export interface DashboardStats {
  overall: AggregatedStats;
  byModel: ModelStats[];
  byFolder: FolderStats[];
  byAgentType: AgentTypeStats[];
  timeSeries: TimeSeriesPoint[];
  modelSeries: ModelTimeSeriesPoint[];
  modelPerformanceSeries: ModelPerformancePoint[];
  costSeries: CostTimeSeriesPoint[];
}

/* Passive pi-subagents lifecycle telemetry. */

export interface SubagentRunSummary {
  totalRuns: number;
  completed: number;
  failed: number;
  stopped: number;
  partial: number;
  rejected: number;
  totalDurationMs: number;
  medianDurationMs: number | null;
  totalTokens: number;
  totalCost: number;
}

export interface SubagentRunBreakdown {
  role: string;
  model: string;
  context: string;
  runs: number;
  totalTokens: number;
  totalCost: number;
}

export interface SubagentDashboardStats {
  summary: SubagentRunSummary;
  breakdown: SubagentRunBreakdown[];
}

/* Behavior / "rage" analytics (ported from omp; pure string analysis). */

export interface BehaviorTimeSeriesPoint {
  timestamp: number;
  model: string;
  provider: string;
  messages: number;
  yelling: number;
  profanity: number;
  anguish: number;
  negation: number;
  repetition: number;
  blame: number;
  chars: number;
}

export interface BehaviorOverallStats {
  totalMessages: number;
  totalYelling: number;
  totalProfanity: number;
  totalAnguish: number;
  totalNegation: number;
  totalRepetition: number;
  totalBlame: number;
  totalChars: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface BehaviorModelStats {
  model: string;
  provider: string;
  totalMessages: number;
  totalYelling: number;
  totalProfanity: number;
  totalAnguish: number;
  totalNegation: number;
  totalRepetition: number;
  totalBlame: number;
  totalChars: number;
  lastTimestamp: number;
}

export interface BehaviorDashboardStats {
  overall: BehaviorOverallStats;
  byModel: BehaviorModelStats[];
  behaviorSeries: BehaviorTimeSeriesPoint[];
}

/* Tools. */

export interface ToolUsageStats {
  tool: string;
  calls: number;
  errors: number;
  argsChars: number;
  resultChars: number;
  totalTokensShare: number;
  outputTokensShare: number;
  costShare: number;
  lastUsed: number;
  /** Avg per-call wait (assistant entry → tool result entry), null when no
   *  call in range has a measured duration. */
  avgDurationMs: number | null;
  totalDurationMs: number;
}

/** zvec vs exact-search mix, per-tool wait time, and zvec fallback rate. */
export interface SearchMixStats {
  zvecCalls: number;
  /** zvec_search calls followed by a grep/find call later in the same user
   *  turn (before the next user message) — the model didn't settle for the
   *  semantic result and re-searched exactly. */
  zvecFallbacks: number;
  fallbackRate: number;
  perTool: Array<{
    tool: string;
    calls: number;
    avgDurationMs: number | null;
    totalDurationMs: number;
    errorRate: number;
  }>;
}

/* Search adoption (zvec enablement tracking). Sessions are compared across
 * an enablement cutoff (`since`) to answer "did investigation get cheaper
 * after zvec was actually usable". */
export interface SearchAdoptionPeriod {
  label: "before" | "after";
  sessions: number;
  avgTurns: number;
  avgWallClockMin: number;
  avgTokens: number;
  avgSearchCalls: number;
  avgZvecCalls: number;
  avgZvecSearchMs: number | null;
  zvecAdoptionPct: number;
  zvecErrors: number;
}

export interface SearchAdoptionStats {
  /** The enablement cutoff actually used (ms epoch). */
  since: number;
  sinceLabel: string;
  periodBefore: SearchAdoptionPeriod;
  periodAfter: SearchAdoptionPeriod;
  timeseries: Array<{
    timestamp: number;
    zvecSearch: number;
    zvecErrors: number;
    exact: number;
  }>;
  /** Recent sessions with per-session search-tool usage (table rows). */
  sessions: Array<{
    sessionFile: string;
    folder: string;
    startTs: number;
    endTs: number;
    turns: number;
    requests: number;
    tokens: number;
    zvecCalls: number;
    zvecSearchCalls: number;
    zvecErrors: number;
    zvecSearchAvgMs: number | null;
    exactCalls: number;
    period: "before" | "after";
  }>;
}

export interface ToolModelStats extends ToolUsageStats {
  model: string;
  provider: string;
}

export interface ToolTimeSeriesPoint {
  timestamp: number;
  tool: string;
  calls: number;
  errors: number;
}

export interface ToolDashboardStats {
  byTool: ToolUsageStats[];
  byToolModel: ToolModelStats[];
  series: ToolTimeSeriesPoint[];
  searchMix: SearchMixStats;
}

/* Context budget: the first-call measurement record written by
 * `npm run measure:context -- --record` (extensions/context-measure),
 * read live from the stats dir, joined with tool_calls usage; plus the
 * record-history trend (DB) and the live-session cache-bust stats (jsonl). */

export interface ContextBudgetTarget {
  target: string;
  at: string;
  toolCount: number;
  systemPromptChars: number;
  toolSchemaChars: number;
  contextChars: number;
  toolNames: string[];
  toolChars: Record<string, number>;
  /** contextChars ÷ the stock row's contextChars (null without stock). */
  multipleOfStock: number | null;
}

export interface ContextBudgetToolRow {
  tool: string;
  /** Characters this tool's definition costs in every request (from the
   * record; null when the record doesn't know the tool). */
  schemaChars: number | null;
  calls: number;
  sessions: number;
  errors: number;
  /** schemaChars × requestsInPeriod — characters paid for this tool's
   * presence across the selected range (null when schemaChars is null). */
  paidChars: number | null;
  /** paidChars ÷ calls — the hide-it-or-keep-it number (null when no calls). */
  charsPerCall: number | null;
}

export interface ContextBudgetStats {
  measuredAt: string | null;
  piVersion: string | null;
  /** Record target used for the usage join (profile match, else "base"). */
  joinTarget: string | null;
  /** Assistant requests in the selected range (what paidChars multiplies). */
  requestsInPeriod: number;
  targets: ContextBudgetTarget[];
  perTool: ContextBudgetToolRow[];
  method: string;
  /** context_records rows ingested from the committed record file — the
   * per-target contextChars trend over time (one point per measure run). */
  history: ContextHistoryPoint[];
  /** Live-session prompt-cache stability, from the per-profile
   * context-measure.jsonl. Null when no record carries v2 hashes yet. */
  cacheBust: ContextCacheBustStats | null;
}

/** One committed record measurement (one `measure:context -- --record` run). */
export interface ContextHistoryPoint {
  measuredAt: string;
  target: string;
  piVersion: string | null;
  systemPromptChars: number;
  toolSchemaChars: number;
  contextChars: number;
  toolCount: number;
}

/** One recorded-session group of live context-measure jsonl records. */
export interface ContextCacheBustSession {
  /** Profile the jsonl came from ("default" in legacy mode). */
  profile: string;
  at: string;
  lastAt: string;
  records: number;
  /** Distinct systemPromptSha256 values seen in the session. */
  promptHashes: number;
  /** Distinct toolsSha256 values seen in the session. */
  toolHashes: number;
  /** Requests where the hash pair changed vs the previous request —
   * each one invalidates the provider prompt cache from there on. */
  busts: number;
  models: string[];
}

export interface ContextCacheBustStats {
  /** Sessions grouped from the live jsonl (bounded to the most recent 200). */
  sessions: ContextCacheBustSession[];
  /** Records carrying v2 hashes (counted above). */
  hashedRecords: number;
  /** Pre-v2 records without hashes — not counted in sessions. */
  legacyRecords: number;
  /** Total busts across sessions. */
  busts: number;
}

/* Providers. Only the portable subset is implemented; the omp auth-broker
 * usage-window series and subscription insights are dropped (TODO(port)). */

export interface ProviderAggregate {
  provider: string;
  totalRequests: number;
  failedRequests: number;
  models: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  totalPremiumRequests: number;
  avgTokensPerSecond: number | null;
}

export interface ProviderHourlyPoint {
  provider: string;
  hour: number;
  totalTokens: number;
  outputTokens: number;
  requests: number;
}

export interface ProviderTimeSeriesPoint {
  timestamp: number;
  provider: string;
  totalTokens: number;
  cost: number;
  requests: number;
}

/** One recorded usage-limit snapshot. Always empty in the port. */
export interface UsageWindowPoint {
  timestamp: number;
  usedFraction: number | null;
  exhausted: boolean;
}

export interface UsageWindowSeries {
  provider: string;
  accountKey: string;
  accountLabel: string;
  windowKey: string;
  windowLabel: string;
  points: UsageWindowPoint[];
}

export interface ProviderWindowInsight {
  provider: string;
  windowKey: string;
  windowLabel: string;
  accounts: number;
  cycles: number;
  fractionConsumed: number;
  estTokensPerWindow: number | null;
  peakConcurrentFraction: number;
  idealAccounts: number;
  exhaustedEvents: number;
}

export interface ProviderDashboardStats {
  providers: ProviderAggregate[];
  hourly: ProviderHourlyPoint[];
  series: ProviderTimeSeriesPoint[];
  usageSeries: UsageWindowSeries[];
  windowInsights: ProviderWindowInsight[];
}

/* Session pins (impulso-pi openrouter-session-pin): per-session OpenRouter
 * backend pinning. Live-joined at request time — the pin state files
 * (<profile>/openrouter-session-pin-state.json, written by the extension)
 * map session id -> model -> backend tag; the DB contributes per-session
 * usage. Sessions older than the state file's 30-day pruning window (or
 * predating the extension) show up under "unpinned". */

export interface SessionPinCandidate {
  tag: string;
  label: string;
}

export interface SessionPinConfig {
  model: string;
  candidates: SessionPinCandidate[];
}

export interface SessionPinBackendRow {
  model: string;
  tag: string;
  label: string;
  sessions: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface SessionPinUnpinnedRow {
  model: string;
  sessions: number;
  requests: number;
  tokens: number;
  cost: number;
  lastTimestamp: number;
}

export interface SessionPinSessionRow {
  sessionId: string;
  model: string;
  tag: string;
  label: string;
  folder: string;
  requests: number;
  tokens: number;
  cost: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface SessionPinDay {
  timestamp: number;
  byTag: Record<string, number>;
}

export interface SessionPinStats {
  configured: SessionPinConfig[];
  summary: {
    pinnedSessions: number;
    unpinnedSessions: number;
    backends: number;
    requests: number;
    cost: number;
    lastTimestamp: number;
  };
  byBackend: SessionPinBackendRow[];
  unpinned: SessionPinUnpinnedRow[];
  sessions: SessionPinSessionRow[];
  timeseries: SessionPinDay[];
}
