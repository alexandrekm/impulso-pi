/**
 * zvec-guard for pi: block `zvec_index` calls against roots that must not be
 * indexed — $HOME and umbrella roots.
 *
 * Why this exists (both failure modes are real, observed 2026-09):
 *
 * - **$HOME**: a home-rooted index (~/.zvec-grep with rootPaths = $HOME,
 *   recursive) silently poisons every later `zg` call. zg resolves the nearest
 *   workspace index by walking up from cwd, so *any* directory under $HOME
 *   resolves to it — and `zg status`/`query` then stat the entire home tree
 *   (58G+ ~/Library alone) to compute freshness, appearing to hang for many
 *   minutes. This exact failure mode disabled zvec for every profile for days:
 *   the autoIndex session_start guard hung, zvec_search timed out, and the
 *   model stopped calling the tools at all.
 *
 * - **Umbrella roots**: a root whose shallow tree holds several nested git
 *   repos (an umbrella repo with submodules — e.g. an mtv-inference worktree
 *   — or a directory of repos like ~/code). zg 0.2.x hard-skips nested repos
 *   when indexing (even `--no-ignore` and explicit globs cannot include
 *   them), so an umbrella index only ever contains the handful of root-level
 *   files — and that near-empty stub *shadows* real leaf-repo indexes:
 *   sessions inside a submodule resolve up to the umbrella index instead of
 *   building their own. Observed: a 4.1 GB ~/code index (corrupt after
 *   concurrent auto-index builds) and a 4-file mtv-inference index shadowing
 *   every submodule session under it.
 *
 * zg itself has no opt-out: an `indexPolicy: "disabled"` manifest is treated
 * as "not indexed" by `zg index` and gets overwritten. So the only reliable
 * protection is to stop the indexing call before it runs.
 *
 * Policy (mirrors the fork's src/core/root-policy.ts — the pi-zvec-grep
 * package applies the same rules to its autoIndex hook and its own tool
 * execute; this guard is defense-in-depth at pi's tool_call layer):
 *   - Block `zvec_index` (index/rebuild modes) whose resolved root realpath
 *     === $HOME, always.
 *   - Block index/rebuild of umbrella roots: ≥ maxNestedRepos (default 3)
 *     nested git repos at depth ≤ 2 (`.git` dir OR file — worktree/submodule
 *     style). One or two submodules inside a normal repo still index.
 *   - `allowRoots` (from `<configDir>/pi-zvec-grep/config.json`,
 *     `rootPolicy.allowRoots`) bypasses the umbrella rule — realpath and `~`
 *     matched. It never unlocks $HOME.
 *   - Allow `drop` mode — dropping a stray bad index is the remediation,
 *     never the problem.
 *   - Leave `zvec_search` / `zvec_status` untouched (read-only), and leave
 *     `zg` via bash to command-guard / documentation. The /zg slash command
 *     is also unguarded: a human typing it is explicit intent.
 *
 * Toggled in /settings → Search → Semantic search (id `zvec-guard`).
 */

