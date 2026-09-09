import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// cache-ttl resolves its config dir and reads cache-ttl.json at *import*
// time, so each case uses a fresh temp PI_CODING_AGENT_DIR and a query-string
// re-import (distinct module URL → fresh module evaluation).
const ENV_KEY = "PI_CACHE_RETENTION";
const PREV_KEY = "PI_CACHE_RETENTION_PREV";

// Query-string re-import (distinct URL → fresh module evaluation). Built via
// interpolation so tsc doesn't try to statically resolve the specifier.
const moduleUrl = (name: string) => `./cache-ttl.ts?case=${name}`;

interface Ctx {
  dir: string;
  restore(): void;
}

function setup(config: unknown, preexisting?: string): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "cache-ttl-test-"));
  if (config !== undefined) writeFileSync(join(dir, "cache-ttl.json"), JSON.stringify(config));
  const saved = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    env: process.env[ENV_KEY],
    prev: process.env[PREV_KEY],
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env[ENV_KEY];
  delete process.env[PREV_KEY];
  if (preexisting !== undefined) process.env[ENV_KEY] = preexisting;
  return {
    dir,
    restore() {
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

describe("applyCacheRetention (import-time)", () => {
  test('retention "long" sets PI_CACHE_RETENTION and snapshots the previous value', async () => {
    const ctx = setup({ retention: "long" });
    try {
      await import(moduleUrl("long-fresh"));
      assert.equal(process.env[ENV_KEY], "long");
      assert.equal(process.env[PREV_KEY], ""); // no pre-existing value
    } finally {
      ctx.restore();
    }
  });

  test('retention "long" preserves a shell-provided PI_CACHE_RETENTION via PREV', async () => {
    const ctx = setup({ retention: "long" }, "shell-value");
    try {
      await import(moduleUrl("long-shell"));
      assert.equal(process.env[ENV_KEY], "long");
      assert.equal(process.env[PREV_KEY], "shell-value");
    } finally {
      ctx.restore();
    }
  });

  test('flipping back to "short" (no config) restores the shell value and clears markers', async () => {
    const ctx = setup({ retention: "long" }, "shell-value");
    try {
      await import(moduleUrl("flip-a"));
      assert.equal(process.env[ENV_KEY], "long");

      // Second evaluation with the config gone → back to "short".
      rmSync(join(process.env.PI_CODING_AGENT_DIR!, "cache-ttl.json"));
      await import(moduleUrl("flip-b"));
      assert.equal(process.env[ENV_KEY], "shell-value");
      assert.equal(process.env[PREV_KEY], undefined);
    } finally {
      ctx.restore();
    }
  });

  test('"short" with no prior override leaves the env untouched', async () => {
    const ctx = setup(undefined);
    try {
      await import(moduleUrl("short-plain"));
      assert.equal(process.env[ENV_KEY], undefined);
      assert.equal(process.env[PREV_KEY], undefined);
    } finally {
      ctx.restore();
    }
  });

  test("flipping to short after overriding an unset var removes the var again", async () => {
    const ctx = setup({ retention: "long" });
    try {
      await import(moduleUrl("unset-a"));
      assert.equal(process.env[ENV_KEY], "long");

      rmSync(join(process.env.PI_CODING_AGENT_DIR!, "cache-ttl.json"));
      await import(moduleUrl("unset-b"));
      assert.equal(process.env[ENV_KEY], undefined);
      assert.equal(process.env[PREV_KEY], undefined);
    } finally {
      ctx.restore();
    }
  });

  test("invalid JSON degrades to short (no crash, no override)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-ttl-test-"));
    writeFileSync(join(dir, "cache-ttl.json"), "{not json");
    const saved = {
      agentDir: process.env.PI_CODING_AGENT_DIR,
      env: process.env[ENV_KEY],
      prev: process.env[PREV_KEY],
    };
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env[ENV_KEY];
    delete process.env[PREV_KEY];
    try {
      await import(moduleUrl("bad-json"));
      assert.equal(process.env[ENV_KEY], undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("default factory", () => {
  test("re-applies retention on /reload without crashing", async () => {
    const ctx = setup({ retention: "long" });
    try {
      const mod = await import(moduleUrl("factory"));
      assert.equal(process.env[ENV_KEY], "long");
      // /reload with the toggle flipped back to short: the factory re-applies
      // and restores the (unset) pre-override env.
      writeFileSync(join(ctx.dir, "cache-ttl.json"), '{"retention":"short"}');
      mod.default(undefined);
      assert.equal(process.env[ENV_KEY], undefined);
    } finally {
      ctx.restore();
    }
  });
});
