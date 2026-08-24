// On-demand skill injection — keyword-triggered.
//
// Skills listed in pi's system prompt (`<available_skills>`) cost context on
// every turn even when never used. A skill with `disable-model-invocation:
// true` in its SKILL.md frontmatter is dropped from that block (but stays
// registered, so `/skill:<name>` still works and its files are still readable)
// — at the cost of the model no longer knowing it exists. This extension
// bridges that gap: it watches each user message for configured keywords and,
// on a match, injects a tiny pointer telling the model to `read` the skill
// file. No match → no injection → zero context cost.
//
// Config lives in `config.json` next to this file (read fresh each turn, so
// edits apply on the next message — no `/reload` needed for config changes):
//
//   {
//     "triggers": {
//       "datadog": {
//         "keywords": ["datadog", "dashboard", "metric", ...],
//         "hint": "Read the Datadog skill file at {path} with the `read` tool ..."
//       }
//     }
//   }
//
// A trigger only fires if the named skill is actually loaded on the current
// profile (e.g. `datadog` is work-tagged, so on `personal` the trigger no-ops).
// `{path}` is replaced with the skill's SKILL.md `filePath` from
// `event.systemPromptOptions.skills`.
//
// ── Robustness against the `system-prompt` extension ──────────────────────
//
// The optional `system-prompt` extension rebuilds the whole prompt from
// `systemPromptOptions` in its own `before_agent_start` handler, discarding
// `event.systemPrompt`. Depending on filesystem load order it may run before
// or after us, so we use the same dual-channel trick as the `gws` extension:
//
//   Channel 1 — mutate `opts.appendSystemPrompt` so a `system-prompt` that
//               runs *after* us re-emits the pointer when it rebuilds.
//   Channel 2 — return `{ systemPrompt: event.systemPrompt + block }` so a
//               `system-prompt` that already ran (or native pi without it)
//               still gets the pointer.
//
// `opts` is the same object reused across turns, so any mutation persists.
// To avoid stale/duplicate pointers we make injection **idempotent**: the
// block is wrapped in self-delimiting `<on_demand_skills>…</on_demand_skills>`
// tags and **stripped before re-injection** every turn — both from
// `event.systemPrompt` (channel 2) and from `opts.appendSystemPrompt` (channel
// 1, where we recompute from the stripped/original value). Result: exactly one
// fresh block per turn when a keyword matches, zero otherwise, regardless of
// extension order or prior turns.
//
// Toggled via the impulso settings page (feature id `on-demand-skills`); off =
// the extension registers nothing and adds no context. Core so every profile
// gets it; triggers silently no-op for skills not installed on a profile.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(MODULE_DIR, "config.json");

// ─────────────────────────────────────────────────────────────────────────
// Feature flag (inline — same pattern as system-prompt/gws, so this extension
// has no import-time dependency on impulso-settings being present).
// ─────────────────────────────────────────────────────────────────────────

function isFeatureEnabled(id: string): boolean {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
    const raw = readFileSync(join(dir, "impulso-settings.json"), "utf8");
    return !((JSON.parse(raw).disabled ?? []) as string[]).includes(id);
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

interface Trigger {
  keywords: string[];
  hint: string;
}
interface OnDemandConfig {
  triggers?: Record<string, Trigger>;
}

// Read fresh each turn so config edits apply without /reload. Tiny file.
function readConfig(): OnDemandConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as OnDemandConfig;
  } catch {
    return {};
  }
}

// Build a case-insensitive, word-boundary matcher that also accepts a trailing
// "s" (so `dashboard` matches `dashboards`, `metric` matches `metrics`).
// `\b…\b` keeps short keywords like `pup` from matching `puppet`/`puppy`.
function buildMatcher(keywords: string[]): RegExp | null {
  const escaped = keywords
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return null;
  return new RegExp(`\\b(?:${escaped.map((k) => `${k}s?`).join("|")})\\b`, "i");
}

// ─────────────────────────────────────────────────────────────────────────
// Pointer block (self-delimiting so it can be stripped idempotently)
// ─────────────────────────────────────────────────────────────────────────

const BLOCK_OPEN = "<on_demand_skills>";
const BLOCK_CLOSE = "</on_demand_skills>";
// Matches a whole block (including the leading blank-line pair we add) so it
// can be removed cleanly before re-injection. `[\s\S]` for dotall matching.
const BLOCK_RE = /\n\n<on_demand_skills>[\s\S]*?<\/on_demand_skills>/g;

function stripBlock(s: string): string {
  return s.replace(BLOCK_RE, "");
}

function buildBlock(entries: { hint: string }[]): string {
  if (entries.length === 0) return "";
  const body = entries.map((e) => e.hint).join("\n\n");
  return `\n\n${BLOCK_OPEN}\n${body}\n${BLOCK_CLOSE}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Extension factory
// ─────────────────────────────────────────────────────────────────────────

export default function (pi: any): void {
  if (!isFeatureEnabled("on-demand-skills")) return;

  pi.on("before_agent_start", async (event: any) => {
    const opts = event?.systemPromptOptions;
    if (!opts) return; // older pi without structured options — leave prompt alone
    if (opts.customPrompt) return; // respect explicit user override (SYSTEM.md / --system-prompt)

    const prompt: string = typeof event.prompt === "string" ? event.prompt : "";
    if (!prompt) return;

    const config = readConfig();
    const triggers = config.triggers;
    if (!triggers) return;

    const skills: any[] = Array.isArray(opts.skills) ? opts.skills : [];
    const byName = new Map<string, any>();
    for (const s of skills) {
      if (s && typeof s.name === "string") byName.set(s.name, s);
    }

    const matched: { hint: string }[] = [];
    for (const [skillName, trigger] of Object.entries(triggers)) {
      if (!trigger || !Array.isArray(trigger.keywords) || typeof trigger.hint !== "string")
        continue;
      const skill = byName.get(skillName);
      if (!skill) continue; // skill not installed on this profile — skip silently
      const filePath: string | undefined = skill.filePath;
      if (!filePath) continue;

      const matcher = buildMatcher(trigger.keywords);
      if (!matcher) continue;
      if (!matcher.test(prompt)) continue;

      matched.push({ hint: trigger.hint.replace(/\{path\}/g, filePath) });
    }

    const block = buildBlock(matched);

    // ── Channel 1: opts.appendSystemPrompt ──
    // Recompute from the *stripped* (original) value so nothing accumulates
    // across turns. Covers a `system-prompt` extension that rebuilds after us.
    const origAppend = stripBlock(
      typeof opts.appendSystemPrompt === "string" ? opts.appendSystemPrompt : "",
    );
    if (block) {
      opts.appendSystemPrompt = origAppend ? `${origAppend}\n\n${block}` : block;
    } else {
      opts.appendSystemPrompt = origAppend || undefined;
    }

    // ── Channel 2: override the already-built prompt ──
    // Strip any stale block baked in by a `system-prompt` extension that ran
    // before us (it read opts.appendSystemPrompt as we left it last turn), then
    // add the fresh block. Covers `system-prompt` running before us / native pi.
    const cleaned = stripBlock(typeof event.systemPrompt === "string" ? event.systemPrompt : "");
    if (block) {
      return { systemPrompt: cleaned + block };
    }
    if (cleaned !== (event.systemPrompt ?? "")) {
      // A stale block was present and we removed it; return the cleaned prompt.
      return { systemPrompt: cleaned };
    }
    // No match, no stale block — leave the prompt untouched.
  });
}
