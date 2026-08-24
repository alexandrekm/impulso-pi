/**
 * @fileoverview Payload-dump reader for the pi-omp-stats dashboard.
 *
 * The `payload-exporter` pi extension writes every provider request/response
 * as a JSON file under `<configDir>/payloads/`:
 *
 *   payloads/<YYYY-MM-DD>/<sessionId8>[-<slug>]/payload--....json
 *   payloads/<YYYY-MM-DD>/<sessionId8>[-<slug>]/errors.jsonl
 *
 * This module reads those dumps from disk so the dashboard can host a
 * "Payloads" visualizer tab (dates → sessions → request list → formatted
 * detail), replacing the old standalone `scripts/payload-browser.mjs` TUI.
 *
 * Root resolution is profile-aware (see {@link resolvePayloadRoots}): in
 * profiles mode a specific profile reads its own `<profilesDir>/<id>/payloads`,
 * while the "All profiles" view merges every profile that has a payloads dir.
 * When more than one root is in play, each root-relative `rel` is namespaced by
 * its profile id (`<profile>/<date>/<...>`) so drill-downs route back to the
 * right root; a single root keeps `rel` unprefixed for backward compatibility.
 *
 * All file access is confined to a root: every `rel` path is resolved and
 * checked with `path.relative` to reject traversal (`..`) or absolute paths,
 * so a crafted `rel` can never escape its root.
 *
 * MIT, © impulso-pi authors.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSessionsDir, resolveSessionsSources } from "./parser.js";

/** A resolved payloads root. `id` is "" for the single-root case (no rel prefix). */
export interface PayloadRoot {
  id: string;
  dir: string;
}

/** A date bucket under the payloads root (YYYY-MM-DD). */
export interface PayloadDate {
  name: string;
  sessions: number;
}

/** A session folder under a date (name is `<sessionId8>[-<slug>]`). */
export interface PayloadSession {
  name: string;
  /** Path relative to the payloads root, e.g. `2026-08-14/ab12cd34--slug`
   *  or `work/2026-08-14/ab12cd34--slug` in the multi-profile "All" view. */
  rel: string;
  count: number;
  hasErrors: boolean;
  /** mtime in epoch ms. */
  mtime: number;
}

/** A single payload file inside a session folder. */
export interface PayloadFile {
  file: string;
  /** Path relative to the payloads root. */
  rel: string;
  size: number;
  hasResp: boolean;
  date?: string;
  time?: string;
  seq?: number;
  turn?: number;
  model?: string;
}

/** One JSONL entry from a session's errors.jsonl. */
export interface PayloadErrorEntry {
  /** Original line index in the file. */
  i: number;
  at?: string;
  source?: string;
  turnIndex?: number;
  file?: string;
  model?: { id?: string; provider?: string };
  matches?: { pattern: string; toolName?: string; toolCallId?: string; snippet: string }[];
  raw?: string;
}

/** Result of listing a session (or the flat root): files + errors. */
export interface PayloadListing {
  dir: string;
  files: PayloadFile[];
  errors: PayloadErrorEntry[];
}

const NAME_RE =
  /payload--(\d{4}-\d{2}-\d{2})--(\d{2})(\d{2})(\d{2})\.(\d{3})--seq-(\d+)--turn-(\d+)--(.+)\.json$/;

