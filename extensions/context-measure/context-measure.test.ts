import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendRecord, measureStream, recordPath, summarizeContext } from "./context-measure.ts";

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
