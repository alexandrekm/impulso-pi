// Shared dashboard fetch for OpenCode Go workspaces.
//
// Both pi-multi-opencode-go (failover extension) and pi-dynamic-footer used
// to duplicate this fetch + auth-URL check + parse chain. This module is the
// single source of truth; consumers wrap it with their own shapes.
import { isAuthenticatedWorkspaceUrl, parseOpenCodeGoDashboard } from "./dashboard.ts";
import type { OpenCodeGoWindow } from "./types.ts";

export interface OpenCodeGoUsageResult {
  rolling: OpenCodeGoWindow | null;
  weekly: OpenCodeGoWindow | null;
  monthly: OpenCodeGoWindow | null;
  /** Short error label; "auth-expired" when the workspace URL check failed. */
  error?: string;
}

export interface FetchDashboardUsageOptions {
  /** Abort timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** User-Agent header (default: a desktop Firefox UA used by the dashboards). */
  userAgent?: string;
  /** Fetch implementation override (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

/**
 * Fetch and parse usage for one OpenCode Go workspace.
 * Never throws — failures become `{ error }` results.
 */
export async function fetchDashboardUsage(
  workspaceId: string,
  authCookie: string,
  options: FetchDashboardUsageOptions = {},
): Promise<OpenCodeGoUsageResult> {
  const {
    timeoutMs = 10_000,
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = fetch,
  } = options;
  const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Cookie: `auth=${authCookie}`,
          "User-Agent": userAgent,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!isAuthenticatedWorkspaceUrl(response.url, workspaceId)) {
      return { rolling: null, weekly: null, monthly: null, error: "auth-expired" };
    }
    return parseOpenCodeGoDashboard(await response.text());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    return { rolling: null, weekly: null, monthly: null, error: message };
  }
}
