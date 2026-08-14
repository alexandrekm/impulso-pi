#!/usr/bin/env node
/**
 * @fileoverview `pi-omp-stats` CLI entry.
 *
 * Default action: sync then start the server and print
 * `Dashboard available at: http://127.0.0.1:<port>`. Flags: `--port`,
 * `--json`, `--sync`, `--sessions-dir`, `--host`, `--help`.
 *
 * Node port of omp-stats `index.ts` (MIT, © Can Boluk). Uses `node:util
 * parseArgs` and a realpath-based main-module check to
 * detect direct execution (replacing the omp original's `import.meta.main`).
 */

import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeDb } from "./db.js";
import {
  getDashboardStats,
  getTotalMessageCount,
  syncAllSessions,
  type SyncProgress,
} from "./aggregator.js";
import { resolveSessionsDir } from "./parser.js";
import { startServer } from "./server.js";

export { getDashboardStats, getTotalMessageCount, syncAllSessions } from "./aggregator.js";
export { closeDb } from "./db.js";
export { startServer } from "./server.js";
export { resolveSessionsDir } from "./parser.js";

/* -------------------------------------------------------------------------- */
/* Formatting (replaces omp pi-utils format* helpers)                    */
/* -------------------------------------------------------------------------- */

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${(n * 100).toFixed(1)}%`;
}

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Print a human-readable stats summary to stdout. */
async function printStats(): Promise<void> {
  const stats = await getDashboardStats();
  const { overall, byModel, byFolder } = stats;

  console.log("\n=== AI Usage Statistics ===\n");

  console.log("Overall:");
  console.log(
    `  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`,
  );
  console.log(`  Error Rate: ${formatPercent(overall.errorRate)}`);
  console.log(
    `  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`,
  );
  console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
  console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
  console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
  console.log(`  Cache Savings: ${formatPercent(overall.cacheSavings)}`);
  console.log(`  Total Cost: ${formatCost(overall.totalCost)}`);
  console.log(`  Avg Duration: ${formatDuration(overall.avgDuration)}`);
  console.log(`  Avg TTFT: ${formatDuration(overall.avgTtft)}`);
  if (overall.avgTokensPerSecond !== null) {
    console.log(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
  }

  if (byModel.length > 0) {
    console.log("\nBy Model:");
    for (const m of byModel.slice(0, 10)) {
      console.log(
        `  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost)}, ${formatPercent(
          m.cacheRate,
        )} cache rate, ${formatPercent(m.cacheSavings)} cache savings`,
      );
    }
  }

  if (byFolder.length > 0) {
    console.log("\nBy Folder:");
    for (const f of byFolder.slice(0, 10)) {
      console.log(
        `  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost)}`,
      );
    }
  }

  console.log("");
}

function printHelp(): void {
  console.log(`
pi-omp-stats - AI Usage Statistics Dashboard

A standalone port of omp-stats that reads pi session JSONL files.
No pi process needs to be running; no pi packages are imported at runtime.

Usage:
  pi-omp-stats [options]

Options:
  -p, --port <port>           Port for the dashboard server (default: 3847)
      --host <host>           Bind address (default: 127.0.0.1). Use 0.0.0.0 to
                              expose externally (see README warning).
  -j, --json                  Output stats as JSON and exit
  -s, --sync                  Sync session files and print a summary, no server
      --sessions-dir <path>   Override the sessions directory (env:
                              PI_STATS_SESSIONS_DIR / PI_CODING_AGENT_SESSION_DIR
                              / PI_CODING_AGENT_DIR / default ~/.pi/agent/sessions)
  -h, --help                  Show this help message

Environment:
  PI_STATS_SESSIONS_DIR       Override sessions directory (highest precedence)
  PI_CODING_AGENT_SESSION_DIR pi's own session-dir override
  PI_CODING_AGENT_DIR         pi agent dir; sessions at <dir>/sessions
  PI_STATS_DIR                Stats DB directory (default ~/.pi/agent)

Examples:
  pi-omp-stats                # Sync then start the dashboard server
  pi-omp-stats --json         # Print stats as JSON and exit
  pi-omp-stats --port 8080    # Start on a custom port
  pi-omp-stats --sync         # Sync and print a summary
`);
}

/** Sync with a stderr progress bar, then report. */
async function runSync(): Promise<{ processed: number; files: number }> {
  const tty = process.stderr.isTTY === true;
  process.stderr.write("Syncing session files...\n");
  let lastWidth = 0;
  let lastRender = 0;
  const { processed, files } = await syncAllSessions({
    onProgress: (event: SyncProgress) => {
      if (!tty) return;
      const now = Date.now();
      if (event.current < event.total && now - lastRender < 33) return;
      lastRender = now;
      const marker = "/sessions/";
      const idx = event.sessionFile.lastIndexOf(marker);
      const short = idx >= 0 ? event.sessionFile.slice(idx + marker.length) : event.sessionFile;
      const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
      const line = `[${event.current}/${event.total}] ${pct}%  ${short}`;
      const columns = process.stderr.columns ?? 120;
      const clipped = line.length > columns - 1 ? `${line.slice(0, columns - 2)}\u2026` : line;
      process.stderr.write(`\r${clipped.padEnd(lastWidth)}`);
      lastWidth = clipped.length;
    },
  });
  if (tty && lastWidth > 0) process.stderr.write(`\r${" ".repeat(lastWidth)}\r`);
  const total = await getTotalMessageCount();
  process.stderr.write(`Synced ${processed} new entries from ${files} files (${total} total)\n\n`);
  return { processed, files };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p", default: "3847" },
      host: { type: "string", default: "127.0.0.1" },
      json: { type: "boolean", short: "j", default: false },
      sync: { type: "boolean", short: "s", default: false },
      "sessions-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  // `--sessions-dir` is the highest-precedence override for the sessions dir.
  // resolveSessionsDir reads it via a module-level cache seeded from env, so
  // set it on process.env before anything touches the resolver.
  if (values["sessions-dir"]) {
    process.env.PI_STATS_SESSIONS_DIR = values["sessions-dir"];
  }

  // Show which sessions dir we're reading (useful for env-override debugging).
  process.stderr.write(`Sessions dir: ${resolveSessionsDir()}\n`);

  try {
    await runSync();

    if (values.json) {
      const stats = await getDashboardStats();
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    if (values.sync) {
      await printStats();
      return;
    }

    const port = parseInt(values.port || "3847", 10);
    const host = values.host || "127.0.0.1";
    const { hostname, port: actualPort } = await startServer(port, host);
    console.log(`Dashboard available at: http://${hostname}:${actualPort}`);
    console.log("Press Ctrl+C to stop\n");

    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      closeDb();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      closeDb();
      process.exit(0);
    });
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    closeDb();
    process.exit(1);
  }
}

// Run if executed directly (replaces Bun's `import.meta.main`). Resolve the
// invocation path via realpath so a global bin symlink matches `import.meta.url`,
// which already points at the symlink's target.
try {
  const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
  const modulePath = fileURLToPath(import.meta.url);
  if (invoked && modulePath === invoked) main();
} catch {
  /* argv[1] not resolvable — not the main module */
}
