import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendRecord,
  measureStream,
  maybeDumpPrompt,
  recordPath,
  summarizeContext,
} from "./context-measure.ts";

const fakeModel = {
  id: "measure-model",
  api: "openai-completions",
  provider: "measure",
} as any;

function fakeContext(overrides: Record<string, unknown> = {}) {
  return {
    systemPrompt: "system instructions",
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with ok." }] }],
    tools: [
      { name: "read", description: "Read a file", parameters: { type: "object" } },
      { name: "bash", description: "Run a command", parameters: { type: "object" } },
    ],
    ...overrides,
  } as any;
}

test("summarizeContext counts the composed request", () => {
  const record = summarizeContext(1, fakeModel, fakeContext());

  assert.equal(record.requestId, 1);
  assert.equal(record.model, "measure-model");
  assert.equal(record.systemPromptChars, "system instructions".length);
  assert.equal(record.toolCount, 2);
  assert.deepEqual(record.toolNames, ["bash", "read"], "tool names are sorted");
  assert.equal(record.messageCount, 1);
  assert.equal(record.messageChars, JSON.stringify(fakeContext().messages).length);
  assert.equal(
    record.toolSchemaChars,
    JSON.stringify(fakeContext().tools).length,
    "tool schema chars match the serialized array",
  );
  assert.equal(record.contextChars, record.systemPromptChars + record.toolSchemaChars);

  // v2 stability hashes: same input → same hash, matching a plain sha256
  // of the serialized strings.
  const expectedPrompt = createHash("sha256").update("system instructions").digest("hex");
  assert.equal(record.systemPromptSha256, expectedPrompt);
  assert.equal(
    record.toolsSha256,
    createHash("sha256").update(JSON.stringify(fakeContext().tools)).digest("hex"),
  );
  const again = summarizeContext(1, fakeModel, fakeContext());
  assert.equal(again.systemPromptSha256, record.systemPromptSha256);
  assert.equal(again.toolsSha256, record.toolsSha256);
});

test("summarizeContext attributes per-tool chars and sorts the map keys", () => {
  const record = summarizeContext(2, fakeModel, fakeContext());
  const tools = fakeContext().tools;

  assert.equal(record.toolChars.bash, JSON.stringify(tools[1]).length);
  assert.equal(record.toolChars.read, JSON.stringify(tools[0]).length);
  assert.deepEqual(Object.keys(record.toolChars), ["bash", "read"], "map keys are sorted");
});

test("summarizeContext handles a request without tools or system prompt", () => {
  const record = summarizeContext(
    3,
    fakeModel,
    fakeContext({ tools: undefined, systemPrompt: undefined }),
  );

  assert.equal(record.toolCount, 0);
  assert.deepEqual(record.toolNames, []);
  assert.equal(record.toolSchemaChars, JSON.stringify([]).length);
  assert.equal(record.systemPromptChars, 0);
  assert.equal(record.contextChars, record.toolSchemaChars);
});

test("summarizeContext replays pi ≥0.87 TranscriptContext system messages", () => {
  const context = fakeContext({
    systemPrompt: undefined,
    tools: undefined,
    messages: [
      {
        role: "system",
        content: "folded system instructions",
        toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
        timestamp: 0,
      },
      {
        role: "system",
        content: "",
        toolsAdded: [
          { name: "bash", description: "Run a command", parameters: { type: "object" } },
        ],
        toolsRemoved: [{ name: "read" }],
        timestamp: 1,
      },
      { role: "user", content: [{ type: "text", text: "Reply with ok." }] },
    ],
  });

  const record = summarizeContext(4, fakeModel, context);
  assert.equal(record.systemPromptChars, "folded system instructions".length);
  assert.equal(record.toolCount, 1);
  assert.deepEqual(record.toolNames, ["bash"], "toolsRemoved is replayed");
});

test("measureStream replies with the event protocol and records the request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "context-measure-test-"));
  const out = join(dir, "records.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.PI_CONTEXT_MEASURE_OUT = out;

  const stream = measureStream(fakeModel, fakeContext());
  const events: Array<{ type: string }> = [];
  for await (const event of stream) {
    events.push(event as { type: string });
  }

  const types = events.map((event) => event.type);
  assert.deepEqual(types, ["start", "text_start", "text_delta", "text_end", "done"]);
  const done = events[events.length - 1] as any;
  assert.equal(done.reason, "stop");
  assert.equal(done.message.content[0].text, "ok");
  assert.equal(done.message.provider, "measure");
  assert.equal(done.message.usage.totalTokens, 0);

  // The record landed in the output file as one JSON line.
  const lines = readFileSync(out, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.toolCount, 2);
  assert.equal(record.model, "measure-model");
  assert.ok(record.at, "record has a timestamp");

  delete process.env.PI_CONTEXT_MEASURE_OUT;
  assert.notEqual(recordPath(), out, "env override is read per call");
});

