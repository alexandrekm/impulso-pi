// Session-scoped OpenRouter backend pinning — pure logic (no pi imports).
//
// Why: a static `compat.openRouterRouting` pin in models.json routes EVERY
// session on the machine to the same backend. Great for prompt-cache hit
// rates within a session, terrible for provider rate limits once several
// concurrent sessions all hammer the same one. This module implements the
// per-session alternative: each pi session (its own process) picks ONE
// backend from a candidate list and sticks to it for the session's
// lifetime — cache stays warm per session, load spreads across backends.
//
// The pin is applied per request via pi's `before_provider_request` event:
// OpenRouter routing is just the request-body `provider` field
// (`params.provider = model.compat.openRouterRouting` in pi's
// openai-completions API), so returning
// `{ ...payload, provider: { only: [tag], allow_fallbacks: false } }`
// produces exactly the request models.json's compat pin would have — but
// chosen per session instead of globally. Payload injection (rather than
// mutating registry model objects) survives model-catalog refreshes, which
// rebuild model objects from config on every read.
//
// Pins persist by session id in <configDir>/openrouter-session-pin-state.json
// so /reload and resuming an old session reuse the same backend (no cache
// miss on reload). Stale sessions are pruned by age/count on every write.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One routable OpenRouter backend for a model. */
export interface BackendCandidate {
  /** OpenRouter provider tag as used in routing `only` (e.g. "baseten/fp8"). */
  tag: string;
  /** Display suffix for the model name (e.g. "BaseTen fp8"). Defaults to tag. */
  label?: string;
  /** Real $/M-token prices for this backend; applied to the live model object. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite?: number };
}

/** Candidate backends per model id (e.g. "z-ai/glm-5.3"). Empty = unpinned. */
export interface PinConfig {
  models: Record<string, BackendCandidate[]>;
}

interface SessionEntry {
  pins: Record<string, string>;
  updatedAt: number;
}

/** Persisted map of session id -> model id -> backend tag. */
export interface PinState {
  sessions: Record<string, SessionEntry>;
}

/** The subset of a pi model object this module touches. */
export interface ModelLike {
  name?: string;
  cost?: Record<string, number>;
}

const MAX_STATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 400;

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

function isCandidate(value: unknown): value is BackendCandidate {
  if (value === null || typeof value !== "object") return false;
  const tag = (value as BackendCandidate).tag;
  return typeof tag === "string" && tag.length > 0;
}

function toCandidate(value: BackendCandidate): BackendCandidate {
  const label = typeof value.label === "string" && value.label ? value.label : value.tag;
  return { tag: value.tag, label, cost: value.cost };
}

/** Parse openrouter-session-pin.json. Tolerant: junk/missing -> no pinning. */
export function parseConfig(raw: string): PinConfig {
  try {
    const data = JSON.parse(raw) as { models?: unknown };
    const models = data?.models;
    if (models === null || typeof models !== "object") return { models: {} };
    const out: PinConfig = { models: {} };
    for (const [modelId, candidates] of Object.entries(models)) {
      const valid = (Array.isArray(candidates) ? candidates : [])
        .filter(isCandidate)
        .map(toCandidate);
      if (valid.length > 0) out.models[modelId] = valid;
    }
    return out;
  } catch {
    return { models: {} };
  }
}

/** True when `tag` is still among the model's configured candidates. */
export function isCandidateTag(
  config: PinConfig,
  modelId: string,
  tag: string | undefined,
): boolean {
  if (!tag) return false;
  return (config.models[modelId] ?? []).some((candidate) => candidate.tag === tag);
}

// ─────────────────────────────────────────────────────────────────────────
// State file (pins per session id, so reload/resume reuse the same backend)
// ─────────────────────────────────────────────────────────────────────────

function isFreshEntry(entry: unknown, now: number): entry is SessionEntry {
  if (entry === null || typeof entry !== "object") return false;
  const { pins, updatedAt } = entry as SessionEntry;
  return (
    typeof updatedAt === "number" &&
    now - updatedAt < MAX_STATE_AGE_MS &&
    pins !== null &&
    typeof pins === "object"
  );
}

/** Keep recent sessions only (newest MAX_SESSIONS, younger than 30 days). */
export function pruneState(state: PinState, now: number): PinState {
  const fresh = Object.entries(state.sessions)
    .filter(([, entry]) => isFreshEntry(entry, now))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_SESSIONS);
  return { sessions: Object.fromEntries(fresh) };
}

export function loadState(path: string): PinState {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as PinState;
    if (data?.sessions !== null && typeof data.sessions === "object") return data;
  } catch {
    // Missing/corrupt state -> start fresh (in-memory pins still apply).
  }
  return { sessions: {} };
}

/** Persist pruned state. Atomic (tmp + rename); best-effort. */
export function saveState(path: string, state: PinState, now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(pruneState(state, now), null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // Non-fatal: this process keeps its pin in memory.
  }
}

/** The backend tag a previous process pinned for this session + model. */
export function readPersistedPin(
  state: PinState,
  sessionId: string,
  modelId: string,
): string | undefined {
  return state.sessions[sessionId]?.pins?.[modelId];
}

/** Return a new state with the pin recorded (and the session touched). */
export function recordPin(
  state: PinState,
  sessionId: string,
  modelId: string,
  tag: string,
  now: number,
): PinState {
  const entry = state.sessions[sessionId] ?? { pins: {}, updatedAt: now };
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: { pins: { ...entry.pins, [modelId]: tag }, updatedAt: now },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-request pin application
// ─────────────────────────────────────────────────────────────────────────

/** OpenRouter routing body for a pinned backend (same shape compat produces). */
export function routingFor(tag: string): { only: string[]; allow_fallbacks: boolean } {
  return { only: [tag], allow_fallbacks: false };
}

/** Return a copy of `payload` with OpenRouter routing pinned to `tag`. */
export function patchPayload(
  payload: Record<string, unknown>,
  tag: string,
): Record<string, unknown> {
  return { ...payload, provider: routingFor(tag) };
}

/** Pick a backend from the candidate list. Random: sessions are independent. */
export function pickBackend(
  candidates: BackendCandidate[],
  random: () => number = Math.random,
): BackendCandidate {
  return candidates[Math.floor(random() * candidates.length)];
}

/**
 * Rename + recost the live model object so the footer and usage accounting
 * reflect the pinned backend. Idempotent per object: the original
 * (unsuffixed) name is captured the first time we touch a model object;
 * registry refreshes hand out fresh objects carrying the models.json name,
 * so re-application rebuilds the suffix from the captured base.
 */
export function applyBackendToModel(
  model: ModelLike,
  candidate: BackendCandidate,
  baseNames: WeakMap<object, string>,
): void {
  if (!baseNames.has(model)) baseNames.set(model, model.name ?? "");
  model.name = `${baseNames.get(model) ?? ""} · ${candidate.label ?? candidate.tag}`;
  if (candidate.cost) model.cost = { ...model.cost, ...candidate.cost };
}
