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
