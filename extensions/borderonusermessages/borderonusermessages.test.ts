import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;

const { installPatch, default: factory } = await import("./borderonusermessages.ts");

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const BASE_KEY = "__impulsoBorderUserMsgBase__";
const OSC_A = "\x1b]133;A\x07";
const OSC_BC = "\x1b]133;B\x07\x1b]133;C\x07";
type RenderFn = ((width: number) => string[]) & { [k: string]: unknown };

const proto = () => UserMessageComponent.prototype as unknown as { render: RenderFn };

function withBase(lines: string[], body: (render: RenderFn) => void) {
  const original = proto().render;
  const fakeBase = ((_w: number) => lines) as RenderFn;
  proto().render = fakeBase;
  try {
    installPatch(true, { theme } as never);
    body(proto().render);
  } finally {
    proto().render = original;
  }
}

describe("installPatch", () => {
  test("enabled wraps and marks; double install never double-wraps; disabled restores", () => {
    const original = proto().render;
    const fakeBase = ((_w: number) => ["row"]) as RenderFn;
    proto().render = fakeBase;
    try {
      installPatch(true, { theme } as never);
      assert.notEqual(proto().render, fakeBase);
      assert.equal(proto().render[BASE_KEY], fakeBase);

      installPatch(true, { theme } as never);
      assert.equal(proto().render[BASE_KEY], fakeBase);

      installPatch(false, { theme } as never);
      assert.equal(proto().render, fakeBase);
    } finally {
      proto().render = original;
    }
  });

  test("factory: only tui mode installs the patch", () => {
    const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
    factory({
      on: (n: string, h: (e: unknown, c: unknown) => void) => handlers.set(n, h),
    } as never);
    const h = handlers.get("session_start")!;
    const original = proto().render;
    const fakeBase = ((_w: number) => ["row"]) as RenderFn;
    proto().render = fakeBase;
    try {
      h({}, { mode: "print", ui: { theme } });
      assert.equal(proto().render, fakeBase);
      h({}, { mode: "tui", ui: { theme } });
      assert.notEqual(proto().render, fakeBase);
    } finally {
      proto().render = original;
    }
  });
});

describe("patchedUserMessageRender", () => {
  test("frames the message with a ' You ' label and re-attaches OSC 133 markers", () => {
    withBase(["", " hello ", ""], (render) => {
      const out = render.call({}, 24);
      assert.ok(out[0]!.startsWith(OSC_A));
      assert.ok(out[0]!.includes("┌── You ─"));
      assert.match(out[1]!, /^│ hello +│$/);
      const last = out.at(-1)!;
      assert.ok(last.startsWith(OSC_BC));
      assert.match(last, /└─+┘$/);
      assert.equal(out.length, 3);
    });
  });

  test("OSC markers inside base lines are moved off the rails", () => {
    const marked = `\x1b]133;A\x07text`;
    withBase([marked], (render) => {
      const out = render.call({}, 20);
      // The marker was stripped from the content line (zero-width anyway).
      assert.equal(out[1]!, "│text│"); // no padding in the user-message variant
      assert.ok(!out[1]!.includes("133;A"));
    });
  });

  test("narrow width, no theme, empty and blank-only output fall back", () => {
    const original = proto().render;
    const noThemeBase = ((_w: number) => ["a"]) as RenderFn;
    proto().render = noThemeBase;
    try {
      installPatch(true, { theme: undefined } as never);
      assert.deepEqual((proto().render as RenderFn).call({}, 30), ["a"]);
    } finally {
      proto().render = original;
    }

    const narrow = ["kept"];
    withBase(narrow, (render) => {
      assert.equal(render.call({}, 4), narrow); // width < MIN_BOX_WIDTH
    });
    withBase([], (render) => {
      assert.deepEqual(render.call({}, 30), []);
    });
    withBase(["", "  ", ""], (render) => {
      assert.deepEqual(render.call({}, 30), ["", "  ", ""]);
    });
  });

  test("narrow box degrades to an unlabeled border", () => {
    withBase(["x"], (render) => {
      const out = render.call({}, 8); // inner 6 < label(5)+2 → unlabeled
      assert.equal(out[0]!.replace(OSC_A, ""), `┌${"─".repeat(6)}┐`);
    });
  });
});
