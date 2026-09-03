// Passive pi-subagents lifecycle recorder.
//
// Records bounded, versioned run metadata in the parent session so local
// observability can index it later. It neither registers a subagent tool nor
// reads pi-subagents artifact files: the package remains the sole lifecycle
// owner. Unknown event payloads are ignored fail-closed.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";

const ENTRY_TYPE = "impulso.subagent-run.v1";
const SOURCE_PACKAGE = "pi-subagents";
const SOURCE_PACKAGE_VERSION = "0.64.0";
const LIFECYCLE_ARTIFACT_VERSION = 1;

type RecordValue = Record<string, unknown>;
type TerminalState = "complete" | "failed" | "partial" | "stopped" | "rejected";

interface SubagentRunEntry {
  schemaVersion: 1;
  source: { package: typeof SOURCE_PACKAGE; version: typeof SOURCE_PACKAGE_VERSION };
  lifecycleArtifactVersion: number;
  runId: string;
  /** Bounded non-path parent session identifier (session UUID only). */
  parentSessionId?: string;
  role: string;
  mode: string;
  context: "fresh" | "fork" | "mixed" | "unknown";
  async: boolean;
  state: "started" | TerminalState;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  timeoutMs?: number;
  timedOut?: boolean;
  stopped?: boolean;
  retry?: boolean;
  fallback?: boolean;
  turns?: number;
  tools?: number;
  totalTokens?: number;
  totalCost?: number;
  model?: string;
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Extract a bounded, non-path session identifier from a session file path
 * (e.g. ".../2026-09-03T06-57-39-108Z_01a0660f-1324-7b8e-a1c3-e8f5ea7a24e3.jsonl").
 * Returns only the trailing UUID, never the path. */
function boundedSessionId(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  const uuid = raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
  return uuid ?? undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function terminalState(value: unknown): TerminalState | undefined {
  return value === "complete" ||
    value === "failed" ||
    value === "partial" ||
    value === "stopped" ||
    value === "rejected"
    ? value
    : undefined;
}

function context(value: unknown): SubagentRunEntry["context"] {
  return value === "fresh" || value === "fork" || value === "mixed" ? value : "unknown";
}

function contextFromPayload(payload: RecordValue): SubagentRunEntry["context"] {
  const direct = context(payload.context);
  if (direct !== "unknown") return direct;
  const results = Array.isArray(payload.results) ? payload.results.filter(isRecord) : [];
  const contexts = new Set(
    results.map((result) => context(result.context)).filter((value) => value !== "unknown"),
  );
  return contexts.size === 1 ? [...contexts][0]! : contexts.size > 1 ? "mixed" : "unknown";
}

function numericTotal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isRecord(value)) return undefined;
  return number(value.total) ?? number(value.totalTokens);
}

function costTotal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isRecord(value)) return undefined;
  // pi-subagents terminal results use CostSummary.costUsd; tolerate the
  // older `total` shape as well without recording the full raw payload.
  return number(value.costUsd) ?? number(value.total);
}

function childTotals(
  payload: RecordValue,
): Pick<SubagentRunEntry, "turns" | "tools" | "totalTokens" | "totalCost" | "model"> {
  // pi-subagents completion event has results[] with per-step usage objects
  // like { input, output, cost, turns } and may have top-level totalTokens/
  // totalCost. The telemetry extension must handle both shapes.
  const results = Array.isArray(payload.results) ? payload.results.filter(isRecord) : [];
  const steps = results.length > 0 ? results : [payload];
  let turns = 0;
  let tools = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let hasTurns = false;
  let hasTools = false;
  let hasTokens = false;
  let hasCost = false;
  let model: string | undefined;

  for (const step of steps) {
    const usage = isRecord(step.usage) ? step.usage : undefined;
    const stepTurns = number(step.turnCount) ?? number(usage?.turns);
    const stepTools = number(step.toolCount);
    // Tokens may be at step.totalTokens (nested {input,output,total}),
    // step.tokens (nested), or inside step.usage as input+output.
    const stepTokens =
      numericTotal(step.totalTokens) ??
      numericTotal(step.tokens) ??
      (usage ? (number(usage.input) ?? 0) + (number(usage.output) ?? 0) : undefined);
    // Cost may be at step.totalCost ({costUsd}), step.cost, or usage.cost.
    const stepCost = costTotal(step.totalCost) ?? number(step.cost) ?? number(usage?.cost);
    if (stepTurns !== undefined) {
      turns += stepTurns;
      hasTurns = true;
    }
    if (stepTools !== undefined) {
      tools += stepTools;
      hasTools = true;
    }
    if (stepTokens !== undefined) {
      totalTokens += stepTokens;
      hasTokens = true;
    }
    if (stepCost !== undefined) {
      totalCost += stepCost;
      hasCost = true;
    }
    model ??= string(step.model);
  }

  // Top-level aggregate fields (from pi-subagents status.json shape).
  const topTurns = number(payload.turnCount);
  const topTools = number(payload.toolCount);
  const topTokens = numericTotal(payload.totalTokens) ?? numericTotal(payload.tokens);
  const topCost = costTotal(payload.totalCost) ?? number(payload.cost);
  return {
    ...(topTurns !== undefined ? { turns: topTurns } : hasTurns ? { turns } : {}),
    ...(topTools !== undefined ? { tools: topTools } : hasTools ? { tools } : {}),
    ...(topTokens !== undefined ? { totalTokens: topTokens } : hasTokens ? { totalTokens } : {}),
    ...(topCost !== undefined ? { totalCost: topCost } : hasCost ? { totalCost } : {}),
    ...((string(payload.model) ?? model) ? { model: string(payload.model) ?? model } : {}),
  };
}

