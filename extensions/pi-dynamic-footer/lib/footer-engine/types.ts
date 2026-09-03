import type { ContextUsage, Theme as PiTheme } from "@earendil-works/pi-coding-agent";

import type { QuotaSnapshot } from "../quota-provider.ts";

export type SegmentKey =
  | "modelThink"
  | "runtime"
  | "pwd"
  | "git"
  | "prStatus"
  | "ciStatus"
  | "contextUsage"
  | "mode"

export interface FooterSettings {
  segments: Record<SegmentKey, boolean>;
  contextZones: { expert: number; warning: number };
}

export interface FooterInput {
  model: string;
  thinkingLevel: string;
  runtimeMs: number;
  isStreaming: boolean;
  currentTurnStartTime: number | null;
  currentTurnUpdateCount: number;
  lastTurnTps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalReasoningTokens: number;
  currentTurnOutputTokens: number;
  turnNumber: number;
  fastModeSupported: boolean;
  fastModeEnabled: boolean;
  serviceTier: string | null;
  contextUsage: ContextUsage | null;
  cwd: string;
  showFullPath: boolean;
  gitBranch: string | null;
  gitDiffAdded: number;
  gitDiffRemoved: number;
  /** GitHub PR status for the current branch, e.g. "#123 open"; null if none/unavailable. */
  prStatus: string | null;
  /** CI check summary for the PR head ref, e.g. "✅", "❌2", "⏳"; null if none/unavailable. */
  ciStatus: string | null;
  /** Current /mode (from <configDir>/mode.json); null when the modes extension is absent. */
  mode: string | null;
  settings: FooterSettings;
  theme: PiTheme;
  /** Subscription usage bars data, fetched on session_start and periodically */
  quotaUsage: QuotaSnapshot | null;
}

export interface SegmentRenderer {
  (input: FooterInput): string;
}

export interface LayoutAssembler {
  (segments: Record<string, string>, width: number, theme: PiTheme): string[];
}

export interface FooterEngineOptions {
  segments?: Partial<Record<SegmentKey, SegmentRenderer>>;
  layout?: LayoutAssembler;
}
