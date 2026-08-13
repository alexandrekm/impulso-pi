// Payload Exporter Extension
//
// Saves every LLM provider request payload to `<configDir>/payloads/` so you
// can inspect how pi constructs system prompts, messages, tool definitions,
// etc. `<configDir>` is the active pi config directory — with pi-profiles
// (ppi) that's the per-profile dir (~/.pi/profiles/<name>/), or ~/.pi/agent
// for `--base`. Each profile thus gets its own payload dump.
//
// Each request is written immediately (crash-safe) as
//   payload--YYYY-MM-DD--HHmmss.mmm--seq-NNNN--turn-{n}--{model}.json
// The millisecond + sequence-counter suffix guarantees uniqueness when
// multiple requests fire in the same second (parallel/multi-agent bursts);
// without it, same-second same-model requests would overwrite each other.
// Once the assistant response arrives, the SAME file is rewritten with a
// `response` section: token usage (input/output/cache/reasoning/total + cost),
// stop reason, response model/id, and a short text preview. Requests that get
// no response (error/abort) remain request-only — nothing is lost.
//
// In addition, the payload (request) and the response are scanned with a set
// of regexes for error signals — tool results with isError:true, assistant
// stopReason "error", error messages, Python/JS error prefixes, tracebacks,
// bash failures — and any hits are appended as one JSON line per request to
//   <configDir>/payloads/errors.jsonl
// so you can later investigate which tool calls failed. Each line records the
// matching pattern, a context snippet, and (for tool results) the enclosing
// toolName + toolCallId.
//
// Use `/payload-exporter on|off|toggle|status` to control exporting.
//
// Exporting defaults to OFF. The on/off choice is persisted in
// `<configDir>/payloads/.exporter-state.json`, so toggling it on survives
// session restarts (per profile).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type AnyRecord = Record<string, unknown>;

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILENAME = ".exporter-state.json";
const ERRORS_FILENAME = "errors.jsonl";

/** The active pi config dir: ppi sets PI_CODING_AGENT_DIR per profile; the
 * parent of this extension's own folder is the same dir for a normally-placed
 * extension (e.g. running --base without ppi). Mirrors print-config-dir.ts. */
function configDir(): string {
  return process.env.PI_CODING_AGENT_DIR || dirname(EXT_DIR);
}

function payloadDir(): string {
  return join(configDir(), "payloads");
}

function statePath(): string {
  return join(payloadDir(), STATE_FILENAME);
}

function errorsPath(): string {
  return join(payloadDir(), ERRORS_FILENAME);
}

/** Read persisted enabled flag. Missing/unreadable file => false (default off). */
function readEnabled(): boolean {
  try {
    const raw = readFileSync(statePath(), "utf8");
    const data = JSON.parse(raw) as { enabled?: unknown };
    return data.enabled === true;
  } catch {
    return false;
  }
}

/** Persist enabled flag so it survives restarts. Best-effort. */
function writeEnabled(enabled: boolean): void {
  try {
    mkdirSync(payloadDir(), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ enabled }, null, 2) + "\n", "utf8");
  } catch {
    // Non-fatal: in-memory flag still works for the session.
  }
}

function updateStatus(ui: any, enabled: boolean): void {
  ui.setStatus("payload-exporter", `payload export: ${enabled ? "on" : "off"}`);
}

function sanitizeModel(id: string): string {
  return id.replace(/[/:]/g, "-");
}

// ---- error scanning ------------------------------------------------------

interface ErrorMatch {
  pattern: string;
  toolName?: string;
  toolCallId?: string;
  snippet: string;
}

