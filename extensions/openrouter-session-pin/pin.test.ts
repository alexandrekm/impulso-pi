import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyBackendToModel,
  type BackendCandidate,
  isCandidateTag,
  loadState,
  parseConfig,
  patchPayload,
  pickBackend,
  pruneState,
  readPersistedPin,
  recordPin,
  routingFor,
  saveState,
} from "./pin.ts";

const CANDIDATES: BackendCandidate[] = [
  { tag: "baseten/fp8", label: "BaseTen fp8", cost: { input: 2.1, output: 6.6, cacheRead: 0.21 } },
  { tag: "modal", label: "Modal" },
];

describe("parseConfig", () => {
  test("parses candidates and defaults label to tag", () => {
    const config = parseConfig(
      JSON.stringify({ models: { "z-ai/glm-5.3": [{ tag: "x/y" }, { tag: "a", label: "A" }] } }),
    );
    assert.deepEqual(config.models["z-ai/glm-5.3"], [
      { tag: "x/y", label: "x/y", cost: undefined },
      { tag: "a", label: "A", cost: undefined },
    ]);
  });

  test("drops invalid entries and empty candidate lists", () => {
    const config = parseConfig(
      JSON.stringify({
        models: {
          m1: ["nope", { label: "missing tag" }, null, { tag: "ok" }],
          m2: [],
          m3: "not-a-list",
        },
      }),
    );
    assert.deepEqual(Object.keys(config.models), ["m1"]);
    assert.equal(config.models.m1!.length, 1);
  });

  test("junk or model-less input pins nothing", () => {
    assert.deepEqual(parseConfig("not json"), { models: {} });
    assert.deepEqual(parseConfig('{"models": "x"}'), { models: {} });
    assert.deepEqual(parseConfig("{}"), { models: {} });
  });
});

describe("isCandidateTag", () => {
  const config = parseConfig(JSON.stringify({ models: { m: CANDIDATES } }));

  test("true only for tags still in the model's list", () => {
    assert.equal(isCandidateTag(config, "m", "baseten/fp8"), true);
    assert.equal(isCandidateTag(config, "m", "modal"), true);
    assert.equal(isCandidateTag(config, "m", "gone"), false);
    assert.equal(isCandidateTag(config, "m", undefined), false);
    assert.equal(isCandidateTag(config, "other", "baseten/fp8"), false);
  });
});

describe("pickBackend", () => {
  test("uses the injected random source", () => {
    assert.equal(pickBackend(CANDIDATES, () => 0).tag, "baseten/fp8");
    assert.equal(pickBackend(CANDIDATES, () => 0.99).tag, "modal");
  });

  test("always returns a configured candidate", () => {
    for (let i = 0; i < 50; i++) {
      assert.ok(CANDIDATES.includes(pickBackend(CANDIDATES)));
    }
  });
});

describe("routingFor / patchPayload", () => {
  test("routing matches models.json compat shape", () => {
    assert.deepEqual(routingFor("baseten/fp8"), { only: ["baseten/fp8"], allow_fallbacks: false });
  });

  test("patch keeps the payload and overrides provider", () => {
    const patched = patchPayload({ model: "m", messages: [], provider: "old" }, "modal");
    assert.equal(patched.model, "m");
    assert.deepEqual(patched.provider, { only: ["modal"], allow_fallbacks: false });
  });

  test("patch adds provider when absent", () => {
    const patched = patchPayload({ model: "m" }, "modal");
    assert.deepEqual(patched.provider, { only: ["modal"], allow_fallbacks: false });
  });
});

describe("applyBackendToModel", () => {
  test("suffixes the name once and applies cost", () => {
    const baseNames = new WeakMap<object, string>();
    const model = { name: "GLM-5.3", cost: { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 1 } };
    applyBackendToModel(model, CANDIDATES[0]!, baseNames);
    assert.equal(model.name, "GLM-5.3 · BaseTen fp8");
    assert.deepEqual(model.cost, { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 1 });

    // Idempotent per object: no double suffix.
    applyBackendToModel(model, CANDIDATES[0]!, baseNames);
    assert.equal(model.name, "GLM-5.3 · BaseTen fp8");

    // Re-applying on the same object with another backend rebuilds from base.
    applyBackendToModel(model, CANDIDATES[1]!, baseNames);
    assert.equal(model.name, "GLM-5.3 · Modal");
  });

  test("fresh object (registry refresh) starts from its own base name", () => {
    const baseNames = new WeakMap<object, string>();
    const refreshed = { name: "GLM-5.3", cost: {} };
    applyBackendToModel(refreshed, CANDIDATES[1]!, baseNames);
    assert.equal(refreshed.name, "GLM-5.3 · Modal");
  });

  test("missing cost left untouched; label falls back to tag", () => {
    const baseNames = new WeakMap<object, string>();
    const model = { name: "K", cost: { input: 9 } };
    applyBackendToModel(model, { tag: "fireworks" }, baseNames);
    assert.equal(model.name, "K · fireworks");
    assert.deepEqual(model.cost, { input: 9 });
  });
});

