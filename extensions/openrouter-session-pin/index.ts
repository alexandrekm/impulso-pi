// openrouter-session-pin — pin each pi session to ONE OpenRouter backend.
//
// models.json's compat.openRouterRouting pins routing globally: every session
// on the machine hits the same backend, which maximizes per-session prompt
// cache hits but concentrates rate-limit pressure. This extension moves the
// pin to session scope: at session start each configured model gets ONE
// backend picked at random from <configDir>/openrouter-session-pin.json, and
// every provider request this session sends carries
// `provider: { only: [tag], allow_fallbacks: false }` — injected via the
// `before_provider_request` event, so no shared file or model-object hackery
// is involved and model-catalog refreshes can't drop the pin.
//
// The chosen backend also updates the live model object's name + cost (see
// pin.ts), so the footer and usage costs reflect the backend actually
// serving this session. Pins persist by session id in
// <configDir>/openrouter-session-pin-state.json: /reload and `pi -c` reuse
// the same backend instead of causing a cache miss; /fork and /new get a
// fresh random pick.
//
// Idle re-roll (idleRerollMinutes, default 10): when the next request comes
// after a longer idle gap, the backend's prefix cache has expired anyway,
// so the pin re-rolls for free — long-lived sessions keep spreading across
// backends instead of being frozen on their first pick, and naturally move
// off a slow or rate-limited backend after a break. Requests also touch the
// persisted state (lastRequestAt) so a resumed session judges staleness by
// its true last activity, not its assignment time.
//
// Commands:
//   /orpin          list this session's pinned backends
//   /orpin reroll   re-pick the current model's backend (accepts one cache miss)
//
// Toggled in /settings → Providers → OpenRouter (kind: local; this factory
// bails out when disabled). /reload applies.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";
import {
  applyBackendToModel,
  type BackendCandidate,
  type PinConfig,
  isCandidateTag,
  isPinStale,
  loadState,
  parseConfig,
  patchPayload,
  pickBackend,
  pickBackendExcluding,
  readPersistedLastSeen,
  readPersistedPin,
  recordPin,
  saveState,
  touchPin,
} from "./pin.ts";

const FEATURE_ID = "openrouter-session-pin";
const CONFIG_NAME = "openrouter-session-pin.json";
const STATE_NAME = "openrouter-session-pin-state.json";

const CONFIG_DIR =
  process.env.PI_CODING_AGENT_DIR || dirname(dirname(fileURLToPath(import.meta.url)));

function loadConfig(path: string): PinConfig {
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch {
    // Defaults from an empty config: no models, 10-minute idle re-roll.
    return parseConfig("{}");
  }
}

function sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

