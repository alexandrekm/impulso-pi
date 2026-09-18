import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  distributeCost,
  generationIdFromHeaders,
  makeGenerationApi,
  pollGenerationCost,
  readOpenRouterKey,
  type GenerationApi,
} from "./openrouter-cost.ts";
import { wireOpenRouterCost } from "./index.ts";

// ---- generationIdFromHeaders ------------------------------------------------

describe("generationIdFromHeaders", () => {
  test("finds the header case-insensitively", () => {
    assert.equal(generationIdFromHeaders({ "X-Generation-Id": "gen-1" }), "gen-1");
    assert.equal(generationIdFromHeaders({ "x-generation-id": "gen-2" }), "gen-2");
    assert.equal(generationIdFromHeaders({ "X-GENERATION-ID": "gen-3", other: "x" }), "gen-3");
  });

  test("returns undefined for missing/empty/absent headers", () => {
    assert.equal(generationIdFromHeaders(undefined), undefined);
    assert.equal(generationIdFromHeaders({}), undefined);
    assert.equal(generationIdFromHeaders({ "x-generation-id": "" }), undefined);
    assert.equal(generationIdFromHeaders({ "content-type": "text/event-stream" }), undefined);
  });
});

// ---- distributeCost ----------------------------------------------------------

describe("distributeCost", () => {
  test("splits the total proportionally by token share", () => {
    const buckets = distributeCost({ input: 100, output: 50, cacheRead: 50, cacheWrite: 0 }, 2);
    assert.equal(buckets.input, 1);
    assert.equal(buckets.output, 0.5);
    assert.equal(buckets.cacheRead, 0.5);
    assert.equal(buckets.cacheWrite, 0);
    assert.equal(buckets.total, 2);
  });

  test("keeps bucket sum equal to the real total", () => {
    const buckets = distributeCost(
      { input: 40040, output: 47, cacheRead: 39910, cacheWrite: 0 },
      0.00033503,
    );
    const sum = buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite;
    assert.ok(Math.abs(sum - 0.00033503) < 1e-12);
    assert.equal(buckets.total, 0.00033503);
  });

  test("zero-token usage parks nothing in buckets but keeps the total", () => {
    const buckets = distributeCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 1.5);
    assert.equal(buckets.input, 0);
    assert.equal(buckets.output, 0);
    assert.equal(buckets.total, 1.5);
  });
});

// ---- pollGenerationCost -------------------------------------------------------

describe("pollGenerationCost", () => {
  const sleep = async () => {}; // instant for tests
  const opts = { attempts: 4, delayMs: 1500, sleep };

  test("returns on the first ready record without sleeping", async () => {
    const api: GenerationApi = { fetchGenerationCost: async () => 0.5 };
    const sleeps: number[] = [];
    const cost = await pollGenerationCost("g", api, {
      ...opts,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(cost, 0.5);
    assert.deepEqual(sleeps, []);
  });

  test("retries 404s until the record appears", async () => {
    let calls = 0;
    const api: GenerationApi = {
      fetchGenerationCost: async () => (calls++ < 2 ? null : 0.25),
    };
    const sleeps: number[] = [];
    const cost = await pollGenerationCost("g", api, {
      ...opts,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(cost, 0.25);
    assert.deepEqual(sleeps, [1500, 1500]);
  });

  test("gives up after the attempt budget", async () => {
    let calls = 0;
    const api: GenerationApi = { fetchGenerationCost: async () => (calls++, null) };
    const cost = await pollGenerationCost("g", api, opts);
    assert.equal(cost, null);
    assert.equal(calls, 4);
  });

  test("aborts immediately on non-404 failures", async () => {
    let calls = 0;
    const api: GenerationApi = {
      fetchGenerationCost: async () => {
        calls++;
        throw new Error("HTTP 401");
      },
    };
    const cost = await pollGenerationCost("g", api, opts);
    assert.equal(cost, null);
    assert.equal(calls, 1);
  });
});

// ---- makeGenerationApi --------------------------------------------------------

describe("makeGenerationApi", () => {
  test("maps 404 to null, other errors throw, 200 reads total_cost", async () => {
    const api = makeGenerationApi("k", (async (url: any, _init?: any) => {
      const status = String(url).endsWith("not-ready")
        ? 404
        : String(url).endsWith("boom")
          ? 500
          : 200;
      return {
        ok: status === 200,
        status,
        json: async () => ({ data: { total_cost: status === 200 ? 0.75 : null } }),
      };
    }) as unknown as typeof fetch);
    assert.equal(await api.fetchGenerationCost("not-ready"), null);
    assert.equal(await api.fetchGenerationCost("ready"), 0.75);
    await assert.rejects(api.fetchGenerationCost("boom"), /HTTP 500/);
  });
});

// ---- readOpenRouterKey ---------------------------------------------------------

describe("readOpenRouterKey", () => {
  test("reads the openrouter key from auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcost-key-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openrouter: { key: "sk-or-1" } }));
    assert.equal(readOpenRouterKey(dir), "sk-or-1");
  });

  test("missing file, missing provider, or empty key → undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcost-key-"));
    assert.equal(readOpenRouterKey(dir), undefined);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { key: "x" } }));
    assert.equal(readOpenRouterKey(dir), undefined);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openrouter: { key: "" } }));
    assert.equal(readOpenRouterKey(dir), undefined);
    writeFileSync(join(dir, "auth.json"), "not json");
    assert.equal(readOpenRouterKey(dir), undefined);
  });
});