describe("state file", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "orpin-state-"));
  const NOW = 1_700_000_000_000;

  test("missing, corrupt, or wrong-shape file loads as empty", () => {
    const d = dir();
    assert.deepEqual(loadState(join(d, "state.json")), { sessions: {} });
    writeFileSync(join(d, "state.json"), "{corrupt");
    assert.deepEqual(loadState(join(d, "state.json")), { sessions: {} });
    writeFileSync(join(d, "state.json"), JSON.stringify({ sessions: "nope" }));
    assert.deepEqual(loadState(join(d, "state.json")), { sessions: {} });
    writeFileSync(join(d, "state.json"), JSON.stringify({ sessions: null }));
    assert.deepEqual(loadState(join(d, "state.json")), { sessions: {} });
    rmSync(d, { recursive: true, force: true });
  });

  test("record + save + load roundtrip; readPersistedPin", () => {
    const d = dir();
    const path = join(d, "state.json");
    const state = recordPin({ sessions: {} }, "s1", "z-ai/glm-5.3", "baseten/fp8", NOW);
    saveState(path, state, NOW);
    const loaded = loadState(path);
    assert.equal(readPersistedPin(loaded, "s1", "z-ai/glm-5.3"), "baseten/fp8");
    assert.equal(readPersistedPin(loaded, "s1", "other"), undefined);
    assert.equal(readPersistedPin(loaded, "s2", "z-ai/glm-5.3"), undefined);
    // File is valid JSON with a trailing newline.
    assert.ok(readFileSync(path, "utf8").endsWith("\n"));
    rmSync(d, { recursive: true, force: true });
  });

  test("recordPin touches updatedAt and merges pins per session", () => {
    const first = recordPin({ sessions: {} }, "s1", "m1", "a", NOW);
    const second = recordPin(first, "s1", "m2", "b", NOW + 5);
    assert.equal(second.sessions.s1!.pins.m1, "a");
    assert.equal(second.sessions.s1!.pins.m2, "b");
    assert.equal(second.sessions.s1!.updatedAt, NOW + 5);
  });

  test("pruneState drops stale entries and caps session count", () => {
    const sessions: Record<string, { pins: Record<string, string>; updatedAt: number }> = {};
    for (let i = 0; i < 10; i++) sessions[`s${i}`] = { pins: { m: "a" }, updatedAt: NOW + i };
    sessions["stale"] = { pins: { m: "a" }, updatedAt: NOW - 31 * 24 * 60 * 60 * 1000 };
    const pruned = pruneState({ sessions }, NOW + 100);
    assert.equal(pruned.sessions.stale, undefined);
    assert.equal(Object.keys(pruned.sessions).length, 10);
    // Cap: newest MAX_SESSIONS survive — with 10 < cap all remain, so test the
    // ordering path by pruning a capped clone.
    const many: Record<string, { pins: Record<string, string>; updatedAt: number }> = {};
    for (let i = 0; i < 450; i++) many[`s${i}`] = { pins: {}, updatedAt: NOW + i };
    const capped = pruneState({ sessions: many }, NOW + 1000);
    assert.equal(Object.keys(capped.sessions).length, 400);
    assert.notEqual(capped.sessions.s449, undefined); // newest kept
    assert.equal(capped.sessions.s0, undefined); // oldest evicted
  });

  test("pruneState drops structurally invalid entries", () => {
    const bad = { sessions: { junk: { noPins: true, updatedAt: NOW } } };
    assert.deepEqual(pruneState(bad as never, NOW), { sessions: {} });
  });

  test("saveState prunes on write and is atomic (tmp + rename)", () => {
    const d = dir();
    const path = join(d, "state.json");
    const state = recordPin({ sessions: {} }, "s", "m", "a", NOW);
    saveState(path, state, NOW);
    saveState(path, recordPin(state, "s", "m", "b", NOW), NOW);
    assert.equal(loadState(path).sessions.s!.pins.m, "b");
    // No leftover temp files.
    assert.equal(readdirJsonOnly(d).length, 1);
    rmSync(d, { recursive: true, force: true });
  });

  test("saveState swallows write failures (dirname is a file)", () => {
    const d = dir();
    writeFileSync(join(d, "blocker"), "x");
    // mkdirSync on a path whose parent is a file throws -> caught, no crash.
    saveState(join(d, "blocker", "state.json"), { sessions: {} }, NOW);
    rmSync(d, { recursive: true, force: true });
  });
});

function readdirJsonOnly(d: string) {
  return readdirSync(d).filter((f) => f.endsWith(".json"));
}
