import type { OpenCodeGoDashboardUsage, OpenCodeGoWindow } from "./types.ts";

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

function windowRegex(name: string): [RegExp, RegExp] {
  return [
    new RegExp(
      String.raw`${name}:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`,
    ),
    new RegExp(
      String.raw`${name}:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`,
    ),
  ];
}

const [RE_ROLLING_USAGE, RE_ROLLING_RESET] = windowRegex("rollingUsage");
const [RE_WEEKLY_USAGE, RE_WEEKLY_RESET] = windowRegex("weeklyUsage");
const [RE_MONTHLY_USAGE, RE_MONTHLY_RESET] = windowRegex("monthlyUsage");

function parseWindow(
  html: string,
  usageFirst: RegExp,
  resetFirst: RegExp,
): OpenCodeGoWindow | null {
  let match = usageFirst.exec(html);
  if (match) {
    const usagePercent = Number(match[1]);
    const resetInSec = Number(match[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  match = resetFirst.exec(html);
  if (match) {
    const resetInSec = Number(match[1]);
    const usagePercent = Number(match[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  return null;
}

/** Parse OpenCode Go workspace dashboard HTML for usage windows. */
export function parseOpenCodeGoDashboard(html: string): OpenCodeGoDashboardUsage {
  return {
    rolling: parseWindow(html, RE_ROLLING_USAGE, RE_ROLLING_RESET),
    weekly: parseWindow(html, RE_WEEKLY_USAGE, RE_WEEKLY_RESET),
    monthly: parseWindow(html, RE_MONTHLY_USAGE, RE_MONTHLY_RESET),
  };
}

export function isAuthenticatedWorkspaceUrl(
  url: string,
  workspaceId: string,
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://opencode.ai" &&
      parsed.pathname === `/workspace/${encodeURIComponent(workspaceId)}/go`
    );
  } catch {
    return false;
  }
}
