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
 *   files — and zg resolves the NEAREST ANCESTOR index for status/query/
 *   index, so an index at a container root makes every repo below it
 *   PERMANENTLY un-indexable (they resolve up to the stub, and even an
 *   explicit `zg index` from below without an own index lands on the
 *   ancestor). Observed: a 4.1 GB ~/code index (corrupt after
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

import { execFileSync } from "node:child_process";
import { type Dirent, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";

/**
 * Config root: the active agent dir (profile dir in profiles mode). The
 * fallback ascends THREE levels because the installed file lives at
 * `<profile>/extensions/zvec-guard/index.ts` (the in-repo file at
 * `extensions/zvec-guard/zvec-guard.ts` is the same depth from the repo
 * root) — two hops would land on the extensions/ dir and the
 * pi-zvec-grep/config.json read would miss.
 */
const CONFIG_DIR =
  process.env.PI_CODING_AGENT_DIR || dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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
  /** Allow indexing roots on network filesystems (off by default). */
  allowNetworkFs: boolean;
}

const DEFAULT_POLICY: RootPolicy = { allowRoots: [], maxNestedRepos: 3, allowNetworkFs: false };

// ---- network-filesystem detection (mirrors the fork's src/core/netfs.ts) --
// Mount-table based, longest-prefix, fail-open (unreadable table → the
// network rule is skipped, indexing behaves as before). Cached per process.

const NETWORK_FS_TYPES = new Set([
  "nfs",
  "nfs4",
  "nfs5",
  "cifs",
  "smbfs",
  "smbfs2",
  "sshfs",
  "fuse.sshfs",
  "afpfs",
  "davfs",
  "davfs2",
  "webdav",
  "9p",
  "ncpfs",
  "afs",
  "ceph",
  "cephfs",
  "fuse.ceph",
  "lustre",
  "glusterfs",
  "gpfs",
  "vboxsf",
  "vmhgfs",
  "prl_fs",
  "nts",
]);

interface MountEntry {
  point: string;
  type: string;
}

/** Parse mount(8) (Linux and macOS shapes) and /proc/self/mounts text. */
export function parseMounts(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // util-linux: `<dev> on <point> type <fstype> (<opts>)`
    let m = line.match(/^(\S+) on (.+) type (\S+) \(/);
    if (m) {
      out.push({ point: m[2], type: m[3].toLowerCase() });
      continue;
    }
    // macOS: `<dev> on <point> (<fstype>, <opts>…)` — type may be the only paren token
    m = line.match(/^(\S+) on (.+) \(([a-z][\w.-]*)[,)]/i);
    if (m) {
      out.push({ point: m[2], type: m[3].toLowerCase() });
      continue;
    }
    // /proc/self/mounts: `<dev> <point> <fstype> <opts> <freq> <pass>`
    m = line.match(/^(\S+) (\S+) (\S+) \S+ \d+ \d+$/);
    if (m) out.push({ point: m[2], type: m[3].toLowerCase() });
  }
  return out;
}

function collectMountTable(): MountEntry[] {
  if (process.platform === "linux") {
    try {
      return parseMounts(readFileSync("/proc/self/mounts", "utf8"));
    } catch {
      // fall through to the command below
    }
  }
  try {
    return parseMounts(execFileSync("mount", { encoding: "utf8", timeout: 10_000 }));
  } catch {
    return [];
  }
}

let mountCache: MountEntry[] | undefined;

/** The mount table (cached per process; primable in tests). */
export function mountTable(): MountEntry[] {
  mountCache ??= collectMountTable();
  return mountCache;
}

/** Prime the mount-table cache (test seam). */
export function setMountTable(entries: MountEntry[]): void {
  mountCache = entries;
}

/** The filesystem type governing `target` (longest mount-point prefix). */
export function mountTypeFor(target: string, mounts: MountEntry[]): string | undefined {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    real = resolve(target);
  }
  let best: MountEntry | undefined;
  for (const entry of mounts) {
    const covered =
      entry.point === "/" || real === entry.point || real.startsWith(entry.point + "/");
    if (covered && (!best || entry.point.length > best.point.length)) best = entry;
  }
  return best?.type;
}

export function isNetworkFsRoot(target: string, mounts: MountEntry[] = mountTable()): boolean {
  const type = mountTypeFor(target, mounts);
  return type !== undefined && NETWORK_FS_TYPES.has(type);
}

/** Read rootPolicy from the pi-zvec-grep user config (same file the package reads). */
export function loadRootPolicy(): RootPolicy {
  try {
    const raw = JSON.parse(
      readFileSync(join(CONFIG_DIR, "pi-zvec-grep", "config.json"), "utf8"),
    ) as {
      rootPolicy?: { allowRoots?: unknown; maxNestedRepos?: unknown; allowNetworkFs?: unknown };
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
    const allowNetworkFs =
      typeof policy.allowNetworkFs === "boolean"
        ? policy.allowNetworkFs
        : DEFAULT_POLICY.allowNetworkFs;
    return { allowRoots, maxNestedRepos, allowNetworkFs };
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
export function assessRoot(
  root: string,
  policy: RootPolicy = DEFAULT_POLICY,
  mounts: MountEntry[] = mountTable(),
): RootAssessment {
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
  if (!policy.allowNetworkFs && isNetworkFsRoot(realRoot, mounts)) {
    return {
      allowed: false,
      reason:
        "[zvec-guard] blocked indexing a network filesystem (NFS/SMB/sshfs/…) root. " +
        "Building a local vector store over the network is brutally slow, and every " +
        "later freshness check re-stats the tree over the wire — sessions in that " +
        "workspace hang. fts searches (zvec_search) and bash rg still work without " +
        "an index. To index anyway, set rootPolicy.allowNetworkFs in " +
        "pi-zvec-grep/config.json (or add the root to allowRoots).",
    };
  }
  const nested = countNestedRepos(realRoot, policy.maxNestedRepos);
  if (nested >= policy.maxNestedRepos) {
    return {
      allowed: false,
      reason:
        `[zvec-guard] blocked indexing an umbrella/container root (${nested}+ nested git ` +
        "repos at depth ≤ 2). zg cannot index nested-repo content (only root-level files " +
        "would be indexed), and worse: zg resolves the NEAREST ANCESTOR index for " +
        "status/query/index — an index here would make every repo below it permanently " +
        "un-indexable. Index the specific repo instead (a session inside it does this " +
        "automatically via autoIndex); search from an umbrella root works via fts " +
        "(zvec_search) or bash rg, or by passing root=<submodule> to zvec_search. To index " +
        "anyway, add this root to rootPolicy.allowRoots in pi-zvec-grep/config.json.",
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