// ---- wiring ---------------------------------------------------------------------

interface Wiring {
  handlers: Map<string, (event: any, ctx?: any) => unknown>;
  respond(event: any, ctx?: any): unknown;
  settle(event: any): Promise<unknown>;
}

function setup(api: GenerationApi): Wiring {
  const handlers = new Map<string, (event: any, ctx?: any) => unknown>();
  const pi = {
    on: (name: string, handler: (event: any, ctx?: any) => unknown) => handlers.set(name, handler),
  };
  wireOpenRouterCost(pi as any, { api });
  const respond = (event: any, ctx?: any): unknown =>
    handlers.get("after_provider_response")?.(event, ctx);
  const settle = (event: any): Promise<unknown> =>
    (handlers.get("message_end") as (e: any) => Promise<unknown>)(event);
  return { handlers, respond, settle };
}

const OPENROUTER_CTX = { model: { provider: "openrouter" } };
const USAGE = { input: 100, output: 100, cacheRead: 300, cacheWrite: 0, cost: { total: 999 } };

describe("wireOpenRouterCost", () => {
  test("registers both handlers", () => {
    const w = setup({ fetchGenerationCost: async () => 1 });
    assert.ok(w.handlers.has("after_provider_response"));
    assert.ok(w.handlers.has("message_end"));
  });

  test("captures the id and rewrites usage.cost at message_end", async () => {
    let requestedId = "";
    const w = setup({
      fetchGenerationCost: async (id: string) => {
        requestedId = id;
        return 2;
      },
    });
    w.respond({ status: 200, headers: { "x-generation-id": "gen-9" } }, OPENROUTER_CTX);
    const result = (await w.settle({
      message: { role: "assistant", provider: "openrouter", usage: { ...USAGE } },
    })) as { message: { usage: { cost: { total: number; input: number; cacheRead: number } } } };
    assert.equal(requestedId, "gen-9");
    assert.equal(result.message.usage.cost.total, 2);
    assert.equal(result.message.usage.cost.input, 0.4); // 100/500 of the total
    assert.equal(result.message.usage.cost.cacheRead, 1.2); // 300/500
  });

  test("ignores other providers and non-openrouter models", async () => {
    const w = setup({ fetchGenerationCost: async () => 2 });
    w.respond(
      { status: 200, headers: { "x-generation-id": "gen-1" } },
      {
        model: { provider: "anthropic" },
      },
    );
    const result = await w.settle({
      message: { role: "assistant", provider: "anthropic", usage: { ...USAGE } },
    });
    assert.equal(result, undefined);
  });

  test("ignores failed responses (non-200) and headerless responses", async () => {
    const w = setup({ fetchGenerationCost: async () => 2 });
    w.respond({ status: 502, headers: { "x-generation-id": "gen-err" } }, OPENROUTER_CTX);
    assert.equal(
      await w.settle({
        message: { role: "assistant", provider: "openrouter", usage: { ...USAGE } },
      }),
      undefined,
    );
    w.respond({ status: 200, headers: {} }, OPENROUTER_CTX);
    assert.equal(
      await w.settle({
        message: { role: "assistant", provider: "openrouter", usage: { ...USAGE } },
      }),
      undefined,
    );
  });

  test("leaves cost untouched when the record never appears", async () => {
    const w = setup({ fetchGenerationCost: async () => null });
    w.respond({ status: 200, headers: { "x-generation-id": "gen-slow" } }, OPENROUTER_CTX);
    const result = await w.settle({
      message: { role: "assistant", provider: "openrouter", usage: { ...USAGE } },
    });
    assert.equal(result, undefined); // no mutation → pi's calculated cost stays
  });

  test("consumes the pending id once; the next message without a response is untouched", async () => {
    const w = setup({ fetchGenerationCost: async () => 5 });
    w.respond({ status: 200, headers: { "x-generation-id": "gen-a" } }, OPENROUTER_CTX);
    const first = (await w.settle({
      message: { role: "assistant", provider: "openrouter", usage: { ...USAGE } },
    })) as { message: { usage: { cost: { total: number } } } };

    assert.equal(first.message.usage.cost.total, 5);
    assert.equal(
      await w.settle({
        message: { role: "assistant", provider: "openrouter", usage: { ...USAGE } },
      }),
      undefined,
    );
  });

  test("no usage on the message → no mutation", async () => {
    const w = setup({ fetchGenerationCost: async () => 5 });
    w.respond({ status: 200, headers: { "x-generation-id": "gen-b" } }, OPENROUTER_CTX);
    assert.equal(
      await w.settle({ message: { role: "assistant", provider: "openrouter" } }),
      undefined,
    );
  });
});
