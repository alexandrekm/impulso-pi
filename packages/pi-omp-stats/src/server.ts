/**
 * @fileoverview HTTP server (Node port of omp-stats `server.ts`).
 *
 * Uses `node:http` (no Bun server API) and binds to `127.0.0.1` by default for
 * safety; `--host` is required to expose the dashboard externally. The
 * React + Tailwind + Chart.js client and its Bun archive embedding are gone
 * (Diff 4): the dashboard is a single self-contained `dashboard.html` served
 * at `/` (vanilla JS + a CDN Chart.js script, with a local-inline option for
 * a zero-CDN build). The `/api/*` shapes are byte-compatible with omp so a
 * future client swap is trivial.
 *
 * MIT, © Can Boluk (original omp-stats); ported for the impulso-pi package.
 */

import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import {
  getBehaviorDashboardStats,
  getCompactionDashboardStats,
  getCompactionTokensBefore,
  getCostDashboardStats,
  getDashboardStats,
  getModelDashboardStats,
  getMemoryDashboardStats,
  getMemoryDetail,
  getMemoryList,
  getMemorySessions,
  getGuardDashboardStats,
  getGuardList,
  getGuardSessions,
  getOverviewStats,
  getProviderDashboardStats,
  getRecentErrors,
  getRecentRequests,
  getRequestDetails,
  getCostSeriesForRange,
  getTimeSeriesForRange,
  getToolDashboardStats,
  getAvailableProfiles,
  getTotalMessageCount,
  selectProfile,
  syncAllSessions,
} from "./aggregator.js";
import {
  listPayloadDates,
  listPayloadFiles,
  listPayloadSessions,
  payloadsExist,
  payloadRootLabel,
  readPayloadFile,
  readPayloadErrors,
  resolvePayloadRoots,
} from "./payloads.js";

const DASHBOARD_HTML_PATH = fileURLToPath(new URL("./dashboard.html", import.meta.url));
const CHART_LOCAL_PATH = fileURLToPath(new URL("./chart.min.js", import.meta.url));
let dashboardHtml: string | null = null;
function getDashboardHtml(): string {
  if (dashboardHtml === null) {
    try {
      dashboardHtml = fs.readFileSync(DASHBOARD_HTML_PATH, "utf8");
    } catch {
      dashboardHtml = FALLBACK_HTML;
    }
  }
  return dashboardHtml;
}

