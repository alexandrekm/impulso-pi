import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;
process.env.KB_GATEWAY_URL = "https://gw.example/";
process.env.KB_GATEWAY_KEY = "secret-key";

const mod = await import("./search_docs.ts");

// renderResult's collapsed branch calls keyHint, which needs pi's global
// TUI theme initialized (absent in headless test runs).
const { initTheme } = await import("@earendil-works/pi-coding-agent");
try {
  initTheme("dark", false);
} catch {
  // no-op: theme init is best-effort here
}

const theme = { fg: (_c: string, t: string) => `<${t}>` };

const chunk = (over: Record<string, unknown> = {}) => ({
  score: 0.9,
  content: { text: "chunk text" },
  location: { s3Location: { uri: "s3://doc" } },
  ...over,
});

describe("config helpers", () => {
  const savedUrl = process.env.KB_GATEWAY_URL;
  const savedKey = process.env.KB_GATEWAY_KEY;

  test("gateway url/key trimmed of whitespace and trailing slashes", () => {
    assert.equal(mod.gatewayBase(), "https://gw.example");
    process.env.KB_GATEWAY_URL = "  https://gw.example/// ";
    assert.equal(mod.gatewayBase(), "https://gw.example");
    delete process.env.KB_GATEWAY_URL;
    assert.equal(mod.gatewayBase(), undefined);
    process.env.KB_GATEWAY_KEY = "   ";
    assert.equal(mod.gatewayKey(), undefined);
  });

  test("numResults and minScore parse defensively", () => {
    process.env.KB_NUM_RESULTS = "5";
    assert.equal(mod.defaultNumResults(), 5);
    process.env.KB_NUM_RESULTS = "junk";
    assert.equal(mod.defaultNumResults(), 10);
    delete process.env.KB_NUM_RESULTS;
    assert.equal(mod.defaultNumResults(), 10);

    process.env.KB_MIN_SCORE = "0.25";
    assert.equal(mod.minScore(), 0.25);
    process.env.KB_MIN_SCORE = "-3";
    assert.equal(mod.minScore(), 0);
    delete process.env.KB_MIN_SCORE;
    assert.equal(mod.minScore(), 0);

    process.env.KB_GATEWAY_URL = savedUrl;
    process.env.KB_GATEWAY_KEY = savedKey;
  });

  test("sourceUri prefers s3, then web, then a placeholder", () => {
    assert.equal(mod.sourceUri({ location: { s3Location: { uri: "s3://x" } } }), "s3://x");
    assert.equal(mod.sourceUri({ location: { webLocation: { url: "https://y" } } }), "https://y");
    assert.equal(mod.sourceUri({}), "(unknown source)");
  });
});

