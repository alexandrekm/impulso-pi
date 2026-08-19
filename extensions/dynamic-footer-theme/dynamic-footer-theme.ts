// dynamic-footer-theme — re-theme @juanbenjumea/pi-dynamic-footer's segment
// renderers with emoji icons + the old pi-droid-styling / footer-status-widgets
// color accents (🤖 ⏱ 📁 🌿 📊 ⚡ ⬆ ⬇ 🗃 💰).
//
// How it works: pi loads local extensions before npm-package ones, and jiti's
// module cache is keyed by resolved path. So importing the installed
// package's footer-engine by absolute path (via getAgentDir()) yields the
// SAME module instance the package uses — mutating `builtinRenderers.<key>`
// swaps renderers in place before any render fires. Layout/separator
// (`defaultAssembler`, a const binding) can't be changed this way; only
// segment content. Upstream auto-updates still flow for layout + new segments
// (a new segment key just won't be themed until we add it here).
//
// No-ops if the package isn't installed (e.g. before the first `pi install`).

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = "@juanbenjumea/pi-dynamic-footer";
const ENGINE = "lib/footer-engine/index.js";

const PROVIDER_SHORT: Record<string, string> = {
  "cline-pass": "cp",
  "opencode-go": "og",
  opencode: "og",
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

const THINKING_ABBR: Record<string, string> = {
  minimal: "min",
  medium: "med",
  xhigh: "xhi",
};

export default async function (pi: any): Promise<void> {
  const agentDir = getAgentDir();
  const modPath = join(agentDir, "npm/node_modules", PKG, ENGINE);

  let mod: any;
  try {
    mod = await import(pathToFileURL(modPath).href);
  } catch {
    pi.on("session_start", (_e: any, ctx: any) => {
      try {
        ctx?.ui?.notify?.(`${PKG} not installed; dynamic-footer-theme inactive`, "warning");
      } catch {
        // stale ctx — skip
      }
    });
    return;
  }

  const R = mod.builtinRenderers as Record<string, (input: any) => string>;
  if (!R || typeof R !== "object") return;

  const fmtDuration = mod.fmtDuration as (ms: number) => string;
  const fmtTokens = mod.fmtTokens as (n: number) => string;
  const shortenPath = mod.shortenPath as (p: string) => string;
  const thinkingColor = mod.thinkingColor as (level: string) => string;
  const contextUsageColor = mod.contextUsageColor as (
    pct: number,
    expert: number,
    warning: number,
  ) => string;

  const BAR_FILLED = "▓";
  const BAR_EMPTY = "░";

  function bar(pct: number, width: number, color: string, theme: any): string {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
    const filled = Math.round((clamped / 100) * width);
    return (
      theme.fg(color, BAR_FILLED.repeat(filled)) + theme.fg("dim", BAR_EMPTY.repeat(width - filled))
    );
  }

  // ── Themed renderers ──

  R.modelThink = (input: any) => {
    const { model, thinkingLevel, fastModeEnabled, serviceTier, theme } = input;
    const shortLevel = THINKING_ABBR[thinkingLevel] ?? thinkingLevel;
    const text = `🤖 ${stripProvider(model)}:${shortLevel}`;
    const tier = fastModeEnabled ? theme.fg("accent", ` ⚡${serviceTier ?? "fast"}`) : "";
    return theme.fg(thinkingColor(thinkingLevel), text) + tier;
  };

  R.runtime = (input: any) => input.theme.fg("dim", `⏱ ${fmtDuration(input.runtimeMs)}`);

  R.pwd = (input: any) => {
    const path = input.showFullPath ? shortenPath(input.cwd) : basename(input.cwd);
    return input.theme.fg("dim", `📁 ${path}`);
  };

  R.git = (input: any) => {
    const { gitBranch, gitDiffAdded, gitDiffRemoved, theme } = input;
    if (!gitBranch) return "";
    const dirty = gitDiffAdded > 0 || gitDiffRemoved > 0;
    let text = `🌿 ${theme.fg(dirty ? "warning" : "dim", gitBranch)}`;
    if (gitDiffAdded > 0) text += ` ${theme.fg("success", `+${gitDiffAdded}`)}`;
    if (gitDiffRemoved > 0) text += ` ${theme.fg("error", `-${gitDiffRemoved}`)}`;
    return text;
  };

  R.contextUsage = (input: any) => {
    const { contextUsage, theme, settings } = input;
    if (!contextUsage || !contextUsage.contextWindow) return "";
    const tokens = Number.isFinite(contextUsage.tokens) ? Math.max(0, contextUsage.tokens) : 0;
    const max = contextUsage.contextWindow;
    if (!Number.isFinite(max) || max <= 0) return "";
    const pct = Math.min(100, Math.max(0, Math.round((tokens / max) * 100)));
    const color = contextUsageColor(
      pct,
      settings.contextZones.expert,
      settings.contextZones.warning,
    );
    let text = "📊 ";
    if (settings.segments.contextProgress) text += bar(pct, 6, color, theme);
    if (settings.segments.contextPercentage) text += `${pct}%`;
    if (settings.segments.contextNumbers) text += ` ${fmtTokens(tokens)}/${fmtTokens(max)}`;
    return theme.fg(color, text);
  };

  R.tokens = (input: any) =>
    input.theme.fg(
      "dim",
      `⬆${fmtTokens(input.totalInputTokens)} ⬇${fmtTokens(input.totalOutputTokens)}`,
    );

  R.tps = (input: any) => {
    const { isStreaming, currentTurnStartTime, currentTurnOutputTokens, lastTurnTps, theme } =
      input;
    if (isStreaming && currentTurnStartTime) {
      const elapsed = (Date.now() - currentTurnStartTime) / 1000;
      const liveTok =
        elapsed > 0 && currentTurnOutputTokens > 0 ? currentTurnOutputTokens / elapsed : 0;
      if (liveTok > 0) return theme.fg("accent", `⚡ ${liveTok.toFixed(0)} tok/s`);
      const upd = elapsed > 0 ? input.currentTurnUpdateCount / elapsed : 0;
      return theme.fg("accent", `⚡ ${upd.toFixed(1)} upd/s`);
    } else if (lastTurnTps > 0) {
      return theme.fg("dim", `⚡ ${lastTurnTps.toFixed(1)} tok/s`);
    }
    return "";
  };

  R.cost = (input: any) => {
    const { totalCost, theme } = input;
    const color = totalCost > 0 ? "success" : "dim";
    return theme.fg(color, `💰 $${totalCost.toFixed(2)}`);
  };

  R.cache = (input: any) => {
    const { totalCacheRead, totalOutputTokens, theme } = input;
    if (totalCacheRead <= 0) return "";
    const total = totalCacheRead + totalOutputTokens;
    if (total <= 0) return "";
    const pct = Math.round((totalCacheRead / total) * 100);
    const color = pct >= 70 ? "success" : pct >= 40 ? "dim" : "warning";
    return theme.fg(color, `🗃 ${pct}%`);
  };

  R.turnCount = (input: any) => input.theme.fg("dim", `#${input.turnNumber}`);

  // usageBars left as the upstream renderer (already theme-colored).
}
