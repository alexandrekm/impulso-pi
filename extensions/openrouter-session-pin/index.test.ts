import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// index.ts resolves its config dir at import time, so each case gets a fresh
// temp PI_CODING_AGENT_DIR + a re-import with a distinct module URL. The
// config pins one model with two candidates.
// Query-string re-import (distinct URL → fresh module evaluation). Built via
// interpolation so tsc doesn't try to statically resolve the specifier.
const moduleUrl = (name: string) => `./index.ts?case=${name}`;

const MODEL = "z-ai/glm-5.3";
const CONFIG = {
  idleRerollMinutes: 10,
  models: {
    [MODEL]: [
      { tag: "a/1", label: "A" },
      { tag: "b/2", label: "B" },
    ],
  },
};

interface Harness {
  handlers: Map<string, (event: any, ctx?: any) => unknown>;
  commands: Map<
    string,
    { getArgumentCompletions: (p: string) => any; handler: (a: string, c: any) => Promise<void> }
  >;
  dir: string;
  restore(): void;
}

function setup(disabled: boolean, config: unknown = CONFIG): Harness {
  const dir = mkdtempSync(join(tmpdir(), "orpin-test-"));
  writeFileSync(join(dir, "openrouter-session-pin.json"), JSON.stringify(config));
  if (disabled) {
    writeFileSync(
      join(dir, "impulso-settings.json"),
      JSON.stringify({ disabled: ["openrouter-session-pin"] }),
    );
  }
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return {
    dir,
    handlers: new Map(),
    commands: new Map(),
    restore() {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Each call gets a fresh temp dir AND a fresh module evaluation (index.ts
// resolves its config dir at import time — in real pi that's once per
// process, so a cached test module would keep pointing at a deleted dir).
let caseCounter = 0;
async function makePi(disabled = false, config: unknown = CONFIG) {
  const h = setup(disabled, config);
  const factory = (await import(`./index.ts?case=${disabled ? "off" : "on"}-${caseCounter++}`))
    .default;
  factory({
    on: (name: string, handler: (event: any, ctx?: any) => unknown) =>
      h.handlers.set(name, handler),
    registerCommand: (name: string, def: any) => h.commands.set(name, def),
    events: { emit: () => {}, on: () => {} },
  });
  return h;
}

function makeCtx(h: Harness, sessionId: string, model?: { id: string; name: string; cost: any }) {
  const notifications: { msg: string; level: string }[] = [];
  return {
    notifications,
    ctx: {
      model,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) },
    },
    state: () => readFileSync(join(h.dir, "openrouter-session-pin-state.json"), "utf8"),
  };
}

describe("openrouter-session-pin factory", () => {
  test("disabled feature registers nothing", async () => {
    const h = await makePi(true);
    assert.equal(h.handlers.size, 0);
    assert.equal(h.commands.size, 0);
    h.restore();
  });

  test("empty/missing config registers nothing", async () => {
    const h = setup(false);
    writeFileSync(join(h.dir, "openrouter-session-pin.json"), "{}");
    const factory = (await import(`./index.ts?case=empty-${caseCounter++}`)).default;
    const handlers = new Map();
    factory({
      on: (n: string, fn: any) => handlers.set(n, fn),
      registerCommand: () => {},
      events: { emit: () => {}, on: () => {} },
    });
    assert.equal(handlers.size, 0);
  });

  // (The module-location CONFIG_DIR fallback branch is only exercised in
  // real pi, where the module lives at <profile>/extensions/... and its
  // parent-of-parent IS the profile root; in the repo layout the fallback
  // points at the repo root, which has no config, so it isn't testable
  // here without polluting the repo root.)
  test("session_start/model_select with an unconfigured model is a no-op", async () => {
    const h = await makePi(false);
    const { ctx } = makeCtx(h, "s-noop", { id: "un/configured", name: "X", cost: {} });
    await h.handlers.get("session_start")!({}, ctx);
    await h.handlers.get("model_select")!({ model: ctx.model }, ctx);
    await h.handlers.get("session_start")!({}, { ...ctx, model: {} });
    assert.ok(!existsSync(join(h.dir, "openrouter-session-pin-state.json")));
    h.restore();
  });

  test("unreadable config (path is a directory) registers nothing", async () => {
    const h = setup(false);
    rmSync(join(h.dir, "openrouter-session-pin.json"));
    mkdirSync(join(h.dir, "openrouter-session-pin.json")); // readFileSync throws EISDIR
    const factory = (await import(`./index.ts?case=eisdir-${caseCounter++}`)).default;
    const handlers = new Map();
    factory({
      on: (n: string, fn: any) => handlers.set(n, fn),
      registerCommand: () => {},
      events: { emit: () => {}, on: () => {} },
    });
    assert.equal(handlers.size, 0);
    h.restore();
  });

  test("session pins the model, patches payloads, and persists the pin", async () => {
    const h = await makePi(false);
    const sessionId = "sess-1";
    const model = { id: MODEL, name: "GLM-5.3", cost: { input: 1 } };
    const { ctx, state } = makeCtx(h, sessionId, model);

    await h.handlers.get("session_start")!({}, ctx);
    // Model name got the backend suffix exactly once.
    assert.match(model.name, /^GLM-5\.3 · (A|B)$/);
    const pinnedTag = JSON.parse(state()).sessions[sessionId].pins[MODEL];
    assert.ok(["a/1", "b/2"].includes(pinnedTag));

    // Every provider request for the model carries the pin.
    for (let i = 0; i < 3; i++) {
      const patched = (await h.handlers.get("before_provider_request")!(
        { payload: { model: MODEL, messages: [] } },
        ctx,
      )) as any;
      assert.deepEqual(patched.provider, { only: [pinnedTag], allow_fallbacks: false });
      assert.equal(patched.model, MODEL);
    }

    // Other models pass through untouched.
    assert.equal(
      await h.handlers.get("before_provider_request")!({ payload: { model: "other" } }, ctx),
      undefined,
    );
    assert.equal(await h.handlers.get("before_provider_request")!({}, ctx), undefined);
    assert.equal(await h.handlers.get("before_provider_request")!({ payload: {} }, ctx), undefined);

    h.restore();
  });

  test("a second process (reload/resume) reuses the persisted pin", async () => {
    const h = setup(false);
    const sessionId = "sess-resume";
    // A previous process pinned this session to b/2.
    writeFileSync(
      join(h.dir, "openrouter-session-pin-state.json"),
      JSON.stringify({
        sessions: { [sessionId]: { pins: { [MODEL]: "b/2" }, updatedAt: Date.now() } },
      }),
    );
    const factory = (await import(moduleUrl("resume"))).default;
    const handlers = new Map<string, any>();
    factory({
      on: (n: string, fn: any) => handlers.set(n, fn),
      registerCommand: () => {},
      events: { emit: () => {}, on: () => {} },
    });
    const patched = (await handlers.get("before_provider_request")!(
      { payload: { model: MODEL } },
      { sessionManager: { getSessionId: () => sessionId }, ui: { notify: () => {} } },
    )) as any;
    assert.deepEqual(patched.provider, { only: ["b/2"], allow_fallbacks: false });
    h.restore();
  });

  test("stale persisted tag (removed from config) re-picks", async () => {
    const h = setup(false);
    writeFileSync(
      join(h.dir, "openrouter-session-pin-state.json"),
      JSON.stringify({
        sessions: { s: { pins: { [MODEL]: "gone/tag" }, updatedAt: Date.now() } },
      }),
    );
    const factory = (await import(moduleUrl("stale"))).default;
    const handlers = new Map<string, any>();
    factory({
      on: (n: string, fn: any) => handlers.set(n, fn),
      registerCommand: () => {},
      events: { emit: () => {}, on: () => {} },
    });
    const patched = (await handlers.get("before_provider_request")!(
      { payload: { model: MODEL } },
      { sessionManager: { getSessionId: () => "s" }, ui: { notify: () => {} } },
    )) as any;
    assert.ok(["a/1", "b/2"].includes(patched.provider.only[0]));
    h.restore();
  });

  test("model_select assigns a pin; before_agent_start re-asserts in place", async () => {
    const h = await makePi(false);
    const model = { id: MODEL, name: "GLM-5.3", cost: {} };
    const { ctx } = makeCtx(h, "s2", undefined);

    await h.handlers.get("model_select")!({ model }, ctx);
    assert.match(model.name, /^GLM-5\.3 · (A|B)$/);

    // A registry refresh replaces the object; before_agent_start re-applies.
    const refreshed = { id: MODEL, name: "GLM-5.3", cost: {} };
    await h.handlers.get("before_agent_start")!({}, { ...ctx, model: refreshed });
    assert.match(refreshed.name, /^GLM-5\.3 · (A|B)$/);
    // No pin for models without ctx.model id.
    await h.handlers.get("before_agent_start")!({}, { ...ctx, model: undefined });
    h.restore();
  });

  test("/orpin lists pins; /orpin reroll re-picks the current model", async () => {
    const h = await makePi(false);
    const model = { id: MODEL, name: "GLM-5.3", cost: {} };
    const { ctx, notifications } = makeCtx(h, "s3", model);
    const cmd = h.commands.get("orpin")!;

    // Before any pin: shows placeholders, tolerates an empty session id.
    await cmd.handler("", { ...ctx, sessionManager: { getSessionId: () => "" } });
    assert.match(notifications.at(-1)!.msg, /ephemeral/);
    assert.match(notifications.at(-1)!.msg, /\(no request yet\)/);

    await h.handlers.get("session_start")!({}, ctx);

    await cmd.handler("", ctx);
    assert.match(notifications.at(-1)!.msg, /z-ai\/glm-5\.3 → (a\/1|b\/2)/);

    await cmd.handler("reroll", ctx);
    const after = JSON.parse(
      readFileSync(join(h.dir, "openrouter-session-pin-state.json"), "utf8"),
    );
    // With 2 candidates a re-roll may legitimately land on the same tag;
    // what matters is a valid tag is persisted and the pin re-applied.
    assert.ok(["a/1", "b/2"].includes(after.sessions.s3.pins[MODEL]));
    assert.match(notifications.at(-1)!.msg, /Re-pinned/);

    // reroll on an unconfigured model just notifies.
    await cmd.handler("reroll", { ...ctx, model: { id: "other", name: "x" } });
    assert.match(notifications.at(-1)!.msg, /not configured/);

    // completions
    assert.deepEqual(
      (cmd.getArgumentCompletions("re") as any[]).map((o) => o.value),
      ["reroll"],
    );
    assert.deepEqual(cmd.getArgumentCompletions("zz"), []);
    h.restore();
  });

  test("session ids are resilient to a sessionManager without getSessionId", async () => {
    const h = await makePi(false);
    const patched = (await h.handlers.get("before_provider_request")!(
      { payload: { model: MODEL } },
      { sessionManager: {}, ui: { notify: () => {} } },
    )) as any;
    assert.ok(["a/1", "b/2"].includes(patched.provider.only[0]));
    assert.ok(existsSync(join(h.dir, "openrouter-session-pin-state.json")));
    h.restore();
  });

  test("sessionIdOf tolerates missing/throwing sessionManager", async () => {
    const h = await makePi(false);
    const hook = h.handlers.get("before_provider_request")!;
    const throwing = {
      sessionManager: {
        getSessionId: () => {
          throw new Error("boom");
        },
      },
      ui: { notify: () => {} },
    };
    for (const ctx of [undefined, throwing]) {
      const patched = (await hook({ payload: { model: MODEL } }, ctx)) as any;
      assert.ok(["a/1", "b/2"].includes(patched.provider.only[0]));
    }
    h.restore();
  });

  test("idle re-roll: a request after the idle gap moves to the other backend", async () => {
    // 0.001 min = 60ms threshold — real sleeps, but tiny.
    const h = await makePi(false, { ...CONFIG, idleRerollMinutes: 0.001 });
    const hook = h.handlers.get("before_provider_request")!;
    const ctx = { sessionManager: { getSessionId: () => "s-idle" }, ui: { notify: () => {} } };
    const first = (await hook({ payload: { model: MODEL } }, ctx)) as any;
    const touched = JSON.parse(
      readFileSync(join(h.dir, "openrouter-session-pin-state.json"), "utf8"),
    );
    assert.ok(touched.sessions["s-idle"].lastRequestAt[MODEL] > 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = (await hook({ payload: { model: MODEL } }, ctx)) as any;
    // Exclusion guarantees the re-roll actually moved.
    assert.notEqual(second.provider.only[0], first.provider.only[0]);
    const after = JSON.parse(
      readFileSync(join(h.dir, "openrouter-session-pin-state.json"), "utf8"),
    );
    assert.equal(after.sessions["s-idle"].pins[MODEL], second.provider.only[0]);
    h.restore();
  });

  test("idle re-roll disabled (idleRerollMinutes: 0) keeps the pin forever", async () => {
    const h = await makePi(false, { ...CONFIG, idleRerollMinutes: 0 });
    const hook = h.handlers.get("before_provider_request")!;
    const ctx = { sessionManager: { getSessionId: () => "s-pinned" }, ui: { notify: () => {} } };
    const first = (await hook({ payload: { model: MODEL } }, ctx)) as any;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = (await hook({ payload: { model: MODEL } }, ctx)) as any;
    assert.equal(second.provider.only[0], first.provider.only[0]);
    h.restore();
  });

  test("a resumed idle session re-rolls; lastRequestAt beats assignment time", async () => {
    const stale = Date.now() - 60 * 60_000; // 1h ago: past any cache TTL
    const fresh = Date.now() - 1000;
    const makeState = (lastRequestAt: number | null) => ({
      sessions: {
        "s-resume": {
          pins: { [MODEL]: "b/2" },
          updatedAt: stale, // assignment was an hour ago
          ...(lastRequestAt === null ? {} : { lastRequestAt: { [MODEL]: lastRequestAt } }),
        },
      },
    });

    // Stale by lastRequestAt: the pin re-rolls off b/2.
    const h1 = setup(false);
    writeFileSync(
      join(h1.dir, "openrouter-session-pin-state.json"),
      JSON.stringify(makeState(stale)),
    );
    const f1 = (await import(moduleUrl("resume-stale"))).default;
    const handlers1 = new Map<string, any>();
    f1({
      on: (n: string, fn: any) => handlers1.set(n, fn),
      registerCommand: () => {},
      events: { emit: () => {}, on: () => {} },
    });
    const rePatched = (await handlers1.get("before_provider_request")!(
      { payload: { model: MODEL } },
      { sessionManager: { getSessionId: () => "s-resume" }, ui: { notify: () => {} } },
    )) as any;
    assert.equal(rePatched.provider.only[0], "a/1");
    h1.restore();

    // Recent activity (lastRequestAt wins over the old assignment): pin kept.
    const h2 = setup(false);
    writeFileSync(
      join(h2.dir, "openrouter-session-pin-state.json"),
      JSON.stringify(makeState(fresh)),
    );
    const f2 = (await import(moduleUrl("resume-fresh"))).default;
    const handlers2 = new Map<string, any>();
    f2({
      on: (n: string, fn: any) => handlers2.set(n, fn),
      registerCommand: () => {},
      events: { emit: () => {}, on: () => {} },
    });
    const keptPatched = (await handlers2.get("before_provider_request")!(
      { payload: { model: MODEL } },
      { sessionManager: { getSessionId: () => "s-resume" }, ui: { notify: () => {} } },
    )) as any;
    assert.equal(keptPatched.provider.only[0], "b/2");
    h2.restore();
  });
});