describe("formatting helpers", () => {
  test("fmtScore and truncate", () => {
    assert.equal(mod.fmtScore(0.5), "0.50");
    assert.equal(mod.fmtScore(undefined), "?");
    assert.equal(mod.fmtScore(Number.NaN), "?");
    assert.equal(mod.truncate("  short  "), "short");
    const long = mod.truncate("x".repeat(2500));
    assert.equal(long.length, 2001);
    assert.ok(long.endsWith("…"));
  });

  test("formatChunks lists every chunk with score and source", () => {
    const out = mod.formatChunks([
      { score: 0.9, content: { text: "first chunk" }, location: { s3Location: { uri: "s3://a" } } },
      { content: {} }, // no score, no text, no location
    ]);
    assert.match(out, /Found 2 documentation chunks/);
    assert.match(out, /### 1\. \[score 0\.90\] s3:\/\/a/);
    assert.ok(out.includes("first chunk"));
    assert.match(out, /### 2\. \[score \?\] \(unknown source\)/);
    assert.ok(out.includes("(no text)"));

    const single = mod.formatChunks([{ content: { text: "only" } }]);
    assert.match(single, /Found 1 documentation chunk\b/);
  });

  test("fallback messages name the right escape hatch", () => {
    assert.match(mod.noKbResultsMessage("q"), /websearch/);
    assert.match(mod.kbNotConfiguredMessage(), /KB_GATEWAY_URL/);
  });
});

describe("gatewayRetrieve (mocked fetch)", () => {
  const realFetch = globalThis.fetch;

  test("posts the query and parses the response; reports progress", async () => {
    let body = "";
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      assert.ok(String(url).endsWith("/retrieve"));
      body = String(init!.body);
      headers = init!.headers as Record<string, string>;
      return new Response(JSON.stringify({ retrievalResults: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const updates: string[] = [];
      const resp = await mod.gatewayRetrieve("find docs", 5, undefined, (u) =>
        updates.push(u.content[0]!.text),
      );
      assert.equal(headers["x-api-key"], "secret-key");
      assert.ok(body.includes('"find docs"'));
      assert.ok(body.includes('"numberOfResults":5'));
      assert.deepEqual(updates, ['Searching Knowledge Base: "find docs"…']);
      assert.deepEqual(resp.retrievalResults, []);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("throws on non-2xx and on non-JSON bodies", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 502 })) as typeof fetch;
    await assert.rejects(() => mod.gatewayRetrieve("q", 5, undefined), /Gateway error 502/);

    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", { status: 200 })) as typeof fetch;
    await assert.rejects(() => mod.gatewayRetrieve("q", 5, undefined), /non-JSON/);
    globalThis.fetch = realFetch;
  });
});

describe("registered tool (execute + renderResult)", () => {
  const realFetch = globalThis.fetch;

  function registerTool() {
    let tool: Record<string, unknown> | undefined;
    mod.default({ registerTool: (t: Record<string, unknown>) => (tool = t) });
    assert.ok(tool);
    return tool!;
  }

  type ExecResult = {
    content: { type: string; text: string }[];
    details: Record<string, unknown>;
    isError?: boolean;
  };
  const execute = (tool: Record<string, unknown>) =>
    tool.execute as (id: string, p: { query: string; numResults?: number }) => Promise<ExecResult>;

  const text = (r: unknown) => (r as { text: string }).text;

  test("unconfigured gateway returns a hint, not an error", async () => {
    const tool = registerTool();
    const savedUrl = process.env.KB_GATEWAY_URL;
    const savedKey = process.env.KB_GATEWAY_KEY;
    delete process.env.KB_GATEWAY_URL;
    try {
      const r = await execute(tool)("tc", { query: "q" });
      assert.equal(r.details.configured, false);
      assert.ok(r.content[0]!.text.includes("websearch"));
    } finally {
      process.env.KB_GATEWAY_URL = savedUrl;
      process.env.KB_GATEWAY_KEY = savedKey;
    }
  });

  test("executes a successful retrieval and filters by minScore", async () => {
    const tool = registerTool();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ retrievalResults: [chunk(), chunk({ score: 0.1 }), chunk()] }),
        { status: 200 },
      )) as typeof fetch;
    try {
      process.env.KB_MIN_SCORE = "0.5";
      const r = await execute(tool)("tc", { query: "my query" });
      assert.equal(r.details.numReturned, 2);
      assert.equal(r.details.numRequested, 10); // default
      assert.equal(r.details.minScore, 0.5);
      assert.ok(r.content[0]!.text.includes("Found 2 documentation chunks"));

      // numResults is clamped into 1..50 (no crash, request still succeeds).
      const clamped = await execute(tool)("tc", { query: "q", numResults: 500 });
      assert.equal(clamped.details.numRequested, 50);
      delete process.env.KB_MIN_SCORE;
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("empty KB results steer to websearch; gateway errors surface as isError", async () => {
    const tool = registerTool();

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ retrievalResults: [] }), { status: 200 })) as typeof fetch;
    const empty = await execute(tool)("tc", { query: "nothing" });
    assert.equal(empty.details.numReturned, 0);
    assert.equal(empty.details.fallBackTo, "websearch");
    assert.ok(empty.content[0]!.text.includes("websearch"));

    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const failed = await execute(tool)("tc", { query: "q" });
    assert.equal(failed.isError, true);
    assert.match(failed.details.error as string, /Gateway error 500/);
    assert.ok(failed.content[0]!.text.includes("websearch"));
    globalThis.fetch = realFetch;
  });

  test("renderResult covers every display state", () => {
    const tool = registerTool();
    const render = tool.renderResult as (
      result: Record<string, unknown>,
      opts: { expanded: boolean; isPartial: boolean },
      theme: unknown,
      ctx: { isError?: boolean },
    ) => { text: string };

    assert.equal(
      text(render({}, { expanded: false, isPartial: true }, theme, {})),
      "<Searching Knowledge Base…>",
    );
    assert.match(
      text(
        render(
          { details: { configured: false } },
          { expanded: false, isPartial: false },
          theme,
          {},
        ),
      ),
      /not configured/,
    );
    assert.match(
      text(
        render({ details: {} }, { expanded: false, isPartial: false }, theme, { isError: true }),
      ),
      /search_docs failed: unknown error/,
    );
    assert.match(
      text(render({ details: { error: "x" } }, { expanded: false, isPartial: false }, theme, {})),
      /search_docs failed: x/,
    );
    assert.match(
      text(
        render(
          { details: { numReturned: 0, query: "qq" } },
          { expanded: false, isPartial: false },
          theme,
          {},
        ),
      ),
      /No KB results for "qq"/,
    );
    const collapsed = text(
      render(
        { details: { numReturned: 3, query: "qq" } },
        { expanded: false, isPartial: false },
        theme,
        {},
      ),
    );
    assert.match(collapsed, /✓ 3 doc chunks from KB/);
    assert.match(collapsed, /“qq”/);
    assert.match(collapsed, /to expand/);
    const single = text(
      render({ details: { numReturned: 1 } }, { expanded: false, isPartial: false }, theme, {}),
    );
    assert.match(single, /1 doc chunk\b/); // singular
    const expanded = text(
      render(
        { content: [{ text: "FULL BODY" }], details: { numReturned: 1 } },
        { expanded: true, isPartial: false },
        theme,
        {},
      ),
    );
    assert.ok(expanded.includes("FULL BODY"));
  });

  test("tool registration metadata is coherent", () => {
    const tool = registerTool();
    assert.equal(tool.name, "search_docs");
    assert.deepEqual((tool.parameters as { required: string[] }).required, ["query"]);
    assert.ok(String(tool.description).length > 0);
    assert.ok(Array.isArray(tool.promptGuidelines));
  });
});
