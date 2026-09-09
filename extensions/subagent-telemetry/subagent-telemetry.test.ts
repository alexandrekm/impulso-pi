import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The factory gates on isFeatureEnabled("subagent-telemetry"), which resolves
// its config dir at import time — point it at a fresh temp dir first.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));

const {
  boundedSessionId,
  terminalState,
  contextFromPayload,
  numericTotal,
  costTotal,
  stepUsage,
  childTotals,
  default: factory,
} = await import("./subagent-telemetry.ts");

describe("boundedSessionId", () => {
  test("extracts only the trailing UUID from a session path", () => {
    assert.equal(
      boundedSessionId(
        "sessions/2026-09-03T06-57-39-108Z_01a0660f-1324-7b8e-a1c3-e8f5ea7a24e3.jsonl",
      ),
      "01a0660f-1324-7b8e-a1c3-e8f5ea7a24e3",
    );
  });
  test("accepts a bare UUID and rejects non-UUIDs", () => {
    assert.equal(
      boundedSessionId("01a0660f-1324-7b8e-a1c3-e8f5ea7a24e3"),
      "01a0660f-1324-7b8e-a1c3-e8f5ea7a24e3",
    );
    assert.equal(boundedSessionId("not-a-uuid"), undefined);
    assert.equal(boundedSessionId(42), undefined);
  });
});

describe("terminalState", () => {
  test("accepts the five terminal states, rejects everything else", () => {
    for (const s of ["complete", "failed", "partial", "stopped", "rejected"]) {
      assert.equal(terminalState(s), s);
    }
    assert.equal(terminalState("running"), undefined);
    assert.equal(terminalState(undefined), undefined);
  });
});

describe("contextFromPayload", () => {
  test("direct context wins", () => {
    assert.equal(contextFromPayload({ context: "fresh" }), "fresh");
    assert.equal(contextFromPayload({ context: "fork" }), "fork");
  });
  test("single distinct result context is used", () => {
    assert.equal(
      contextFromPayload({ results: [{ context: "fork" }, { context: "fork" }, {}] }),
      "fork",
    );
  });
  test("conflicting result contexts are mixed", () => {
    assert.equal(
      contextFromPayload({ results: [{ context: "fork" }, { context: "fresh" }] }),
      "mixed",
    );
  });
  test("no context anywhere is unknown", () => {
    assert.equal(contextFromPayload({ results: [{}, { context: "bogus" }] }), "unknown");
    assert.equal(contextFromPayload({}), "unknown");
  });
});

describe("numericTotal / costTotal", () => {
  test("numericTotal: plain number, nested records, junk", () => {
    assert.equal(numericTotal(7), 7);
    assert.equal(numericTotal({ total: 5 }), 5);
    assert.equal(numericTotal({ totalTokens: 4 }), 4);
    assert.equal(numericTotal({ total: 1, totalTokens: 2 }), 1); // total wins
    assert.equal(numericTotal("x"), undefined);
    assert.equal(numericTotal(Number.NaN), undefined);
    assert.equal(numericTotal({ junk: true }), undefined);
  });
  test("costTotal: plain number, costUsd, legacy total", () => {
    assert.equal(costTotal(0.25), 0.25);
    assert.equal(costTotal({ costUsd: 0.3 }), 0.3);
    assert.equal(costTotal({ total: 0.4 }), 0.4);
    assert.equal(costTotal(null), undefined);
    assert.equal(costTotal([]), undefined);
  });
});

describe("stepUsage", () => {
  test("direct fields", () => {
    assert.deepEqual(stepUsage({ turnCount: 2, toolCount: 3, cost: 0.1, model: "m" }), {
      turns: 2,
      tools: 3,
      tokens: undefined,
      cost: 0.1,
      model: "m",
    });
  });
  test("nested totalTokens record", () => {
    assert.equal(stepUsage({ totalTokens: { total: 15 } }).tokens, 15);
  });
  test("nested tokens record", () => {
    assert.equal(stepUsage({ tokens: { total: 7 } }).tokens, 7);
    // {input, output}-only records (no total) are not a supported shape.
    assert.equal(stepUsage({ tokens: { input: 1, output: 2 } }).tokens, undefined);
  });
  test("usage object: input+output tokens, turns, cost", () => {
    const u = stepUsage({ usage: { input: 10, output: 5, turns: 4, cost: 0.2 } });
    assert.equal(u.tokens, 15);
    assert.equal(u.turns, 4);
    assert.equal(u.cost, 0.2);
  });
  test("totalCost record with costUsd wins over step cost", () => {
    assert.equal(stepUsage({ totalCost: { costUsd: 0.7 }, cost: 0.1 }).cost, 0.7);
  });
});

describe("childTotals", () => {
  test("sums per-step results and keeps the first model", () => {
    const t = childTotals({
      results: [
        {
          turnCount: 1,
          toolCount: 2,
          totalTokens: { total: 100 },
          totalCost: { costUsd: 0.5 },
          model: "m1",
        },
        { turnCount: 1, toolCount: 1, tokens: { total: 3 }, cost: 0.1 },
      ],
    });
    assert.deepEqual(t, { turns: 2, tools: 3, totalTokens: 103, totalCost: 0.6, model: "m1" });
  });
  test("top-level aggregates win over per-step sums", () => {
    const t = childTotals({
      turnCount: 9,
      toolCount: 8,
      totalTokens: 700,
      totalCost: 1.5,
      model: "top-model",
      results: [{ turnCount: 1, toolCount: 1, cost: 0.1 }],
    });
    assert.deepEqual(t, {
      turns: 9,
      tools: 8,
      totalTokens: 700,
      totalCost: 1.5,
      model: "top-model",
    });
  });
  test("a bare payload (no results) is itself the single step", () => {
    assert.deepEqual(childTotals({ turnCount: 5 }), { turns: 5 });
  });
  test("an empty payload reports nothing", () => {
    assert.deepEqual(childTotals({}), {});
  });
  test("non-record results are dropped", () => {
    assert.deepEqual(childTotals({ results: ["junk", { turnCount: 1 }] }), { turns: 1 });
  });
});