function parseName(filename: string): {
  date?: string;
  time?: string;
  seq?: number;
  turn?: number;
  model?: string;
} {
  const m = filename.match(NAME_RE);
  if (!m) return {};
  return {
    date: m[1],
    time: `${m[2]}:${m[3]}:${m[4]}.${m[5]}`,
    seq: Number(m[6]),
    turn: Number(m[7]),
    model: m[8],
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the payload root(s) for a given profile selection.
 *
 * Precedence:
 *  1. `PI_STATS_PAYLOADS_DIR` (this package's own override) → single
 *     unprefixed root, regardless of profile.
 *  2. Profiles mode (`PI_STATS_PROFILES_DIR`):
 *     - specific profile → single unprefixed root
 *       `<profilesDir>/<profile>/payloads`.
 *     - "all" (or none) → one root per profile that has a payloads dir; if
 *       exactly one exists it is unprefixed, otherwise each is prefixed by
 *       its profile id so `rel` paths stay unique across roots. When no
 *       profile has a payloads dir yet, a single unprefixed root pointing at
 *       the first profile's expected path is returned so the empty-state can
 *       show a helpful path.
 *  3. Legacy: sibling of the sessions dir (`<dirname(sessionsDir)>/payloads`).
 *
 * A leading `~/` is expanded against `os.homedir()`.
 */
export async function resolvePayloadRoots(profile?: string | null): Promise<PayloadRoot[]> {
  const expand = (p: string): string =>
    p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  const env = process.env;

  if (env.PI_STATS_PAYLOADS_DIR && env.PI_STATS_PAYLOADS_DIR.trim()) {
    return [{ id: "", dir: expand(env.PI_STATS_PAYLOADS_DIR.trim()) }];
  }

  if (env.PI_STATS_PROFILES_DIR && env.PI_STATS_PROFILES_DIR.trim()) {
    const sources = await resolveSessionsSources();
    if (sources.length === 0) {
      return [{ id: "", dir: path.join(os.homedir(), ".pi", "agent", "payloads") }];
    }
    const payloadsOf = (s: { dir: string }): string => path.join(path.dirname(s.dir), "payloads");
    if (profile && profile !== "all") {
      const src = sources.find((s) => s.id === profile);
      return [
        {
          id: "",
          dir: src ? payloadsOf(src) : path.join(path.dirname(sources[0].dir), profile, "payloads"),
        },
      ];
    }
    // "all": gather profiles that actually have a payloads dir.
    const roots: PayloadRoot[] = [];
    for (const s of sources) {
      const dir = payloadsOf(s);
      if (await exists(dir)) roots.push({ id: s.id, dir });
    }
    if (roots.length === 0) {
      // Nothing yet — point at the first profile's expected dir for the empty message.
      return [{ id: "", dir: payloadsOf(sources[0]) }];
    }
    if (roots.length === 1) return [{ id: "", dir: roots[0].dir }];
    return roots; // multiple → prefixed by profile id
  }

  return [{ id: "", dir: path.join(path.dirname(resolveSessionsDir()), "payloads") }];
}

/** Human-readable label for the root set (used in the "source:" footer / empty state). */
export function payloadRootLabel(roots: PayloadRoot[]): string {
  if (roots.length > 1 && roots[0].id) return `all profiles (${roots.length})`;
  return roots[0]?.dir ?? "";
}

/** Build a root-relative `rel`, prefixing with the profile id when prefixed-mode. */
function makeRel(root: PayloadRoot, ...parts: string[]): string {
  const sub = parts.filter(Boolean).join("/");
  return root.id ? `${root.id}/${sub}` : sub;
}

/**
 * Pick the root and within-root subpath for a given `rel`.
 *
 * In single-root mode `rel` maps directly to the subpath. In multi-root
 * (prefixed) mode the first segment of `rel` is the profile id; an unknown id
 * yields `null`.
 */
function pickRoot(roots: PayloadRoot[], rel: string): { root: PayloadRoot; sub: string } | null {
  if (roots.length === 0) return null;
  if (roots.length === 1) return { root: roots[0], sub: rel };
  // Prefixed: first segment is the profile id.
  if (!rel || rel.includes("\0")) return null;
  const idx = rel.indexOf("/");
  const id = idx === -1 ? rel : rel.slice(0, idx);
  const sub = idx === -1 ? "" : rel.slice(idx + 1);
  const root = roots.find((r) => r.id === id);
  return root ? { root, sub } : null;
}

/**
 * Resolve `rel` (relative to a single root) to an absolute path, refusing
 * anything that escapes the root. Returns `null` if the path is unsafe or
 * contains a NUL byte.
 */
function safeJoin(root: string, rel: string): string | null {
  if (!rel) return root;
  if (rel.includes("\0")) return null;
  // Reject absolute paths (POSIX or Windows) up front.
  if (path.isAbsolute(rel)) return null;
  const full = path.resolve(root, rel);
  const relFromRoot = path.relative(root, full);
  if (relFromRoot === "" || relFromRoot === ".") return full;
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) return null;
  return full;
}

/** List date buckets (YYYY-MM-DD dirs) across all roots, newest first. */
export async function listPayloadDates(roots: PayloadRoot[]): Promise<{
  root: string;
  exists: boolean;
  dates: PayloadDate[];
  flat: number;
}> {
  const dateMap = new Map<string, number>();
  let flat = 0;
  let anyExists = false;
  for (const r of roots) {
    if (!(await exists(r.dir))) continue;
    anyExists = true;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(r.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)) {
        let n = 0;
        try {
          const subs = await fs.readdir(path.join(r.dir, e.name), {
            withFileTypes: true,
          });
          n = subs.filter((s) => s.isDirectory()).length;
        } catch {
          n = 0;
        }
        dateMap.set(e.name, (dateMap.get(e.name) ?? 0) + n);
      } else if (e.isFile() && e.name.startsWith("payload--") && e.name.endsWith(".json")) {
        flat++;
      }
    }
  }
  const dates: PayloadDate[] = [...dateMap.entries()]
    .map(([name, sessions]) => ({ name, sessions }))
    .sort((a, b) => b.name.localeCompare(a.name));
  return { root: payloadRootLabel(roots), exists: anyExists, dates, flat };
}

