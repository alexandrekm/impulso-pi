import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

// Feature-flag reads PI_CODING_AGENT_DIR at module load; point it at a
// throwaway config dir so the tests never see (or touch) the real manifest.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;

const { default: factory, bestRealPath, normalizeRoot } = await import("./zvec-guard.ts");

const MANIFEST = join(CONFIG_DIR, "impulso-settings.json");

function setDisabled(featureId: string | null): void {
  if (featureId === null) rmSync(MANIFEST, { force: true });
  else writeFileSync(MANIFEST, JSON.stringify({ disabled: [featureId] }), "utf8");
}

/** Fresh handler with zvec-guard enabled (no manifest = everything on). */
function enabledHandler() {
  setDisabled(null);
  const hooks: Array<(event: unknown, ctx: unknown) => unknown> = [];
  factory({ on: (_name: string, fn: (event: unknown, ctx: unknown) => unknown) => hooks.push(fn) });
  assert.equal(hooks.length, 1, "exactly one tool_call hook registered");
  return hooks[0];
}

function call(root: unknown, mode: unknown, toolName = "zvec_index", cwd?: string) {
  return enabledHandler()(
    { toolName, input: mode === undefined && root === undefined ? {} : { root, mode } },
    cwd === undefined ? {} : { cwd },
  );
}

describe("factory", () => {
  test("registers nothing when the feature is disabled", () => {
    setDisabled("zvec-guard");
    const hooks: unknown[] = [];
    factory({ on: () => hooks.push(1) });
    assert.equal(hooks.length, 0);
  });

  test("registers exactly one hook when enabled", () => {
    enabledHandler(); // asserts internally
  });
});

describe("hook", () => {
  test("ignores non-zvec_index tools entirely", async () => {
    const result = await call("~", "index", "bash");
    assert.equal(result, undefined);
  });

  test("blocks indexing $HOME (bare ~)", async () => {
    const result = (await call("~", undefined)) as { block: boolean; reason: string };
    assert.ok(result && result.block === true);
    assert.match(result.reason, /\[zvec-guard\]/);
    assert.match(result.reason, /zg index ~ --drop --yes/);
  });

  test("blocks indexing $HOME (absolute)", async () => {
    const result = (await call(homedir(), "index")) as { block: boolean };
    assert.ok(result && result.block === true);
  });

  test("blocks indexing $HOME on rebuild", async () => {
    const result = (await call("~/", "rebuild")) as { block: boolean };
    assert.ok(result && result.block === true);
  });

  test("blocks $HOME reached via a relative path from a home cwd", async () => {
    // cwd = $HOME, root "." → normalizeRoot resolves to $HOME → blocked.
    const result = (await call(".", "index", "zvec_index", homedir())) as { block: boolean };
    assert.ok(result && result.block === true);
  });

  test("allows dropping a home index (remediation path)", async () => {
    const result = await call("~", "drop");
    assert.equal(result, undefined);
  });

  test("allows a normal workspace root", async () => {
    assert.equal(await call(tmpdir(), "index"), undefined);
  });

  test("allows a workspace root that does not exist yet (realpath fallback)", async () => {
    assert.equal(await call(join(tmpdir(), "fresh-workspace-xyz"), "index"), undefined);
  });

  test("passes through when no root argument is present", async () => {
    const h = enabledHandler();
    const result = await h({ toolName: "zvec_index", input: {} }, {});
    assert.equal(result, undefined);
  });
});

describe("normalizeRoot", () => {
  const base = "/work";

  test("returns undefined for missing / non-string / blank roots", () => {
    assert.equal(normalizeRoot(undefined, base), undefined);
    assert.equal(normalizeRoot(42, base), undefined);
    assert.equal(normalizeRoot("   ", base), undefined);
  });

  test("expands bare ~ and ~/prefixed paths to the real home", () => {
    assert.equal(normalizeRoot("~", base), homedir());
    assert.equal(normalizeRoot("~/code", base), join(homedir(), "code"));
  });

  test("strips a leading @ (tool-path convention)", () => {
    assert.equal(normalizeRoot("@/abs/path", base), "/abs/path");
  });

  test("resolves relative roots against cwd when given, else process.cwd()", () => {
    assert.equal(normalizeRoot("sub/dir", "/work"), "/work/sub/dir");
    assert.equal(normalizeRoot("sub", undefined), join(process.cwd(), "sub"));
  });

  test("keeps absolute roots as-is", () => {
    assert.equal(normalizeRoot("/already/absolute", base), "/already/absolute");
  });
});

describe("bestRealPath", () => {
  test("realpaths existing paths", () => {
    // macOS tmpdir resolves through /private; the realpath must reflect that.
    assert.equal(bestRealPath(tmpdir()), realpathSync(tmpdir()));
  });

  test("falls back to resolve() for non-existent paths", () => {
    const missing = join(tmpdir(), "does-not-exist-zvec-guard-test");
    assert.ok(!existsSync(missing));
    assert.equal(bestRealPath(missing), resolve(missing));
  });
});

after(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));