// ── event handlers via a mock pi ───────────────────────────────────────────

function makePi() {
  const handlers = new Map<string, (raw: unknown) => void>();
  const entries: { type: string; entry: Record<string, unknown> }[] = [];
  factory({
    events: { on: (name: string, h: (raw: unknown) => void) => handlers.set(name, h) },
    appendEntry: (type: string, entry: Record<string, unknown>) => entries.push({ type, entry }),
  } as never);
  return {
    started: handlers.get("subagent:async-started")!,
    completed: handlers.get("subagent:async-complete")!,
    entries,
    byRun: (runId: string) => entries.filter((e) => e.entry.runId === runId),
  };
}

const SESSION_FILE = "sess/2026-09-03T06-57-39-108Z_01a0660f-1324-7b8e-a1c3-e8f5ea7a24e3.jsonl";

describe("subagent:async-started handler", () => {
  test("appends a bounded started entry", () => {
    const pi = makePi();
    pi.started({
      id: "r1",
      agent: "scout",
      mode: "scout",
      startedAt: 1000,
      sessionId: SESSION_FILE,
    });
    const e = pi.byRun("r1");
    assert.equal(e.length, 1);
    assert.equal(e[0].type, "impulso.subagent-run.v1");
    assert.equal(e[0].entry.state, "started");
    assert.equal(e[0].entry.role, "scout");
    assert.equal(e[0].entry.mode, "scout");
    assert.equal(e[0].entry.async, true);
    assert.equal(e[0].entry.startedAt, 1000);
    assert.equal(e[0].entry.parentSessionId, "01a0660f-1324-7b8e-a1c3-e8f5ea7a24e3");
    assert.equal(e[0].entry.timeoutMs, undefined); // absent → not included
  });
  test("ignores non-record, missing, or duplicate payloads", () => {
    const pi = makePi();
    pi.started("junk");
    pi.started({ agent: "scout", mode: "scout" }); // no id
    pi.started({ id: "r2", mode: "scout" }); // no agent
    pi.started({ id: "r2", agent: "scout" }); // no mode
    assert.equal(pi.entries.length, 0);
    pi.started({ id: "r3", agent: "a", mode: "m" });
    pi.started({ id: "r3", agent: "a", mode: "m" }); // duplicate: ignored
    assert.equal(pi.byRun("r3").length, 1);
  });
  test("records timeoutMs and lifecycleArtifactVersion when present", () => {
    const pi = makePi();
    pi.started({ id: "r4", agent: "a", mode: "m", timeoutMs: 5000, lifecycleArtifactVersion: 3 });
    const e = pi.byRun("r4")[0].entry;
    assert.equal(e.timeoutMs, 5000);
    assert.equal(e.lifecycleArtifactVersion, 3);
  });
});

describe("subagent:async-complete handler", () => {
  test("merges a terminal entry onto a started run", () => {
    const pi = makePi();
    pi.started({ id: "c1", agent: "scout", mode: "scout", startedAt: 1000 });
    pi.completed({ runId: "c1", state: "complete", endedAt: 3000, durationMs: 2000 });
    const es = pi.byRun("c1");
    assert.equal(es.length, 2);
    assert.equal(es[1].entry.state, "complete");
    assert.equal(es[1].entry.endedAt, 3000);
    assert.equal(es[1].entry.durationMs, 2000);
    assert.equal(es[1].entry.role, "scout");
  });
  test("synthesizes an entry for an unstarted run, back-computing startedAt", () => {
    const pi = makePi();
    pi.completed({ runId: "c2", state: "failed", endedAt: 5000, durationMs: 1500 });
    const e = pi.byRun("c2")[0].entry;
    assert.equal(e.role, "unknown");
    assert.equal(e.mode, "unknown");
    assert.equal(e.startedAt, 3500);
    assert.equal(e.state, "failed");
  });
  test("ignores unknown states and missing run ids", () => {
    const pi = makePi();
    pi.completed({ runId: "x", state: "bogus" });
    pi.completed({ state: "complete" });
    pi.completed("junk");
    assert.equal(pi.entries.length, 0);
  });
  test("records a terminal run exactly once", () => {
    const pi = makePi();
    pi.completed({ runId: "c3", state: "stopped" });
    pi.completed({ runId: "c3", state: "complete" });
    assert.equal(pi.byRun("c3").length, 1);
  });
  test("flattens flags and child totals into the terminal entry", () => {
    const pi = makePi();
    pi.completed({
      runId: "c4",
      state: "partial",
      endedAt: 9000,
      timedOut: true,
      stopped: false,
      turnCount: 2,
      model: "sonnet",
      results: [{ toolCount: 1, cost: 0.25, context: "fork" }],
    });
    const e = pi.byRun("c4")[0].entry;
    assert.equal(e.timedOut, true);
    assert.equal(e.stopped, false);
    assert.equal(e.turns, 2);
    assert.equal(e.tools, 1);
    assert.equal(e.totalCost, 0.25);
    assert.equal(e.model, "sonnet");
    assert.equal(e.context, "fork");
  });
});
