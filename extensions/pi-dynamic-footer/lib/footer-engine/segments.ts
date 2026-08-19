import { basename } from "node:path";
import type { SegmentRenderer, FooterInput } from "./types.js";
import {
  fmtDuration,
  fmtTokens,
  shortenPath,
  thinkingColor,
  contextUsageColor,
  rainbowText,
} from "./format.js";

/* ───── Usage bar helpers ───── */

const BAR_FILLED = "▓";
const BAR_EMPTY = "░";
const THINKING_ABBR: Record<string, string> = {
  minimal: "min",
  medium: "med",
  xhigh: "xhi",
};

const PROVIDER_SHORT: Record<string, string> = {
  "cline-pass": "cp",
  "opencode-go": "og",
  "opencode": "og",
  codex: "cx",
  claude: "cl",
  umans: "um",
  openai: "oa",
  google: "gl",
  nan: "na",
};

function stripProvider(modelId: string): string {
  const m = modelId.match(/^([a-z][a-z0-9._-]+)[:\/]/);
  if (m) {
    const short = PROVIDER_SHORT[m[1]];
    if (short) return short + ":" + modelId.slice(m[0].length);
  }
  return modelId;
}

function maxQuotaPercent(input: FooterInput): number {
  if (!input.quotaUsage?.windows?.length) return 0;
  const values = input.quotaUsage.windows
    .map((window) => window.usedPercent)
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : 0;
}

function quotaColor(usedPercent: number): string | null {
  if (usedPercent >= 92) return "error";
  if (usedPercent >= 85) return "warning";
  return null;
}

function renderUsageBar(usedPercent: number, barWidth: number, theme: FooterInput["theme"]): string {
  const safePercent = Number.isFinite(usedPercent) ? usedPercent : 0;
  const safeWidth = Math.max(0, Math.floor(barWidth));
  const clamped = Math.max(0, Math.min(100, safePercent));
  const filled = Math.round((clamped / 100) * safeWidth);
  const empty = safeWidth - filled;

  let color: string;
  if (clamped >= 92) color = "error";
  else if (clamped >= 85) color = "warning";
  else color = "success";

  return theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(empty));
}

function renderUsageWindow(
  label: string,
  usedPercent: number,
  resetsIn: string | undefined,
  theme: FooterInput["theme"],
): string {
  const dim = (s: string) => theme.fg("dim", s);
  const bar = renderUsageBar(usedPercent, 4, theme);
  const pct = usedPercent > 0 ? dim(`${Math.round(usedPercent)}%`) : "";
  const reset = usedPercent > 30 && resetsIn ? dim(` ↻ ${resetsIn}`) : "";
  return `${dim(label)}${bar}${pct}${reset}`;
}

