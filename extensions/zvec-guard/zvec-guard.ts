/**
 * zvec-guard for pi: block `zvec_index` calls that would index $HOME.
 *
 * Why this exists: a home-rooted index (~/.zvec-grep with rootPaths = $HOME,
 * recursive) silently poisons every later `zg` call. zg resolves the nearest
 * workspace index by walking up from cwd, so *any* directory under $HOME
 * resolves to it — and `zg status`/`query` then stat the entire home tree
 * (58G+ ~/Library alone) to compute freshness, appearing to hang for many
 * minutes. This exact failure mode disabled zvec for every profile for days:
 * the autoIndex session_start guard hung, zvec_search timed out, and the
 * model stopped calling the tools at all.
 *
 * zg itself has no opt-out: an `indexPolicy: "disabled"` manifest is treated
 * as "not indexed" by `zg index` and gets overwritten (see
 * isWorkspaceIndexed() — disabled manifests carry embedding: null). So the
 * only reliable protection is to stop the indexing call before it runs.
 *
 * Policy ($HOME only, deliberately narrow):
 *   - Block `zvec_index` whose resolved root realpath === $HOME, for the
 *     index and rebuild modes.
 *   - Allow `drop` mode — dropping a stray home index is the remediation,
 *     never the problem.
 *   - Leave `zvec_search` / `zvec_status` untouched (read-only), and leave
 *     `zg` via bash to command-guard / documentation.
 *
 * Toggled in /settings → Search → Semantic search (id `zvec-guard`).
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";

/** Realpath with a fallback: non-existent paths (fresh workspaces) still resolve. */
export function bestRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Mirror the tool's own root normalization: expand ~, resolve against cwd. */
export function normalizeRoot(root: unknown, cwd: unknown): string | undefined {
  if (typeof root !== "string" || !root.trim()) return undefined;
  const cleaned = root.trim().replace(/^@/, "");
  const expanded =
    cleaned === "~" || cleaned.startsWith("~/") ? join(homedir(), cleaned.slice(1)) : cleaned;
  const base = typeof cwd === "string" ? cwd : process.cwd();
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export default function (pi: any): void {
  if (!isFeatureEnabled("zvec-guard")) return;

  const HOME = bestRealPath(homedir());

  pi.on("tool_call", async (event: any, _ctx: any) => {
    if (event.toolName !== "zvec_index") return undefined;
    const input = event.input as { root?: unknown; mode?: unknown } | undefined;
    const mode = input?.mode ?? "index";
    if (mode === "drop") return undefined;

    const root = normalizeRoot(input?.root, _ctx?.cwd);
    if (!root) return undefined; // the tool itself will reject a missing root

    if (bestRealPath(root) === HOME) {
      return {
        block: true,
        reason:
          "[zvec-guard] blocked indexing $HOME. A home-rooted index makes every zg " +
          "call stat the entire home tree to compute freshness — status/query " +
          "appear to hang for minutes from any directory under $HOME, and " +
          "zvec stops being usable (this exact failure disabled it before). " +
          "Index a real workspace root instead (usually the session cwd / the " +
          "repo). If a home index already exists, drop it: " +
          "`zg index ~ --drop --yes`.",
      };
    }
    return undefined;
  });
}