/** List session folders under a date dir (across all roots), newest-first by mtime. */
export async function listPayloadSessions(
  roots: PayloadRoot[],
  date: string,
): Promise<{ date: string; sessions: PayloadSession[] }> {
  const sessions: PayloadSession[] = [];
  for (const r of roots) {
    if (!(await exists(r.dir))) continue;
    const datePath = safeJoin(r.dir, date);
    if (!datePath) continue;
    try {
      const st = await fs.stat(datePath);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const entries = await fs.readdir(datePath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sessionPath = path.join(datePath, e.name);
      let count = 0;
      let hasErrors = false;
      try {
        for (const f of await fs.readdir(sessionPath)) {
          if (f.startsWith("payload--") && f.endsWith(".json")) count++;
          if (f === "errors.jsonl") hasErrors = true;
        }
      } catch {
        // unreadable session dir — skip its contents
      }
      let mtime = 0;
      try {
        mtime = (await fs.stat(sessionPath)).mtimeMs;
      } catch {
        // leave 0
      }
      sessions.push({
        name: e.name,
        rel: makeRel(r, date, e.name),
        count,
        hasErrors,
        mtime,
      });
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return { date, sessions };
}

/**
 * List payload files + errors.jsonl entries for a session (or the flat root
 * when `dir` is empty). `dir` is relative to the payloads root (and may carry
 * a profile-id prefix in the multi-profile "All" view).
 */
export async function listPayloadFiles(roots: PayloadRoot[], dir: string): Promise<PayloadListing> {
  const picked = pickRoot(roots, dir);
  if (!picked) return { dir, files: [], errors: [] };
  const { root, sub } = picked;
  const abs = sub ? safeJoin(root.dir, sub) : root.dir;
  if (!abs || !(await exists(abs))) return { dir, files: [], errors: [] };
  const st = await fs.stat(abs);
  if (!st.isDirectory()) return { dir, files: [], errors: [] };

  const entries = await fs.readdir(abs);
  const files: PayloadFile[] = [];
  for (const f of entries) {
    if (!f.startsWith("payload--") || !f.endsWith(".json")) continue;
    const full = path.join(abs, f);
    let size = 0;
    let hasResp = false;
    try {
      size = (await fs.stat(full)).size;
      const data = JSON.parse(await fs.readFile(full, "utf8"));
      hasResp = !!data?.response;
    } catch {
      // unreadable / unparseable — still list it, just without resp flag
    }
    files.push({
      file: f,
      rel: makeRel(root, ...(sub ? [sub, f] : [f])),
      size,
      hasResp,
      ...parseName(f),
    });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  const errors = await readPayloadErrors(roots, dir);
  return { dir, files, errors };
}

/** Read and parse a session's errors.jsonl (empty if absent/unreadable). */
export async function readPayloadErrors(
  roots: PayloadRoot[],
  dir: string,
): Promise<PayloadErrorEntry[]> {
  const picked = pickRoot(roots, dir);
  if (!picked) return [];
  const { root, sub } = picked;
  const absDir = sub ? safeJoin(root.dir, sub) : root.dir;
  if (!absDir) return [];
  const errPath = path.join(absDir, "errors.jsonl");
  if (!(await exists(errPath))) return [];
  let raw: string;
  try {
    raw = await fs.readFile(errPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return { i, ...(JSON.parse(line) as Omit<PayloadErrorEntry, "i">) };
      } catch {
        return { i, raw: line };
      }
    });
}

/** Read and parse a single payload file by its root-relative path. */
export async function readPayloadFile(
  roots: PayloadRoot[],
  rel: string,
): Promise<{ data: unknown } | null> {
  const picked = pickRoot(roots, rel);
  if (!picked) return null;
  const { root, sub } = picked;
  const abs = safeJoin(root.dir, sub);
  if (!abs || !(await exists(abs))) return null;
  const st = await fs.stat(abs);
  if (!st.isFile()) return null;
  try {
    const data = JSON.parse(await fs.readFile(abs, "utf8"));
    return { data };
  } catch (e) {
    return { data: { __error: e instanceof Error ? e.message : String(e) } };
  }
}

/** Whether any payload root exists (used to hide the tab when absent). */
export async function payloadsExist(roots: PayloadRoot[]): Promise<boolean> {
  for (const r of roots) {
    if (await exists(r.dir)) return true;
  }
  return false;
}

/**
 * @deprecated Use {@link resolvePayloadRoots}. Kept for standalone callers;
 * ignores profile selection and returns the legacy single-dir resolution.
 */
export function resolvePayloadsDir(): string {
  const expand = (p: string): string =>
    p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  const env = process.env;
  if (env.PI_STATS_PAYLOADS_DIR && env.PI_STATS_PAYLOADS_DIR.trim()) {
    return expand(env.PI_STATS_PAYLOADS_DIR.trim());
  }
  return path.join(path.dirname(resolveSessionsDir()), "payloads");
}

// Re-export sync variant of exists for callers that need it.
export const _existsSync = fsSync.existsSync;
