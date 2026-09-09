import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;

const {
  scanErrors,
  textPreview,
  snippetAround,
  enclosingTool,
  sessionSubdir,
  slugify,
  sanitizeModel,
  default: factory,
} = await import("./payload-exporter.ts");

const PAYLOADS = join(CONFIG_DIR, "payloads");

describe("pure helpers", () => {
  test("sanitizeModel replaces path separators", () => {
    assert.equal(sanitizeModel("litellm/gpt-4o:latest"), "litellm-gpt-4o-latest");
  });

  test("slugify is filesystem-safe and bounded", () => {
    assert.equal(slugify("My Repo (work)!!"), "my-repo-work");
    assert.equal(slugify("---"), "session");
    assert.equal(slugify("a".repeat(50)).length, 24);
  });

  test("sessionSubdir: date-prefixed, id truncated; undefined without id", () => {
    const sub = sessionSubdir("01234567-89ab-cdef", "My Repo");
    assert.match(sub!, /^\d{4}-\d{2}-\d{2}[/\\]01234567--my-repo$/);
    assert.equal(sessionSubdir(undefined, "x"), undefined);
    const noLabel = sessionSubdir("abcdefghijklmnop", undefined);
    assert.equal(noLabel, join(new Date().toISOString().slice(0, 10), "abcdefghijkl"));
  });

  test("snippetAround collapses whitespace around the match", () => {
    const s = "x".repeat(100) + "  FIND ME  " + "y".repeat(100);
    const snip = snippetAround(s, 102, 8);
    assert.ok(snip.includes("FIND ME"));
    assert.ok(!snip.includes("\n"));
    assert.ok(!/\s{2,}/.test(snip)); // all whitespace collapsed
  });

  test("enclosingTool finds the nearest tool fields before the hit", () => {
    const s = `"toolName": "bash", "toolCallId": "t1"\n{}\n"toolName": "read", "toolCallId": "t2"\n"isError": true`;
    const idx = s.indexOf('"isError"');
    assert.deepEqual(enclosingTool(s, idx), { toolName: "read", toolCallId: "t2" });
  });

  test("textPreview: first ~500 chars of text blocks, '' otherwise", () => {
    assert.equal(textPreview(undefined), "");
    assert.equal(textPreview("nope"), "");
    assert.equal(
      textPreview([
        { type: "text", text: "hello " },
        { type: "image", src: "x" },
        { type: "text", text: "world" },
      ]),
      "hello \nworld",
    ); // join(\n) keeps the trailing space inside the first block
    const long = textPreview([{ type: "text", text: "a".repeat(600) }]);
    assert.equal(long.length, 501); // 500 + ellipsis
    assert.ok(long.endsWith("…"));
  });

  test("scanErrors flags each pattern kind and attaches enclosing tool for isError", () => {
    const payload = JSON.stringify(
      {
        tools: [
          { toolName: "bash", toolCallId: "tc-1", isError: true },
          { toolName: "read", toolCallId: "tc-2", isError: false },
        ],
        response: { stopReason: "error", errorMessage: "boom happened" },
        text: "Traceback (most recent call last)\nValueError: bad value\nCommand failed: make",
        js: "TypeError: also bad",
      },
      null,
      2,
    );
    const matches = scanErrors(payload);
    const byPattern = (n: string) => matches.filter((m) => m.pattern === n);

    assert.equal(byPattern("isError").length, 1);
    assert.equal(byPattern("isError")[0]!.toolName, "bash");
    assert.equal(byPattern("isError")[0]!.toolCallId, "tc-1");

    assert.equal(byPattern("stopReason:error").length, 1);
    assert.equal(byPattern("errorMessage").length, 1);
    assert.ok(byPattern("errorMessage")[0]!.snippet.includes("boom happened"));

    assert.equal(byPattern("traceback").length, 1);
    // python-error is generic ([A-Z]\w*Error) so it also catches TypeError;
    // js-error is the explicit JS-class pattern.
    assert.equal(byPattern("python-error").length, 2);
    assert.equal(byPattern("js-error").length, 1);
    assert.equal(byPattern("bash-fail").length, 1);

    assert.deepEqual(scanErrors("nothing wrong here"), []);
  });
});