export default function subagentTelemetry(pi: ExtensionAPI): void {
  if (!isFeatureEnabled("subagent-telemetry")) return;

  const active = new Map<string, SubagentRunEntry>();
  const terminal = new Set<string>();

  pi.events.on("subagent:async-started", (raw) => {
    if (!isRecord(raw)) return;
    const runId = string(raw.id);
    const role = string(raw.agent);
    const mode = string(raw.mode);
    const startedAt = number(raw.startedAt) ?? Date.now();
    if (!runId || !role || !mode || active.has(runId) || terminal.has(runId)) return;

    const entry: SubagentRunEntry = {
      schemaVersion: 1,
      source: { package: SOURCE_PACKAGE, version: SOURCE_PACKAGE_VERSION },
      lifecycleArtifactVersion: number(raw.lifecycleArtifactVersion) ?? LIFECYCLE_ARTIFACT_VERSION,
      runId,
      ...(boundedSessionId(raw.sessionId)
        ? { parentSessionId: boundedSessionId(raw.sessionId) }
        : {}),
      role,
      mode,
      context: contextFromPayload(raw),
      async: true,
      state: "started",
      startedAt,
      ...(number(raw.timeoutMs) !== undefined ? { timeoutMs: number(raw.timeoutMs) } : {}),
    };
    active.set(runId, entry);
    pi.appendEntry(ENTRY_TYPE, entry);
  });

  pi.events.on("subagent:async-complete", (raw) => {
    if (!isRecord(raw)) return;
    const runId = string(raw.runId) ?? string(raw.id);
    const state = terminalState(raw.state);
    if (!runId || !state || terminal.has(runId)) return;

    const started = active.get(runId);
    const endedAt = number(raw.endedAt) ?? Date.now();
    const startedAt = started?.startedAt ?? Math.max(0, endedAt - (number(raw.durationMs) ?? 0));
    const durationMs = number(raw.durationMs) ?? Math.max(0, endedAt - startedAt);
    const entry: SubagentRunEntry = {
      ...(started ?? {
        schemaVersion: 1,
        source: { package: SOURCE_PACKAGE, version: SOURCE_PACKAGE_VERSION },
        lifecycleArtifactVersion:
          number(raw.lifecycleArtifactVersion) ?? LIFECYCLE_ARTIFACT_VERSION,
        runId,
        role: string(raw.agent) ?? "unknown",
        mode: string(raw.mode) ?? "unknown",
        context: contextFromPayload(raw),
        async: true,
        state: "started" as const,
        startedAt,
      }),
      state,
      endedAt,
      durationMs,
      ...(bool(raw.timedOut) !== undefined ? { timedOut: bool(raw.timedOut) } : {}),
      ...(bool(raw.stopped) !== undefined ? { stopped: bool(raw.stopped) } : {}),
      ...childTotals(raw),
      context: contextFromPayload(raw),
    };
    active.delete(runId);
    terminal.add(runId);
    pi.appendEntry(ENTRY_TYPE, entry);
  });
}
