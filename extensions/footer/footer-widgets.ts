// Bundled pi-footer "Pi Event Value" publishers.
//
// pi-footer (npm:pi-footer) renders the footer; these fill gaps its built-in
// widgets don't cover (custom formatting, tok/s, PR status). Each publishes
// via `pi.events.emit("pi-footer:update-widget", { widgetId, value })`.
//
// Setup (`/footer`): add a "Pi Event Value" widget for each Widget ID below.
//
//   toks    - average output tok/s (output tokens / span of first->last
//             assistant message). "--" until 2+ assistant messages exist.
//   cost    - session cost, 2 decimals (e.g. "$6.12"); built-in Cost widget
//             only supports 3 or 2/4 decimals.
//   ctxpct  - context usage as a whole-number percent (e.g. "25%"); built-in
//             Context % widget always shows one decimal place.
//   pr      - current branch's GitHub PR status via `gh pr view` (e.g.
//             "#1234 open"), empty string when there's no PR (pair with
//             hideWhenEmpty to auto-hide the segment). Requires `gh` CLI
//             installed and authenticated. Refreshed every 20s (network
//             call) instead of every second like the others.

import { execFile } from "node:child_process";

const FAST_REFRESH_MS = 1000;
const PR_REFRESH_MS = 20_000;

function emit(pi: any, widgetId: string, value: string): void {
  pi.events.emit("pi-footer:update-widget", { widgetId, value });
}

function computeTokSpeed(ctx: any): string {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  let output = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const e of branch) {
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    output += e.message?.usage?.output || 0;
    if (e.timestamp) {
      const ms = Date.parse(e.timestamp);
      if (!Number.isNaN(ms)) {
        if (firstTs === null) firstTs = ms;
        lastTs = ms;
      }
    }
  }
  if (firstTs === null || lastTs === null || lastTs <= firstTs) return "--";
  const seconds = (lastTs - firstTs) / 1000;
  return Math.round(output / seconds).toString();
}

function computeCost(ctx: any): number {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  let cost = 0;
  for (const e of branch) {
    let usage: any = null;
    if (e?.type === "message") {
      usage = e.message?.usage;
    } else if (e?.type === "branch_summary" || e?.type === "compaction") {
      usage = e.usage;
    }
    cost += usage?.cost?.total || 0;
  }
  return cost;
}

function computeContextPercent(ctx: any): string {
  const pct = ctx.getContextUsage?.()?.percent;
  return pct != null ? `${Math.round(pct)}%` : "?%";
}

function runGhPrView(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", "--json", "number,state,isDraft"],
      { cwd, timeout: 10_000 },
      (error, stdout) => {
        if (error) {
          resolve(""); // no PR for this branch — widget hides itself when empty
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const status = data.isDraft
            ? "draft"
            : data.state === "OPEN"
              ? "open"
              : data.state === "MERGED"
                ? "merged"
                : data.state === "CLOSED"
                  ? "closed"
                  : String(data.state).toLowerCase();
          resolve(`#${data.number} ${status}`);
        } catch {
          resolve("");
        }
      },
    );
  });
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}

export default function (pi: any): void {
  pi.on("session_start", (_event: any, ctx: any) => {
    const cwd = ctx.cwd || process.cwd();

    const publishFast = () => {
      emit(pi, "toks", `\u26a1${computeTokSpeed(ctx)} tok/s`);
      emit(pi, "cost", `$${computeCost(ctx).toFixed(2)}`);
      emit(pi, "ctxpct", computeContextPercent(ctx));
    };
    const publishPr = async () => {
      emit(pi, "pr", await runGhPrView(cwd));
    };

    publishFast();
    publishPr();
    const fastTimer = setInterval(publishFast, FAST_REFRESH_MS);
    const prTimer = setInterval(publishPr, PR_REFRESH_MS);
    unrefTimer(fastTimer);
    unrefTimer(prTimer);

    pi.on("session_shutdown", () => {
      clearInterval(fastTimer);
      clearInterval(prTimer);
    });
  });
}
