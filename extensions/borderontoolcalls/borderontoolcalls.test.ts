import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

// Feature flag manifest is resolved at import time — fresh temp dir.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;

const { installPatch, default: factory } = await import("./borderontoolcalls.ts");

const theme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as never;

// ── patch lifecycle ────────────────────────────────────────────────────────
// The tests stub ToolExecutionComponent.prototype.render with a fake base so
// the patched render is exercised against controlled output; the real render
// is restored afterwards.
const BASE_KEY = "__impulsoBorderToolCallBase__";
type RenderFn = ((width: number) => string[]) & { [k: string]: unknown };

describe("installPatch", () => {
  test("enabled: wraps the base, marked for unwrap; disabled: restores base", () => {
    const proto = ToolExecutionComponent.prototype as unknown as { render: RenderFn };
    const original = proto.render;
    const fakeBase = ((_w: number) => ["row"]) as RenderFn;
    proto.render = fakeBase;
    try {
      installPatch(true, { theme } as never);
      assert.notEqual(proto.render, fakeBase);
      assert.equal(proto.render[BASE_KEY], fakeBase);

      // Double install never double-wraps.
      installPatch(true, { theme } as never);
      assert.equal(proto.render[BASE_KEY], fakeBase);

      // Disabled → base restored (patch removed).
      installPatch(false, { theme } as never);
      assert.equal(proto.render, fakeBase);
    } finally {
      proto.render = original;
    }
  });

  test("factory: session_start patches only in tui mode when the feature is on", async () => {
    const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
    factory({
      on: (n: string, h: (e: unknown, c: unknown) => void) => handlers.set(n, h),
    } as never);
    const h = handlers.get("session_start")!;

    const proto = ToolExecutionComponent.prototype as unknown as { render: RenderFn };
    const original = proto.render;
    const fakeBase = ((_w: number) => ["row"]) as RenderFn;
    proto.render = fakeBase;
    try {
      h({}, { mode: "rpc", ui: { theme } }); // not tui → untouched
      assert.equal(proto.render, fakeBase);

      h({}, { mode: "tui", ui: { theme } }); // feature on (fresh manifest) → patched
      assert.notEqual(proto.render, fakeBase);
    } finally {
      proto.render = original;
    }
  });
});

// ── patched render behavior ───────────────────────────────────────────────

describe("patchedToolCallRender", () => {
  const proto = () => ToolExecutionComponent.prototype as unknown as { render: RenderFn };
  const withBase = (lines: (w: number) => string[], body: (render: RenderFn) => void) => {
    const original = proto().render;
    proto().render = ((w: number) => lines(w)) as RenderFn;
    try {
      installPatch(true, { theme } as never);
      body(proto().render);
    } finally {
      proto().render = original;
    }
  };

  test("frames content with rails and a labeled top border", () => {
    withBase(
      () => ["", "  padded  ", ""],
      (render) => {
        const out = render.call({ toolName: "bash" }, 30);
        assert.match(out[0]!, /^┌── bash ─+┐$/);
        assert.match(out[1]!, /^│  padded +│$/);
        assert.match(out.at(-1)!, /^└─+┘$/);
        assert.equal(out.length, 3);
      },
    );
  });

  test("narrow width, missing theme, empty and blank-only output fall back to base", () => {
    const narrow = ["kept"];
    withBase(
      () => narrow,
      (render) => {
        // width < MIN_BOX_WIDTH → base output untouched (same array identity).
        assert.equal(render.call({ toolName: "x" }, 4), narrow);
      },
    );
    // missing theme
    const original = proto().render;
    const noThemeBase = ((_w: number) => ["a"]) as RenderFn;
    proto().render = noThemeBase;
    try {
      installPatch(true, { theme: undefined } as never);
      assert.deepEqual((proto().render as RenderFn).call({ toolName: "x" }, 30), ["a"]);
    } finally {
      proto().render = original;
    }
    withBase(
      () => [],
      (render) => {
        assert.deepEqual(render.call({ toolName: "x" }, 30), []); // empty output
      },
    );
    withBase(
      () => ["", "   ", ""],
      (render) => {
        assert.deepEqual(render.call({ toolName: "x" }, 30), ["", "   ", ""]); // all blank
      },
    );
  });

  test("short rows are padded so the right rail lines up; long labels degrade", () => {
    withBase(
      () => ["short"],
      (render) => {
        const out = render.call({ toolName: "bash" }, 12);
        assert.match(out[1]!, /^│short +│$/);
        assert.equal(out[1]!.length, 12);
      },
    );
    withBase(
      () => ["x"],
      (render) => {
        // Label wider than the box → plain unlabeled border.
        const out = render.call({ toolName: "a-very-long-tool-name" }, 10);
        assert.equal(out[0], `┌${"─".repeat(8)}┐`);
      },
    );
  });
});

rmSync(CONFIG_DIR, { recursive: true, force: true });
