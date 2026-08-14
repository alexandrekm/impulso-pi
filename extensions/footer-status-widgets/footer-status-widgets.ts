// footer-status-widgets — publish custom footer stats via pi's native
// `ctx.ui.setStatus()` so pi-droid-styling surfaces them in its user-zone
// footer (it reads pi's built-in extension statuses).
//
// This is the pi-droid-styling counterpart to extensions/footer/footer-widgets.ts
// (which emits to the pi-footer event bus). With droid-styling owning the
// footer, pi's native setStatus() is the channel it reads. Widgets:
//
//   toks    - average output tok/s (output tokens / span of first→last
//             assistant message). "--" until 2+ assistant messages exist.
//   cost    - session cost, 2 decimals (e.g. "$6.12").
//   cache   - prompt cache hit rate: cacheRead / (input + cacheRead) across
//             assistant messages (e.g. "86%"). "--" until data exists.
//   pr      - current branch's GitHub PR status via `gh pr view` (e.g.
//             "#123 open"). Hidden when there's no PR. Requires `gh`.
//
// (ctxpct was removed: droid-styling already shows context % + tokens
// together on the left, so a separate far-right % read as a conflict.)

import { execFile } from "node:child_process";

const FAST_REFRESH_MS = 1000;
const PR_REFRESH_MS = 20_000; // branch changed / PR exists
const PR_NO_PR_MS = 5 * 60_000; // last check found no PR — re-check rarely

function setStatus(ctx: any, key: string, text: string | undefined): void {
  try {
    ctx?.ui?.setStatus?.(key, text);
  } catch {
    // stale ctx after session replacement — skip this tick
  }
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

function computeCacheHitRate(ctx: any): string {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  let input = 0;
  let cacheRead = 0;
  for (const e of branch) {
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    const u = e.message?.usage;
    if (!u) continue;
    input += u.input || 0;
    cacheRead += u.cacheRead || 0;
  }
  const total = input + cacheRead;
  if (total <= 0) return "--";
  return `${Math.round((cacheRead / total) * 100)}%`;
}

function currentBranch(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      { cwd, timeout: 5000 },
      (error, stdout) => {
        if (error) resolve("");
        else resolve(stdout.trim());
      },
    );
  });
}

function runGhPrView(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", "--json", "number,state,isDraft"],
      { cwd, timeout: 10_000 },
      (error, stdout) => {
        if (error) {
          resolve(""); // no PR for this branch — status is hidden
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
      setStatus(ctx, "toks", `⚡${computeTokSpeed(ctx)} tok/s`);
      setStatus(ctx, "cost", `$${computeCost(ctx).toFixed(2)}`);
      setStatus(ctx, "cache", `cache ${computeCacheHitRate(ctx)}`);
      // clear any ctxpct a previous version of this extension set
      setStatus(ctx, "ctxpct", undefined);
    };
    let lastBranch = "";
    let lastPr = "|"; // sentinel: never matched yet
    let prTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePr = (ms: number) => {
      if (prTimer) clearTimeout(prTimer);
      prTimer = setTimeout(publishPr, ms);
      unrefTimer(prTimer);
    };

    const publishPr = async () => {
      const branch = await currentBranch(cwd);
      // Re-query only when the branch changed since the last check.
      if (branch === lastBranch && lastPr !== "|") {
        schedulePr(lastPr === "" ? PR_NO_PR_MS : PR_REFRESH_MS);
        return;
      }
      lastBranch = branch;
      const pr = await runGhPrView(cwd);
      lastPr = pr;
      setStatus(ctx, "pr", pr === "" ? undefined : pr);
      schedulePr(pr === "" ? PR_NO_PR_MS : PR_REFRESH_MS);
    };

    publishFast();
    publishPr();
    const fastTimer = setInterval(publishFast, FAST_REFRESH_MS);
    unrefTimer(fastTimer);

    pi.on("session_shutdown", () => {
      clearInterval(fastTimer);
      if (prTimer) clearTimeout(prTimer);
    });
  });
}
