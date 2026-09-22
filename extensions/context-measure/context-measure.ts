// Context-measure for pi: a recording provider that captures what each
// composed request is made of — no network, no local server.
//
// Registers a `measure` provider with one static no-op model
// (`measure/measure-model`). Its `streamSimple` receives the fully
// assembled request (pi ≤0.86: `Context = { systemPrompt, messages, tools }`;
// pi ≥0.87 folds the prompt and tool declarations into the transcript's
// system messages — summarizeContext reads both) that pi would have
// serialized and sent over the wire, appends a one-line JSON
// assistant message. Nothing is ever fetched: this provider *is* the
// endpoint.
//
// This is the pi-native replacement for the synthetic-HTTP-server method
// (as used by SpecPi's measure-context.mjs): pi aliases
// `@earendil-works/pi-ai` imports in extensions to its own bundled copy
// (core/extensions/loader.ts), and the provider interface sits *after*
// system-prompt composition and tool registration but *before* wire
// serialization — the exact interception point the measurement needs.
//
// What it counts: pi's intermediate request representation, not the
// OpenAI/Anthropic wire envelope. Absolute numbers therefore differ from
// wire-format measurements (SpecPi's chart counts envelope JSON), but they
// are internally comparable across profiles and across time, which is what
// the context-budget ratchet and the dashboard need — and they avoid the
// transport variance (path text, dates, provider encoding) that makes
// wire counts drift.
//
// Zero request footprint: registers no tools and contributes no prompt
// text, so "stock pi + recorder" is a clean baseline and a live profile
// with the recorder installed measures what it would have sent anyway.
//
// Record file: `$PI_CONTEXT_MEASURE_OUT`, or `<configDir>/context-measure.jsonl`
// by default (live sessions can switch to `measure/measure-model` at any
// moment and the records land there; subagent children inherit the config
// dir, so child requests are captured too). One JSON object per line.
//
// Measurement driver: `npm run measure:context` (scripts/measure-context.mjs)
// measures stock pi vs. the work/personal/base agent dirs and writes the
// committed record `investigation/context-measurement.json`; CI
// (`npm run check:context-record`) fails when a PR changes profiles.jsonc,
// extensions/ or skills/ without updating that record.
//
// Toggled in /settings → Observability → Context measurement (id
// `context-measure`).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Tool,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || dirname(dirname(MODULE_DIR));

/** Where records land when the env var isn't set (live-session default). */
const DEFAULT_RECORD_PATH = join(CONFIG_DIR, "context-measure.jsonl");

/** Record output override, read per call so tests and scripts can point it. */
const OUT_ENV = "PI_CONTEXT_MEASURE_OUT";

export interface RequestRecord {
  /** ISO timestamp of the request. */
  at: string;
  /** 1-based request index within this pi process. */
  requestId: number;
  /** Model id the request was addressed to. */
  model: string;
  /** Characters of the composed system prompt (the "instructions" segment). */
  systemPromptChars: number;
  /** Number of messages in the conversation (user prompt excluded from the headline). */
  messageCount: number;
  /** Characters of the serialized messages. */
  messageChars: number;
  /** Number of tools offered in this request. */
  toolCount: number;
  /** Sorted tool names, for diffing at a glance. */
  toolNames: string[];
  /** Characters of each tool definition's JSON, keyed by tool name (sorted keys). */
  toolChars: Record<string, number>;
  /** Characters of the whole tool-definition array's JSON. */
  toolSchemaChars: number;
  /** systemPromptChars + toolSchemaChars: what the request costs before any work. */
  contextChars: number;
}

/** Sort an object's keys in place, so records diff stably. */
function sortedEntries(values: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(values).sort()) {
    sorted[key] = values[key];
  }
  return sorted;
}

/**
 * pi 0.87 folds the system prompt and tool declarations into the
 * transcript's system messages (`TranscriptContext`) instead of the
 * top-level Context fields pi ≤0.86 passed. Replay the system messages
 * (mirroring pi's getCurrentSystemMessage/getCurrentTools: content parts,
 * named sections patched by name, tools added/removed) so the record
 * stays comparable across pi versions.
 */