import { type Dirent, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";

/** Config root: the active agent dir (profile dir in profiles mode). */
const CONFIG_DIR =
  process.env.PI_CODING_AGENT_DIR || dirname(dirname(fileURLToPath(import.meta.url)));

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

export interface RootPolicy {
  allowRoots: string[];
  maxNestedRepos: number;
}

const DEFAULT_POLICY: RootPolicy = { allowRoots: [], maxNestedRepos: 3 };

/** Read rootPolicy from the pi-zvec-grep user config (same file the package reads). */
export function loadRootPolicy(): RootPolicy {
  try {
    const raw = JSON.parse(
      readFileSync(join(CONFIG_DIR, "pi-zvec-grep", "config.json"), "utf8"),
    ) as {
      rootPolicy?: { allowRoots?: unknown; maxNestedRepos?: unknown };
    };
    const policy = raw.rootPolicy;
    if (typeof policy !== "object" || policy === null) return DEFAULT_POLICY;
    const allowRoots = Array.isArray(policy.allowRoots)
      ? policy.allowRoots.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : DEFAULT_POLICY.allowRoots;
    const maxNestedRepos =
      typeof policy.maxNestedRepos === "number" &&
      Number.isFinite(policy.maxNestedRepos) &&
      policy.maxNestedRepos >= 1
        ? Math.round(policy.maxNestedRepos)
        : DEFAULT_POLICY.maxNestedRepos;
    return { allowRoots, maxNestedRepos };
  } catch {
    return DEFAULT_POLICY;
  }
}

/** Directory names never descended into while scanning for nested repos. */
const SCAN_SKIP = new Set([
  ".git",
  ".zvec-grep",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
]);

/** Does one directory contain a `.git` entry (dir OR file — worktrees use a file)? */
function isGitDir(dir: string): boolean {
  try {
    statSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Iterate a directory's child DIRECTORIES (skipping noise names), calling
 * `visit(childPath)` for each. Returns true as soon as `visit` does (the
 * scan should stop: threshold or budget reached); unreadable dirs are
 * simply empty.
 */
function eachChildDir(dir: string, visit: (childPath: string) => boolean): boolean {
  let children: Dirent[];
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const child of children) {
    if (!child.isDirectory() || SCAN_SKIP.has(child.name)) continue;
    if (visit(join(dir, child.name))) return true;
  }
  return false;
}

/** Mutable scan state shared across the two levels. */
interface ScanState {
  found: number;
  entries: number;
}

/**
 * Count one scanned entry; returns true when the scan should stop (the
 * repo threshold was just reached, or the entry budget is exhausted).
 */
function tallyScan(
  state: ScanState,
  repoFound: boolean,
  stopAfter: number,
  entryBudget: number,
): boolean {
  state.entries += 1;
  if (repoFound) state.found += 1;
  return state.found >= stopAfter || state.entries > entryBudget;
}

/**
 * Count distinct git repos nested under `root` at depth ≤ 2 (the root itself
 * never counts), stopping early once `stopAfter` are found. Bounded by an
 * entry budget so a policy check can never turn into a tree walk. A
 * nested repo found at depth 1 is not descended into — its own children
 * are its content, not separate repos of ours.
 */
export function countNestedRepos(
  root: string,
  stopAfter = Number.POSITIVE_INFINITY,
  entryBudget = 2000,
): number {
  const state: ScanState = { found: 0, entries: 0 };
  const tally = (repoFound: boolean): boolean =>
    tallyScan(state, repoFound, stopAfter, entryBudget);
  eachChildDir(root, (childPath) => {
    if (isGitDir(childPath)) return tally(true);
    // not a repo itself: its children are the depth-2 candidates
    if (tally(false)) return true;
    return eachChildDir(childPath, (grandPath) => tally(isGitDir(grandPath)));
  });
  return state.found;
}

/** Verdict for one candidate root: `reason` is set iff allowed is false. */
export interface RootAssessment {
  allowed: boolean;
  reason?: string;
}

/** Assess one candidate index root against the policy (pure: no zg, no writes). */
export function assessRoot(root: string, policy: RootPolicy = DEFAULT_POLICY): RootAssessment {
  // Expand a leading ~ the same way normalizeRoot does, so direct
  // callers (and tests) can pass "~" and mean the home directory.
  const expanded = root === "~" || root.startsWith("~/") ? join(homedir(), root.slice(1)) : root;
  const realRoot = bestRealPath(expanded);
  if (realRoot === bestRealPath(homedir())) {
    return {
      allowed: false,
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
  for (const allowed of policy.allowRoots) {
    const expanded =
      allowed === "~" || allowed.startsWith("~/") ? join(homedir(), allowed.slice(1)) : allowed;
    if (bestRealPath(expanded) === realRoot) return { allowed: true };
  }
  const nested = countNestedRepos(realRoot, policy.maxNestedRepos);
  if (nested >= policy.maxNestedRepos) {
    return {
      allowed: false,
      reason:
        `[zvec-guard] blocked indexing an umbrella root (${nested}+ nested git repos at ` +
        "depth ≤ 2). zg cannot index nested repos — only root-level files would be " +
        "indexed, and that stub index shadows real leaf-repo indexes for sessions " +
        "below it. Search still works without an index via fts (zvec_search) or " +
        "bash rg. To index this root anyway, add it to rootPolicy.allowRoots in " +
        "pi-zvec-grep/config.json (knowing nested repos stay invisible to it).",
    };
  }
  return { allowed: true };
}

export default function (pi: any): void {
  if (!isFeatureEnabled("zvec-guard")) return;

  pi.on("tool_call", async (event: any, _ctx: any) => {
    if (event.toolName !== "zvec_index") return undefined;
    const input = event.input as { root?: unknown; mode?: unknown } | undefined;
    const mode = input?.mode ?? "index";
    if (mode === "drop") return undefined;

    const root = normalizeRoot(input?.root, _ctx?.cwd);
    if (!root) return undefined; // the tool itself will reject a missing root

    const assessment = assessRoot(root, loadRootPolicy());
    if (!assessment.allowed) return { block: true, reason: assessment.reason };
    return undefined;
  });
}