const STATS_DASHBOARD_HEADER = "x-omp-stats-dashboard";
const STATS_DASHBOARD_SECURITY_VERSION = "2";
// Database selection is process-global so requests must not interleave a
// profile switch with an aggregate query. SQLite access itself is synchronous;
// this queue only covers the async filesystem/database initialization around it.
let apiQueue = Promise.resolve();
function queueApi<T>(work: () => Promise<T>): Promise<T> {
  const result = apiQueue.then(work);
  apiQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    [STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    [STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** Handle `/api/*` requests. */
async function handleApi(url: URL, res: http.ServerResponse): Promise<void> {
  const pathname = url.pathname;
  const range = url.searchParams.get("range");

  if (pathname === "/api/profiles") return sendJson(res, 200, await getAvailableProfiles());

  const profile = url.searchParams.get("profile") ?? "all";
  if (!(await getAvailableProfiles()).includes(profile)) {
    return sendJson(res, 400, { error: `Unknown profile: ${profile}` });
  }
  const isPayloads = pathname.startsWith("/api/payloads");
  if (!isPayloads) {
    // Stats routes read from a per-profile DB.
    selectProfile(profile);
  }

  if (pathname === "/api/stats") return sendJson(res, 200, await getDashboardStats(range));
  if (pathname === "/api/stats/overview") return sendJson(res, 200, await getOverviewStats(range));
  if (pathname === "/api/stats/model-dashboard")
    return sendJson(res, 200, await getModelDashboardStats(range));
  if (pathname === "/api/stats/costs") {
    // Optional ?bucket=<ms> override: returns the same shape but bucketed
    // finer (used by the stacked-by-model cost chart).
    const bucket = url.searchParams.get("bucket");
    if (bucket)
      return sendJson(res, 200, {
        costSeries: await getCostSeriesForRange(range, parseInt(bucket, 10)),
      });
    return sendJson(res, 200, await getCostDashboardStats(range));
  }
  if (pathname === "/api/stats/behavior")
    return sendJson(res, 200, await getBehaviorDashboardStats(range));
  if (pathname === "/api/stats/tools")
    return sendJson(res, 200, await getToolDashboardStats(range));
  if (pathname === "/api/stats/providers")
    return sendJson(res, 200, await getProviderDashboardStats(range));
  if (pathname === "/api/stats/compaction")
    return sendJson(res, 200, await getCompactionDashboardStats(range));
  if (pathname === "/api/stats/compaction/timeseries")
    return sendJson(res, 200, {
      series: (await getCompactionDashboardStats(range)).timeseries,
    });
  if (pathname === "/api/stats/compaction/tokens-before") {
    const model = url.searchParams.get("model");
    return sendJson(res, 200, await getCompactionTokensBefore(range, model));
  }
  if (pathname === "/api/stats/memory")
    return sendJson(res, 200, await getMemoryDashboardStats(range));
  if (pathname === "/api/stats/memory/timeseries")
    return sendJson(res, 200, {
      series: (await getMemoryDashboardStats(range)).timeseries,
    });
  if (pathname === "/api/stats/memory/relevance")
    return sendJson(res, 200, {
      buckets: (await getMemoryDashboardStats(range)).relevance,
    });
  if (pathname === "/api/stats/memory/pool")
    return sendJson(res, 200, {
      series: (await getMemoryDashboardStats(range)).poolGrowth,
    });
  if (pathname === "/api/stats/memory/sessions")
    return sendJson(res, 200, { sessions: await getMemorySessions() });
  if (pathname === "/api/stats/memory/list") {
    const kind = url.searchParams.get("kind");
    const relevance = url.searchParams.get("relevance");
    const session = url.searchParams.get("session");
    const q = url.searchParams.get("q");
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    return sendJson(
      res,
      200,
      await getMemoryList({
        range,
        kind,
        relevance,
        session,
        q,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      }),
    );
  }

  if (pathname === "/api/stats/guards")
    return sendJson(res, 200, await getGuardDashboardStats(range));
  if (pathname === "/api/stats/guards/timeseries")
    return sendJson(res, 200, {
      series: (await getGuardDashboardStats(range)).timeseries,
    });
  if (pathname === "/api/stats/guards/sessions")
    return sendJson(res, 200, { sessions: await getGuardSessions() });
  if (pathname === "/api/stats/guards/list") {
    const guard = url.searchParams.get("guard");
    const kind = url.searchParams.get("kind");
    const session = url.searchParams.get("session");
    const q = url.searchParams.get("q");
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    return sendJson(
      res,
      200,
      await getGuardList({
        range,
        guard,
        kind,
        session,
        q,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      }),
    );
  }

  if (pathname === "/api/stats/recent") {
    const limit = url.searchParams.get("limit");
    return sendJson(res, 200, await getRecentRequests(limit ? parseInt(limit, 10) : undefined));
  }
  if (pathname === "/api/stats/errors") {
    const limit = url.searchParams.get("limit");
    return sendJson(
      res,
      200,
      await getRecentErrors(range, limit ? parseInt(limit, 10) : undefined),
    );
  }
  if (pathname === "/api/stats/models")
    return sendJson(res, 200, (await getDashboardStats(range)).byModel);
  if (pathname === "/api/stats/folders")
    return sendJson(res, 200, (await getDashboardStats(range)).byFolder);
  if (pathname === "/api/stats/timeseries") {
    // Optional ?bucket=<ms> override for finer granularity (e.g. 2h). Without
    // it, the range-config bucket is used (byte-compatible with omp).
    const bucket = url.searchParams.get("bucket");
    return sendJson(
      res,
      200,
      await getTimeSeriesForRange(range, bucket ? parseInt(bucket, 10) : undefined),
    );
  }

  if (pathname === "/api/payloads") {
    // Existence probe used by the dashboard to show/hide the Payloads tab.
    const roots = await resolvePayloadRoots(profile);
    return sendJson(res, 200, {
      exists: await payloadsExist(roots),
      root: payloadRootLabel(roots),
    });
  }
  if (pathname === "/api/payloads/dates") {
    const roots = await resolvePayloadRoots(profile);
    return sendJson(res, 200, await listPayloadDates(roots));
  }
  if (pathname === "/api/payloads/sessions") {
    const roots = await resolvePayloadRoots(profile);
    const date = url.searchParams.get("date") ?? "";
    return sendJson(res, 200, await listPayloadSessions(roots, date));
  }
  if (pathname === "/api/payloads/files") {
    const roots = await resolvePayloadRoots(profile);
    const dir = url.searchParams.get("dir") ?? "";
    return sendJson(res, 200, await listPayloadFiles(roots, dir));
  }
  if (pathname === "/api/payloads/errors") {
    const roots = await resolvePayloadRoots(profile);
    const dir = url.searchParams.get("dir") ?? "";
    return sendJson(res, 200, { dir, errors: await readPayloadErrors(roots, dir) });
  }
  if (pathname === "/api/payloads/file") {
    const roots = await resolvePayloadRoots(profile);
    const rel = url.searchParams.get("path") ?? "";
    const result = await readPayloadFile(roots, rel);
    if (!result) return sendJson(res, 404, { error: "Not Found" });
    return sendJson(res, 200, result);
  }

  if (pathname.startsWith("/api/request/")) {
    const id = pathname.split("/").pop();
    if (!id) return sendJson(res, 400, { error: "Bad Request" });
    const details = await getRequestDetails(parseInt(id, 10));
    if (!details) return sendJson(res, 404, { error: "Not Found" });
    return sendJson(res, 200, details);
  }

  if (pathname.startsWith("/api/stats/memory/")) {
    // /api/stats/memory/<id> → single memory detail (must come after the
    // fixed /api/stats/memory/* routes above).
    const idStr = pathname.split("/").pop();
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(id)) return sendJson(res, 400, { error: "Bad Request" });
    const detail = await getMemoryDetail(id);
    if (!detail) return sendJson(res, 404, { error: "Not Found" });
    return sendJson(res, 200, detail);
  }

  if (pathname === "/api/sync") {
    const result = await syncAllSessions();
    const count = await getTotalMessageCount();
    return sendJson(res, 200, { ...result, totalMessages: count });
  }

  // /api/stats/gain is intentionally not implemented (omp snapcompact-specific).
  sendJson(res, 404, { error: "Not Found" });
}

/** Start the HTTP server. */
export function startServer(
  port = 3847,
  host = "127.0.0.1",
): Promise<{ hostname: string; port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url) return sendText(res, 400, "Bad Request");
      const url = new URL(req.url, `http://${host}:${port}`);

      if (req.method === "OPTIONS") {
        res.writeHead(204, { [STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION });
        res.end();
        return;
      }

      try {
        if (url.pathname.startsWith("/api/")) {
          await queueApi(() => handleApi(url, res));
        } else if (url.pathname === "/" || url.pathname === "/index.html") {
          sendText(res, 200, getDashboardHtml());
        } else if (url.pathname === "/chart.min.js") {
          // Optional local Chart.js copy for a zero-CDN build. If absent, the
          // dashboard falls back to the jsdelivr CDN.
          try {
            const buf = fs.readFileSync(CHART_LOCAL_PATH);
            res.writeHead(200, {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            });
            res.end(buf);
          } catch {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("not found");
          }
        } else if (url.pathname === "/favicon.ico") {
          res.writeHead(204);
          res.end();
        } else {
          // Single-file dashboard: no other static assets exist.
          sendText(res, 404, "Not Found");
        }
      } catch (error) {
        console.error("Server error:", error);
        sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
      }
    });

    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        hostname: host,
        port: actualPort,
        stop: () => server.close(),
      });
    });
  });
}

// Minimal fallback if dashboard.html is missing next to the module (e.g. a
// broken install). The real asset is read from disk at first request.
const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>pi-omp-stats</title>
<style>body{font-family:system-ui,sans-serif;padding:2rem;background:#1a1a1a;color:#e5e5e5}</style>
<h1>pi-omp-stats</h1>
<p>Dashboard asset not found at <code>${path.basename(DASHBOARD_HTML_PATH)}</code>.</p>
<p>API is live: <a href="/api/stats" style="color:#7aa2f7">/api/stats</a></p>`;