function replayTranscript(
  messages: readonly {
    role: string;
    content?: unknown;
    sections?: Record<string, string | null>;
    toolsAdded?: readonly Tool[];
    toolsRemoved?: readonly { name: string }[];
  }[],
): { systemPrompt: string; tools: Tool[] } {
  const texts: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, Tool>();
  const contentText = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => (block as { type?: string }).type === "text")
            .map((block) => (block as { text: string }).text)
            .join("\n")
        : "";
  for (const message of messages) {
    if (message?.role !== "system") continue;
    const text = contentText(message.content);
    if (text.length > 0) texts.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
  }
  return {
    systemPrompt: [...texts, ...sections.values()].join("\n\n"),
    tools: [...tools.values()],
  };
}

/** Summarize one composed request. Pure — the whole measurement in one function. */
export function summarizeContext(
  requestId: number,
  model: Model<Api>,
  context: Context,
): RequestRecord {
  // pi ≤0.86 passed the prompt/tools as top-level Context fields; pi ≥0.87
  // folds them into the transcript's system messages. Prefer the explicit
  // fields when present, fall back to the transcript replay.
  const replayed = replayTranscript(context.messages);
  const tools = context.tools ?? replayed.tools;
  const toolChars: Record<string, number> = {};
  for (const tool of tools) {
    const size = JSON.stringify(tool).length;
    toolChars[tool.name] = (toolChars[tool.name] ?? 0) + size;
  }
  const systemPrompt = context.systemPrompt ?? replayed.systemPrompt;
  const toolSchemaChars = JSON.stringify(tools).length;
  return {
    at: new Date().toISOString(),
    requestId,
    model: model.id,
    systemPromptChars: systemPrompt.length,
    messageCount: context.messages.length,
    messageChars: JSON.stringify(context.messages).length,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.name).sort(),
    toolChars: sortedEntries(toolChars),
    toolSchemaChars,
    contextChars: systemPrompt.length + toolSchemaChars,
  };
}

/** Resolve the record file: env override first, config-dir default second. */
export function recordPath(): string {
  return process.env[OUT_ENV] || DEFAULT_RECORD_PATH;
}

/** Append one record as a JSON line. Best-effort: a failure must not kill the reply. */
export function appendRecord(record: RequestRecord): void {
  try {
    const target = recordPath();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    process.stderr.write(`[context-measure] failed to write record: ${String(error)}\n`);
  }
}

/** The canned reply: a well-formed "ok" assistant message with zero usage. */
export function cannedAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: "measure",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Requests seen in this process, for the 1-based requestId. */
let requestsSeen = 0;

/**
 * The provider's streamSimple: record the composed request, answer "ok".
 * Follows the documented event protocol: start → text block → done.
 */
export function measureStream(
  model: Model<Api>,
  context: Context,
  _options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  requestsSeen += 1;
  appendRecord(summarizeContext(requestsSeen, model, context));

  const stream = createAssistantMessageEventStream();
  const output = cannedAssistantMessage(model);
  stream.push({ type: "start", partial: output });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: output });
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
  return stream;
}

/** The one registered model: enough context window to accept any profile's first call. */
export const MEASURE_MODEL = {
  id: "measure-model",
  name: "Context recorder (no-op)",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} as const;

export default function (pi: any): void {
  if (!isFeatureEnabled("context-measure")) return;

  pi.registerProvider("measure", {
    name: "Context recorder",
    // Never contacted: streamSimple answers locally. The literal key and
    // placeholder URL only satisfy provider-config validation (non-$
    // values stay literal; port 9 is discard, nothing is ever fetched).
    apiKey: "measure-local",
    baseUrl: "http://127.0.0.1:9/measure",
    // Stored on the model for metadata; unused because streamSimple
    // replaces wire serialization entirely.
    api: "openai-completions",
    models: [MEASURE_MODEL],
    streamSimple: measureStream,
  });
}
