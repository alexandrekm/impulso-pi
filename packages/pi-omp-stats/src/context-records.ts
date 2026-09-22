/**
 * @fileoverview Live context-measure jsonl reader: prompt-cache bust detection.
 *
 * `extensions/context-measure` (the recording provider) appends one JSON
 * record per request to `<configDir>/context-measure.jsonl` — including the
 * v2 stability hashes (`systemPromptSha256` / `toolsSha256`). While the prompt
 * cache (see `extensions/cache-ttl/`) only pays off while the request prefix
 * stays byte-identical, this module reads those jsonl files live (no DB, the
 * same read-on-request approach `/api/stats/context` uses for the committed
 * record) and reports, per recorded session, how often the hash pair changed —
 * each change means every later request re-reads the full prefix.
 *
 * Root resolution mirrors payloads.ts: profile-aware under
 * `PI_STATS_PROFILES_DIR`, single-dir legacy otherwise, `PI_STATS_CONTEXT_JSONL`
 * as an explicit override.
 *
 * MIT, © impulso-pi authors.
 */

import * as fsSync from "node:fs";
import * as path from "node:path";
import { resolveSessionsSources } from "./parser.js";
import type { ContextCacheBustSession, ContextCacheBustStats } from "./shared-types.js";

interface LiveRecord {
  at?: string;
  requestId?: number;
  model?: string;
  systemPromptSha256?: string;
  toolsSha256?: string;
}

/** Two records further apart than this start a new session group. */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** Sessions reported back, newest first (the jsonl grows forever). */
const MAX_SESSIONS = 200;

/** Candidate jsonl paths for a profile selection (see module doc). */
async function resolveJsonlPaths(
  profile?: string | null,
): Promise<Array<{ profile: string; file: string }>> {
  const override = process.env.PI_STATS_CONTEXT_JSONL?.trim();
  if (override) return [{ profile: "default", file: override }];
  const sources = await resolveSessionsSources();
  const wanted = profile && profile !== "all" ? sources.filter((s) => s.id === profile) : sources;
  return wanted.map((s) => ({
    profile: s.id,
    file: path.join(path.dirname(s.dir), "context-measure.jsonl"),
  }));
}

function readRecords(file: string): LiveRecord[] {
  try {
    return fsSync
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as LiveRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is LiveRecord => r !== null);
  } catch {
    return [];
  }
}

/** Is this record the start of a new session group? */
function startsSession(prev: LiveRecord | undefined, current: LiveRecord): boolean {
  if (!prev || !prev.at || !current.at) return true;
  const gap = Date.parse(current.at) - Date.parse(prev.at);
  if (!Number.isFinite(gap) || gap > SESSION_GAP_MS) return true;
  // requestId is 1-based per pi process: a reset (or any non-increasing
  // value) means a new process recorded this line.
  return (current.requestId ?? 0) <= (prev.requestId ?? 0);
}

/**
 * Group one profile's records into sessions and count hash changes.
 * Records without v2 hashes are counted as legacy and skipped.
 */
function sessionsFor(
  profile: string,
  records: LiveRecord[],
  totals: { hashed: number; legacy: number; busts: number },
): ContextCacheBustSession[] {
  const sorted = [...records].sort((a, b) =>
    a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : 0,
  );
  const sessions: ContextCacheBustSession[] = [];
  let current: ContextCacheBustSession | null = null;
  let prev: LiveRecord | undefined;
  let promptHash = "";
  let toolHash = "";
  for (const record of sorted) {
    if (!record.at || !record.systemPromptSha256 || !record.toolsSha256) {
      totals.legacy += 1;
      continue;
    }
    totals.hashed += 1;
    if (startsSession(prev, record)) {
      current = {
        profile,
        at: record.at,
        lastAt: record.at,
        records: 0,
        promptHashes: 0,
        toolHashes: 0,
        busts: 0,
        models: [],
      };
      sessions.push(current);
      promptHash = "";
      toolHash = "";
    }
    const session = current as ContextCacheBustSession;
    session.lastAt = record.at;
    session.records += 1;
    if (!session.models.includes(record.model ?? "?")) {
      session.models.push(record.model ?? "?");
    }
    const promptChanged = record.systemPromptSha256 !== promptHash;
    const toolChanged = record.toolsSha256 !== toolHash;
    if (promptChanged) session.promptHashes += 1;
    if (toolChanged) session.toolHashes += 1;
    promptHash = record.systemPromptSha256;
    toolHash = record.toolsSha256;
    // The first request of a session establishes the baseline, not a bust.
    if (session.records > 1 && (promptChanged || toolChanged)) {
      session.busts += 1;
      totals.busts += 1;
    }
    prev = record;
  }
  return sessions.filter((s) => s.records > 0);
}

/**
 * Prompt-cache stability across recorded live sessions. Sessions are bounded
 * to the most recent {@link MAX_SESSIONS}; totals cover everything read.
 * Returns null when no record anywhere carries v2 hashes (recorder too old).
 */
export async function getCacheBustStats(
  profile?: string | null,
): Promise<ContextCacheBustStats | null> {
  const totals = { hashed: 0, legacy: 0, busts: 0 };
  const sessions: ContextCacheBustSession[] = [];
  for (const { profile: id, file } of await resolveJsonlPaths(profile)) {
    sessions.push(...sessionsFor(id, readRecords(file), totals));
  }
  if (totals.hashed === 0 && totals.legacy === 0) return null;
  sessions.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return {
    sessions: sessions.slice(0, MAX_SESSIONS),
    hashedRecords: totals.hashed,
    legacyRecords: totals.legacy,
    busts: totals.busts,
  };
}