test("appendRecord is best-effort: a bad path warns instead of throwing", () => {
  process.env.PI_CONTEXT_MEASURE_OUT = "/definitely/not/a/writable/path/records.jsonl";
  const before = process.stderr.write.bind(process.stderr);
  let warned = "";
  process.stderr.write = ((chunk: any) => {
    warned += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  assert.doesNotThrow(() => appendRecord(summarizeContext(1, fakeModel, fakeContext())));

  process.stderr.write = before;
  delete process.env.PI_CONTEXT_MEASURE_OUT;
  assert.match(warned, /\[context-measure\] failed to write record/);
});

test("hashes change when the prompt or tool list changes", () => {
  const base = summarizeContext(1, fakeModel, fakeContext());
  const otherPrompt = summarizeContext(
    2,
    fakeModel,
    fakeContext({ systemPrompt: "other instructions" }),
  );
  const otherTools = summarizeContext(
    3,
    fakeModel,
    fakeContext({
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    }),
  );

  assert.notEqual(
    otherPrompt.systemPromptSha256,
    base.systemPromptSha256,
    "prompt hash tracks the prompt text",
  );
  assert.equal(otherPrompt.toolsSha256, base.toolsSha256, "tool hash independent of the prompt");
  assert.equal(
    otherTools.systemPromptSha256,
    base.systemPromptSha256,
    "prompt hash independent of the tools",
  );
  assert.notEqual(otherTools.toolsSha256, base.toolsSha256, "tool hash tracks the tool array");
});

test("maybeDumpPrompt is a no-op without PI_CONTEXT_MEASURE_DEBUG", () => {
  const dir = mkdtempSync(join(tmpdir(), "context-measure-test-"));
  const dump = join(dir, "context-measure-prompt.txt");
  process.env.PI_CONTEXT_MEASURE_OUT = join(dir, "records.jsonl");
  delete process.env.PI_CONTEXT_MEASURE_DEBUG;

  maybeDumpPrompt(summarizeContext(1, fakeModel, fakeContext()), "system instructions");
  assert.equal(existsSync(dump), false, "no dump without the debug env");
  delete process.env.PI_CONTEXT_MEASURE_OUT;
});

test("maybeDumpPrompt appends a headered prompt block when debugging", () => {
  const dir = mkdtempSync(join(tmpdir(), "context-measure-test-"));
  const dump = join(dir, "context-measure-prompt.txt");
  process.env.PI_CONTEXT_MEASURE_OUT = join(dir, "records.jsonl");
  process.env.PI_CONTEXT_MEASURE_DEBUG = "1";

  const record = summarizeContext(1, fakeModel, fakeContext());
  maybeDumpPrompt(record, "system instructions");
  maybeDumpPrompt({ ...record, requestId: 2 }, "system instructions");

  const text = readFileSync(dump, "utf8");
  assert.match(
    text,
    /# ==== request 1 \u00b7 \S+ \u00b7 measure-model \u00b7 prompt sha256:\w+ ====/,
  );
  assert.match(text, /# ==== request 2 /);
  assert.ok(text.includes("system instructions"), "the full prompt text lands in the dump");
  assert.equal(text.split("# ====").length - 1, 2, "two blocks appended, not overwritten");

  delete process.env.PI_CONTEXT_MEASURE_DEBUG;
  delete process.env.PI_CONTEXT_MEASURE_OUT;
});

test("measureStream dumps the prompt only when debugging is on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-measure-test-"));
  process.env.PI_CONTEXT_MEASURE_OUT = join(dir, "records.jsonl");
  process.env.PI_CONTEXT_MEASURE_DEBUG = "1";
  try {
    const events: Array<{ type: string }> = [];
    for await (const event of measureStream(fakeModel, fakeContext())) {
      events.push(event as { type: string });
    }
    assert.ok(events.length > 0, "the event stream was drained");
    const dumped = readFileSync(join(dir, "context-measure-prompt.txt"), "utf8");
    assert.ok(dumped.includes("system instructions"), "streamSimple dumps the composed prompt");
  } finally {
    delete process.env.PI_CONTEXT_MEASURE_DEBUG;
    delete process.env.PI_CONTEXT_MEASURE_OUT;
  }
});