describe("factory", () => {
  function resetState() {
    rmSync(PAYLOADS, { recursive: true, force: true });
  }

  function makePi() {
    resetState();
    const handlers = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const commands = new Map<
      string,
      {
        getArgumentCompletions: (p: string) => unknown;
        handler: (args: string, ctx: never) => Promise<void>;
      }
    >();
    factory({
      on: (n: string, h: (e: unknown, c?: unknown) => unknown) => handlers.set(n, h),
      registerCommand: (n: string, d: never) => commands.set(n, d),
    } as never);
    return { handlers, commands };
  }

  const ui = () => {
    const calls: { msg: string; level: string }[] = [];
    return { calls, ui: { notify: (msg: string, level: string) => calls.push({ msg, level }) } };
  };

  test("session_start derives a session dir from the session manager", async () => {
    const { handlers, commands } = makePi();
    await handlers.get("session_start")!(
      {},
      {
        sessionManager: { getSessionId: () => "sess-123", getSessionName: () => "My Repo" },
        cwd: "/x",
      },
    );
    // Enable exporting on the SAME instance and dump a request: it lands in
    // the session dir (a second factory instance would have its own state).
    const { calls, ui: u } = ui();
    await commands.get("payload-exporter")!.handler("on", { ui: u } as never);
    assert.match(calls.at(-1)!.msg, /Payload exporting is on/);

    await handlers.get("turn_start")!({ turnIndex: 3 });
    await handlers.get("before_provider_request")!(
      { payload: { messages: [] } },
      { model: { id: "m/x", provider: "p" } },
    );
    const files = readdirSync(
      join(PAYLOADS, new Date().toISOString().slice(0, 10), "sess-123--my-repo"),
    );
    assert.equal(files.length, 1);
    assert.match(files[0]!, /--turn-3--m-x\.json$/);
    const written = JSON.parse(
      readFileSync(
        join(PAYLOADS, new Date().toISOString().slice(0, 10), "sess-123--my-repo", files[0]!),
        "utf8",
      ),
    );
    assert.equal(written.turnIndex, 3);
    assert.equal(written.model.id, "m/x");
    assert.deepEqual(written.payload.messages, []);
  });

  test("message_end pairs the response summary to the oldest request", async () => {
    const { handlers, commands } = makePi();
    const { ui: u } = ui();
    await commands.get("payload-exporter")!.handler("on", { ui: u } as never);
    await handlers.get("turn_start")!({ turnIndex: 0 });
    await handlers.get("before_provider_request")!({ payload: { a: 1 } }, { model: { id: "m" } });
    await handlers.get("before_provider_request")!({ payload: { b: 2 } }, { model: { id: "m" } });

    const dir = PAYLOADS; // no session_start → flat dir
    const before = readdirSync(dir).filter((f) => f.startsWith("payload--"));
    assert.equal(before.length, 2);

    await handlers.get("message_end")!({
      message: {
        role: "assistant",
        stopReason: "end_turn",
        model: "m",
        usage: { totalTokens: 5 },
        content: [{ type: "text", text: "hi there" }],
      },
    });
    // Exactly one file got a response summary; it's the older (first) one.
    const withResponse = readdirSync(dir)
      .filter((f) => f.startsWith("payload--"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
      .filter((j) => j.response);
    assert.equal(withResponse.length, 1);
    assert.equal(withResponse[0].payload.a, 1); // first request paired
    assert.ok(withResponse[0].response.textPreview.includes("hi there"));

    // A second response with no pending request is a no-op.
    await handlers.get("message_end")!({
      message: { role: "assistant", stopReason: "x", content: [] },
    });
  });

  test("message_end ignores non-assistant messages and missing queues", async () => {
    const { handlers } = makePi();
    await handlers.get("message_end")!({ message: { role: "user" } });
    await handlers.get("message_end")!({});
    await handlers.get("message_end")!({ message: { role: "assistant" } }); // no pending request
  });

  test("error signals are logged to errors.jsonl", async () => {
    const { handlers, commands } = makePi();
    const { ui: u } = ui();
    await commands.get("payload-exporter")!.handler("on", { ui: u } as never);
    await handlers.get("turn_start")!({ turnIndex: 7 });
    // toolName/toolCallId must precede isError: enclosingTool scans backward
    // through the serialized JSON to find the enclosing tool.
    await handlers.get("before_provider_request")!(
      { payload: { history: [{ toolName: "bash", toolCallId: "t9", isError: true }] } },
      { model: { id: "m" } },
    );
    assert.ok(existsSync(join(PAYLOADS, "errors.jsonl")));
    const lines = readFileSync(join(PAYLOADS, "errors.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(lines.at(-1)!);
    assert.equal(entry.source, "request");
    assert.equal(entry.turnIndex, 7);
    assert.equal(entry.matches[0].toolName, "bash");
  });

  test("command handler: toggle/off/status/invalid + completions", async () => {
    const { commands } = makePi();
    const cmd = commands.get("payload-exporter")!;
    const { calls, ui: u } = ui();

    await cmd.handler("", { ui: u } as never); // default off (fresh dir) → toggle → on
    assert.match(calls.at(-1)!.msg, /is on/);
    await cmd.handler("off", { ui: u } as never);
    assert.match(calls.at(-1)!.msg, /is off/);
    await cmd.handler("status", { ui: u } as never);
    assert.match(calls.at(-1)!.msg, /is off \(/);
    await cmd.handler("bogus", { ui: u } as never);
    assert.match(calls.at(-1)!.msg, /Usage: \/payload-exporter/);

    const all = cmd.getArgumentCompletions("") as { value: string }[];
    assert.deepEqual(all.map((o) => o.value).sort(), ["off", "on", "status", "toggle"]);
    assert.equal(cmd.getArgumentCompletions("zz"), null);
  });

  test("disabled exporter writes nothing", async () => {
    const { handlers } = makePi();
    const before = existsSync(PAYLOADS) ? readdirSync(PAYLOADS).length : 0;
    await handlers.get("turn_start")!({ turnIndex: 1 });
    await handlers.get("before_provider_request")!({ payload: {} }, { model: { id: "m" } });
    const after = existsSync(PAYLOADS) ? readdirSync(PAYLOADS).length : 0;
    assert.equal(after, before);
  });
});