export default function (pi: any): void {
  if (!isFeatureEnabled(FEATURE_ID)) return;

  const config = loadConfig(join(CONFIG_DIR, CONFIG_NAME));
  const statePath = join(CONFIG_DIR, STATE_NAME);
  if (Object.keys(config.models).length === 0) return;

  // This process = this session. model id -> pinned candidate + last-seen.
  const pins = new Map<string, { candidate: BackendCandidate; lastSeen: number }>();
  const baseNames = new WeakMap<object, string>();

  /** Assign + persist a fresh pin and reset the in-memory last-seen. */
  const assignPin = (
    sessionId: string,
    modelId: string,
    chosen: BackendCandidate,
    state: ReturnType<typeof loadState>,
  ): BackendCandidate => {
    const now = Date.now();
    pins.set(modelId, { candidate: chosen, lastSeen: now });
    saveState(statePath, recordPin(state, sessionId, modelId, chosen.tag, now), now);
    return chosen;
  };

  /** Resolve this session's backend for a model: reuse the persisted pin,
   *  re-roll it when the session was idle past the configured threshold
   *  (the backend's prefix cache is gone by then anyway), or pick fresh. */
  const ensurePin = (sessionId: string, modelId: string): BackendCandidate | undefined => {
    const candidates = config.models[modelId];
    if (!candidates) return undefined;
    const now = Date.now();
    const state = loadState(statePath);
    const seen = pins.get(modelId)?.lastSeen ?? readPersistedLastSeen(state, sessionId, modelId);
    const stale = isPinStale(seen, config.idleRerollMinutes, now);
    const memory = pins.get(modelId);
    if (memory?.candidate && isCandidateTag(config, modelId, memory.candidate.tag)) {
      if (!stale) return memory.candidate;
      return assignPin(
        sessionId,
        modelId,
        pickBackendExcluding(candidates, memory.candidate.tag),
        state,
      );
    }
    const persisted = readPersistedPin(state, sessionId, modelId);
    const reused = isCandidateTag(config, modelId, persisted)
      ? candidates.find((candidate) => candidate.tag === persisted)
      : undefined;
    if (reused && !stale) {
      pins.set(modelId, { candidate: reused, lastSeen: seen ?? now });
      return reused;
    }
    return assignPin(
      sessionId,
      modelId,
      reused ? pickBackendExcluding(candidates, reused.tag) : pickBackend(candidates),
      state,
    );
  };

  /** Record that a pinned request just happened (idle-gap tracking). */
  const markRequest = (sessionId: string, modelId: string): void => {
    const memory = pins.get(modelId);
    if (!memory) return;
    const now = Date.now();
    memory.lastSeen = now;
    saveState(statePath, touchPin(loadState(statePath), sessionId, modelId, now), now);
  };

  /** Re-apply name/cost for the session's current model (idempotent). */
  const applyToModel = (model: any, sessionId: string): void => {
    if (!model?.id) return;
    const chosen = ensurePin(sessionId, model.id);
    if (chosen) applyBackendToModel(model, chosen, baseNames);
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    applyToModel(ctx.model, sessionIdOf(ctx));
  });

  pi.on("model_select", async (event: any, ctx: any) => {
    applyToModel(event.model, sessionIdOf(ctx));
  });

  // Registry refreshes replace the model object; re-assert each turn.
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    if (ctx.model) applyToModel(ctx.model, sessionIdOf(ctx));
  });

  pi.on("before_provider_request", async (event: any, ctx: any) => {
    const payload = event.payload as { model?: string } | undefined;
    const modelId = payload?.model;
    if (!modelId || !config.models[modelId]) return;
    const sessionId = sessionIdOf(ctx);
    const chosen = ensurePin(sessionId, modelId);
    if (!chosen) return;
    markRequest(sessionId, modelId);
    if (ctx?.model?.id === modelId) applyBackendToModel(ctx.model, chosen, baseNames);
    return patchPayload(payload as Record<string, unknown>, chosen.tag);
  });

  pi.registerCommand("orpin", {
    description:
      "Show this session's pinned OpenRouter backends. `/orpin reroll` re-picks the current model's backend.",
    getArgumentCompletions: (prefix: string) => {
      const matches = ["reroll"].filter((option) => option.startsWith(prefix.toLowerCase()));
      return matches.map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx: any) => {
      const sessionId = sessionIdOf(ctx);
      const modelId = ctx.model?.id;
      if (args.trim().toLowerCase() === "reroll") {
        if (!modelId || !config.models[modelId]) {
          ctx.ui.notify("Current model is not configured for session pinning", "info");
          return;
        }
        const previous = pins.get(modelId)?.candidate;
        const chosen = pickBackendExcluding(config.models[modelId], previous?.tag);
        assignPin(sessionId, modelId, chosen, loadState(statePath));
        applyBackendToModel(ctx.model, chosen, baseNames);
        ctx.ui.notify(
          `Re-pinned ${modelId} → ${chosen.tag} (next request re-warms the cache)`,
          "info",
        );
        return;
      }
      const lines = Object.keys(config.models).map((id) => {
        const chosen = pins.get(id)?.candidate;
        return `  ${id} → ${chosen ? chosen.tag : "(no request yet)"}`;
      });
      ctx.ui.notify(`Session pins (${sessionId || "ephemeral"}):\n${lines.join("\n")}`, "info");
    },
  });
}