export const builtinRenderers: Record<string, SegmentRenderer> = {
  modelThink(input) {
    const { model, thinkingLevel, fastModeEnabled, serviceTier, theme, quotaUsage } = input;
    const shortLevel = THINKING_ABBR[thinkingLevel] ?? thinkingLevel;
    const text = `${stripProvider(model)}:${shortLevel}`;
    const tier = fastModeEnabled ? theme.fg("accent", ` ⚡${serviceTier ?? "fast"}`) : "";
    if (thinkingLevel === "xhigh" || thinkingLevel === "max") {
      return rainbowText(text) + tier;
    }
    // Override color with quota alert when usage is high
    const maxPct = maxQuotaPercent(input);
    const qColor = quotaColor(maxPct);
    const color = qColor ?? "accent";
    return theme.fg(color, text) + tier;
  },

  runtime(input) {
    return input.theme.fg("dim", `⏱ ${fmtDuration(input.runtimeMs)}`);
  },

  pwd(input) {
    const path = input.showFullPath ? shortenPath(input.cwd) : basename(input.cwd);
    return input.theme.fg("dim", `📁 ${path}`);
  },

  git(input) {
    const { gitBranch, gitDiffAdded, gitDiffRemoved, theme } = input;
    if (!gitBranch) return "";
    const dirty = gitDiffAdded > 0 || gitDiffRemoved > 0;
    let text = `🌿 ${theme.fg("dim", gitBranch)}`;
    if (gitDiffAdded > 0) {
      text += ` ${theme.fg("success", `+${gitDiffAdded}`)}`;
    }
    if (gitDiffRemoved > 0) {
      text += ` ${theme.fg("error", `-${gitDiffRemoved}`)}`;
    }
    return text;
  },

  contextUsage(input) {
    const { contextUsage, theme, settings } = input;
    if (!contextUsage || !contextUsage.contextWindow) return input.theme.fg("dim", "📊 --");

    const tokens = Number.isFinite(contextUsage.tokens) ? Math.max(0, contextUsage.tokens) : 0;
    const max = contextUsage.contextWindow;
    if (!Number.isFinite(max) || max <= 0) return input.theme.fg("dim", "📊 --");
    const pct = Math.min(100, Math.max(0, Math.round((tokens / max) * 100)));

    let text = "";

    if (settings.segments.contextProgress) {
      text += renderUsageBar(pct, 6, theme);
    }

    if (settings.segments.contextPercentage) {
      text += `${pct}%`;
    }

    if (settings.segments.contextNumbers) {
      text += ` ${fmtTokens(tokens)}/${fmtTokens(max)}`;
    }

    return theme.fg(
      contextUsageColor(pct, settings.contextZones.expert, settings.contextZones.warning),
      text,
    );
  },

  tokens(input) {
    const { totalInputTokens, totalOutputTokens, theme } = input;
    return input.theme.fg("dim", `⬆ ${fmtTokens(totalInputTokens)} ⬇ ${fmtTokens(totalOutputTokens)}`);
  },

  tps(input) {
    const { isStreaming, currentTurnStartTime, currentTurnOutputTokens, lastTurnTps, theme } = input;
    if (isStreaming && currentTurnStartTime) {
      const elapsed = (Date.now() - currentTurnStartTime) / 1000;
      const liveTok = elapsed > 0 && currentTurnOutputTokens > 0
        ? currentTurnOutputTokens / elapsed
        : 0;
      if (liveTok > 0) {
        return theme.fg("accent", `⚡ ${liveTok.toFixed(0)}`);
      }
      // Fall back to update-rate when no token data available
      const upd = elapsed > 0 ? input.currentTurnUpdateCount / elapsed : 0;
      return theme.fg("accent", `⚡ ${upd.toFixed(1)} upd/s`);
    } else if (lastTurnTps > 0) {
      return theme.fg("dim", `⚡ ${lastTurnTps.toFixed(1)}`);
    }
    return theme.fg("dim", "⚡ --");
  },

  cost(input) {
    const { totalCost, theme } = input;
    const color = totalCost > 0 ? "success" : "dim";
    return theme.fg(color, `💰 $${totalCost.toFixed(2)}`);
  },

  cache(input) {
    const { totalCacheRead, totalInputTokens, theme } = input;
    // Prompt-cache hit rate: of all prompt tokens the model received, the
    // fraction served from cache. Denominator = cacheRead + input (the
    // non-cached prompt tokens); output tokens are a different quantity and
    // must not be in the denominator.
    if (totalCacheRead <= 0) return theme.fg("dim", "🗃 --");
    const total = totalCacheRead + totalInputTokens;
    if (total <= 0) return theme.fg("dim", "🗃 --");
    const pct = Math.round((totalCacheRead / total) * 100);
    const color = pct >= 70 ? "success" : pct >= 40 ? "dim" : "warning";
    return theme.fg(color as any, `🗃 ${pct}%`);
  },

  cacheWrite(input) {
    const { totalCacheWrite, theme } = input;
    if (totalCacheWrite <= 0) return theme.fg("dim", "✎ --");
    return theme.fg("dim", `✎ ${fmtTokens(totalCacheWrite)}`);
  },

  reasoning(input) {
    const { totalReasoningTokens, theme } = input;
    if (totalReasoningTokens <= 0) return theme.fg("dim", "🧠 --");
    return theme.fg("accent", `🧠 ${fmtTokens(totalReasoningTokens)}`);
  },

  prStatus(input) {
    const { prStatus, theme } = input;
    if (!prStatus) return theme.fg("dim", "PR --");
    // Color by state suffix: "#123 open" / "#123 draft" / "#123 merged" / "#123 closed"
    const lower = prStatus.toLowerCase();
    const color =
      lower.endsWith("open") ? "success" :
      lower.endsWith("draft") ? "warning" :
      lower.endsWith("merged") ? "accent" :
      lower.endsWith("closed") ? "error" :
      "dim";
    return theme.fg(color as any, prStatus);
  },

  ciStatus(input) {
    const { ciStatus, theme } = input;
    if (!ciStatus) return theme.fg("dim", "CI --");
    // ciStatus is precomputed in observability.ts from `gh pr checks` buckets:
    //   "✅" all pass (green) · "❌N" N failed (red) · "⏳" pending (yellow).
    const color =
      ciStatus === "✅" ? "success" :
      ciStatus.startsWith("❌") ? "error" :
      ciStatus === "⏳" ? "warning" :
      "dim";
    return theme.fg(color as any, ciStatus);
  },

  turnCount(input) {
    const { turnNumber, theme } = input;
    return theme.fg("dim", `#${turnNumber}`);
  },

  usageBars(input) {
    const { quotaUsage, theme } = input;
    if (!quotaUsage || quotaUsage.windows.length === 0) return "";

    const dim = (s: string) => theme.fg("dim", s);
    const sep = " " + theme.fg("dim", "│") + " ";
    return quotaUsage.windows
      .filter((window) => Number.isFinite(window.usedPercent))
      .map((window) => renderUsageWindow(window.label, window.usedPercent, window.resetsIn, theme))
      .join(sep);
  },
};
