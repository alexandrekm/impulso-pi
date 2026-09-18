// openrouter-cost — accrue the REAL OpenRouter cost of every request.
//
// pi computes per-request cost from the model catalog's static rates
// (packages/ai/src/models.ts calculateCost): usage tokens × model.cost. For
// OpenRouter models that's an estimate — the actual billed amount depends on
// the serving backend (BaseTen fp8 vs fp4, Fireworks, Modal, …) and its
// cache pricing, which is why openrouter-session-pin patches the live
// model's rates per pinned backend, and why models.json carries cost
// overrides. Those tables drift (cacheRead especially: OpenRouter's
// endpoints API reports 0 for backends that bill ~$0.007-0.03/Mtok,
// verified 2026-09 by comparing response usage.cost against endpoint
// pricing).
//
// The authoritative number is what OpenRouter itself reports: every response
// carries an `x-generation-id` header, and the Generation API
// (GET /api/v1/generation?id=<gid>) returns the actual total_cost for that
// request (available a few seconds after the response completes). This
// extension captures the id from `after_provider_response` and, at
// `message_end`, polls the Generation API and rewrites the assistant
// message's usage.cost with the real billing — the same trick
// pi-provider-litellm uses with the x-litellm-response-cost header, adapted
// for OpenRouter's "cost lives in a follow-up API" model.
//
// Cost distribution: OpenRouter reports one total; pi's usage.cost tracks
// input/output/cacheRead/cacheWrite buckets (the footer's cache-cost % reads
// them), so the total is split proportionally by token share.
//
// Trade-off: the generation record appears ~2-5s after the response, and pi
// awaits message_end handlers, so every assistant message gains a bounded
// poll (POLL_ATTEMPTS × POLL_DELAY_MS, early-exit on success). On timeout or
// any error the message keeps pi's locally-calculated cost — static tables
// stay as the fallback, they just stop being the source of truth.
//
// Toggled in /settings → Providers → OpenRouter (kind: local; the factory in
// index.ts bails out when disabled). /reload applies.

import { readFileSync } from "node:fs";

export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface CostedUsage extends UsageLike {
  cost: CostBuckets;
}

/** Read `x-generation-id` from a response header map, case-insensitively. */
export function generationIdFromHeaders(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-generation-id" && typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Split a real total cost across pi's usage buckets, proportional to token
 * share, so downstream per-bucket reads (e.g. the footer's cache-cost split)
 * stay meaningful. Zero-token usage parks nothing in the buckets.
 */
export function distributeCost(usage: UsageLike, total: number): CostBuckets {
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const fraction = (count: number): number => (tokens > 0 ? (count / tokens) * total : 0);
  return {
    input: fraction(usage.input),
    output: fraction(usage.output),
    cacheRead: fraction(usage.cacheRead),
    cacheWrite: fraction(usage.cacheWrite),
    total,
  };
}

export interface GenerationApi {
  /**
   * Fetch the generation record. Resolves with the total cost when the
   * record is ready, `null` when it doesn't exist yet (HTTP 404). Throws
   * on other failures (auth, network, server error) — only 404 is retried.
   */
  fetchGenerationCost(id: string): Promise<number | null>;
}

export interface PollOptions {
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Poll the Generation API until the record appears, within a bounded budget.
 * Resolves with the real cost, or null when the record never showed up
 * (the caller then leaves pi's locally-calculated cost in place).
 */
export async function pollGenerationCost(
  id: string,
  api: GenerationApi,
  opts: PollOptions,
): Promise<number | null> {
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (attempt > 0) await opts.sleep(opts.delayMs);
    try {
      const cost = await api.fetchGenerationCost(id);
      if (cost !== null) return cost;
    } catch {
      return null; // non-404 failure: don't burn the budget, fall back
    }
  }
  return null;
}

/** Build a GenerationApi client against OpenRouter with the given API key. */
export function makeGenerationApi(key: string, fetchFn: typeof fetch): GenerationApi {
  return {
    async fetchGenerationCost(id: string): Promise<number | null> {
      const res = await fetchFn(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${key}` },
        },
      );
      if (res.status === 404) return null; // record not ready yet → retry
      if (!res.ok) throw new Error(`generation api: HTTP ${res.status}`);
      const data = (await res.json()) as { data?: { total_cost?: number | null } };
      const cost = data.data?.total_cost;
      return typeof cost === "number" ? cost : null;
    },
  };
}

/** Read the OpenRouter API key from a pi config dir's auth.json. */
export function readOpenRouterKey(configDir: string): string | undefined {
  try {
    const raw = readFileSync(`${configDir}/auth.json`, "utf8");
    const key = (JSON.parse(raw) as { openrouter?: { key?: string } }).openrouter?.key;
    return typeof key === "string" && key ? key : undefined;
  } catch {
    return undefined;
  }
}