// Regexes run against the pretty-printed JSON (2-space indent). Tool-result
// objects serialize with toolCallId/toolName BEFORE isError, so a backward
// scan from an isError hit finds the enclosing tool.
const ERROR_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "isError", re: /"isError":\s*true/g },
  { name: "stopReason:error", re: /"stopReason":\s*"error"/g },
  { name: "errorMessage", re: /"errorMessage":\s*"((?:\\.|[^"\\])+)"/g },
  { name: "traceback", re: /Traceback \(most recent call last\)/g },
  { name: "python-error", re: /\b[A-Z]\w*Error:\s[^\n"]{0,120}/g },
  {
    name: "js-error",
    re: /\b(?:TypeError|ReferenceError|SyntaxError|EvalError|RangeError|URIError):\s[^\n"]{0,120}/g,
  },
  {
    name: "bash-fail",
    re: /(?:Command failed:|exited with (?:code|status) \d+|non-zero exit(?: code)?)/g,
  },
];

/** Nearest `toolName`/`toolCallId` preceding `idx` in `s` (within ~2KB). */
function enclosingTool(s: string, idx: number): { toolName?: string; toolCallId?: string } {
  const back = s.slice(Math.max(0, idx - 2000), idx);
  const toolName = [...back.matchAll(/"toolName":\s*"([^"]+)"/g)].pop()?.[1];
  const toolCallId = [...back.matchAll(/"toolCallId":\s*"([^"]+)"/g)].pop()?.[1];
  return { toolName, toolCallId };
}

/** A compact context window around a match, whitespace-collapsed. */
function snippetAround(s: string, idx: number, len: number, radius = 80): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(s.length, idx + len + radius);
  return s.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Scan serialized JSON for error signals. */
function scanErrors(s: string): ErrorMatch[] {
  const matches: ErrorMatch[] = [];
  for (const { name, re } of ERROR_PATTERNS) {
    for (const m of s.matchAll(re)) {
      const idx = m.index ?? 0;
      const len = m[0].length;
      const { toolName, toolCallId } = name === "isError" ? enclosingTool(s, idx) : {};
      matches.push({
        pattern: name,
        toolName,
        toolCallId,
        snippet: snippetAround(s, idx, len),
      });
    }
  }
  return matches;
}

/** Append one JSON line per request with error hits to errors.jsonl. */
function appendErrorLog(entry: AnyRecord): void {
  try {
    mkdirSync(payloadDir(), { recursive: true });
    appendFileSync(errorsPath(), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Non-fatal: payload files are the primary record.
  }
}

// ---- response summary ----------------------------------------------------

/** Extract a short preview of the assistant's text content (first ~500 chars). */
function textPreview(content: any): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 500 ? `${joined.slice(0, 500)}…` : joined;
}

/** Build the response summary appended to a payload file once it arrives. */
function responseSummary(message: any): AnyRecord {
  const usage = message.usage;
  const summary: AnyRecord = {
    stopReason: message.stopReason,
    model: message.model,
    responseModel: message.responseModel,
    responseId: message.responseId,
    provider: message.provider,
    timestamp: message.timestamp,
    textPreview: textPreview(message.content),
  };
  if (usage) {
    summary.usage = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cacheWrite1h: usage.cacheWrite1h,
      reasoning: usage.reasoning,
      totalTokens: usage.totalTokens,
    };
    if (usage.cost) {
      summary.cost = usage.cost;
    }
  }
  // Preserve any provider-reported error info on the assistant message.
  if (message.errorMessage) summary.errorMessage = message.errorMessage;
  return summary;
}

export default function (pi: any): void {
  let turnIndex = 0;
  let enabled = readEnabled();
  // Monotonic per-session counter, included in every filename to guarantee
  // uniqueness even when multiple requests fire in the same second (or even
  // the same millisecond under parallel/multi-agent bursts). Without it,
  // same-second same-model requests collide and overwrite each other.
  let seq = 0;

  // Filepaths written for each turn, in send order. Response info is attached
  // to the oldest not-yet-paired file when an assistant message arrives
  // (FIFO matches the actual request/response order).
  const pending: Map<number, string[]> = new Map();

  pi.on("session_start", (_event: any, ctx: any) => {
    updateStatus(ctx.ui, enabled);
  });

  pi.on("turn_start", (event: any) => {
    turnIndex = event.turnIndex;
  });

  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (!enabled) return;

    const now = new Date();
    const iso = now.toISOString();
    const datePart = iso.slice(0, 10);
    const timePart = iso.slice(11, 19).replace(/:/g, "");
    const msPart = iso.slice(20, 23);
    const modelId = ctx.model?.id ?? "unknown";
    const safeModel = sanitizeModel(modelId);

    const dir = payloadDir();
    mkdirSync(dir, { recursive: true });

    const seqStr = String(seq++).padStart(4, "0");
    const filename = `payload--${datePart}--${timePart}.${msPart}--seq-${seqStr}--turn-${turnIndex}--${safeModel}.json`;
    const filepath = join(dir, filename);

    const payloadJson = JSON.stringify(event.payload, null, 2);
    const snapshot = {
      savedAt: iso,
      turnIndex,
      model: {
        id: ctx.model?.id,
        provider: ctx.model?.provider,
      },
      payload: event.payload,
    };
    writeFileSync(filepath, JSON.stringify(snapshot, null, 2), "utf8");

    const queue = pending.get(turnIndex);
    if (queue) queue.push(filepath);
    else pending.set(turnIndex, [filepath]);

    // Scan the request payload for error signals (e.g. prior tool results
    // with isError:true carried in the message history).
    const reqMatches = scanErrors(payloadJson);
    if (reqMatches.length > 0) {
      appendErrorLog({
        at: iso,
        source: "request",
        turnIndex,
        file: filename,
        model: { id: ctx.model?.id, provider: ctx.model?.provider },
        matches: reqMatches,
      });
    }
  });

  pi.on("message_end", (event: any) => {
    if (!enabled) return;
    const message = event.message;
    if (!message || message.role !== "assistant") return;

    // Pair this response with the oldest unpaired request of the current turn.
    const queue = pending.get(turnIndex);
    const filepath = queue?.shift();
    if (queue && queue.length === 0) pending.delete(turnIndex);
    if (!filepath) return;

    let file: AnyRecord;
    try {
      file = JSON.parse(readFileSync(filepath, "utf8")) as AnyRecord;
    } catch {
      return; // file vanished or corrupted — leave the request-only dump as is
    }
    const summary = responseSummary(message);
    file.response = summary;
    try {
      writeFileSync(filepath, JSON.stringify(file, null, 2), "utf8");
    } catch {
      // Non-fatal: the request-only dump remains on disk.
    }

    // Scan the response summary for error signals (stopReason error,
    // errorMessage, error text in the preview, etc.).
    const resMatches = scanErrors(JSON.stringify(summary, null, 2));
    if (resMatches.length > 0) {
      appendErrorLog({
        at: new Date().toISOString(),
        source: "response",
        turnIndex,
        file: filepath.split(/[/\\]/).pop(),
        model: { id: message.model, provider: message.provider },
        matches: resMatches,
      });
    }
  });

  pi.registerCommand("payload-exporter", {
    description: "Toggle provider payload exporting on or off",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "toggle", "status"];
      const matches = options.filter((o) => o.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (!["on", "off", "toggle", "status"].includes(action)) {
        ctx.ui.notify("Usage: /payload-exporter on|off|toggle|status", "error");
        return;
      }

      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action === "toggle") enabled = !enabled;

      if (action !== "status") writeEnabled(enabled);

      updateStatus(ctx.ui, enabled);
      ctx.ui.notify(
        action === "status"
          ? `Payload exporting is ${enabled ? "on" : "off"} (${payloadDir()}).`
          : `Payload exporting is ${enabled ? "on" : "off"}.`,
        "info",
      );
    },
  });
}
