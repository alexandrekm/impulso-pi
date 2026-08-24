// On-demand skill injection — keyword-triggered, appended to the user message.
//
// Skills listed in pi's system prompt (`<available_skills>`) cost context on
// every turn even when never used. A skill with `disable-model-invocation:
// true` in its SKILL.md frontmatter is dropped from that block (but stays
// registered, so `/skill:<name>` still works and its files are still readable)
// — at the cost of the model no longer knowing it exists. This extension
// bridges that gap: it watches each user message for configured keywords and,
// on a match, appends a small one-line pointer to the user's own message text
// telling the model to `read` the skill file. No match → nothing appended.
//
// The hint is tiny (~45 tokens), so we don't bother de-duplicating across
// turns: if "dashboard" comes up again next turn we just append the pointer
// again. The model won't re-read a file it already has in context, and after a
// compaction a fresh append is exactly what's wanted anyway (the prior hint and
// skill content were folded into the summary). Simpler than scanning history.
//
// ── Why the `input` hook (not `before_agent_start`) ───────────────────────
//
// The hint is appended to the *user message*, not the system prompt, so it
// reads as part of the user's turn ("use this skill to do this") rather than
// as global instructions. Pi fires the `input` event before the user message
// is built; returning `{ action: "transform", text }` rewrites the submitted
// text in place. The transformed text becomes the user message content and is
// what the model sees (and what the TUI renders in the transcript).
//
// `before_agent_start` cannot do this: by the time it fires the user message
// is already constructed, and its result can only replace the system prompt or
// add a separate "custom" role message — neither appends to the user message.
//
// ── Skill path resolution ────────────────────────────────────────────────
//
// The `input` event fires before `systemPromptOptions` exists, so we can't
// read skill paths from there. Instead we resolve directly:
//   <configDir>/skills/<name>/SKILL.md
// and skip silently if the file isn't present — which is exactly the "skill
// not installed on this profile" case (e.g. `datadog` is work-tagged, so on
// `personal` the file is absent and the trigger no-ops). This covers all
// repo-local skills synced by install.sh. Package-provided skills (from npm
// packages) live elsewhere; if you need to trigger one, point its `hint` at
// the known absolute path instead of relying on `{path}`.
//
// ── What we skip ─────────────────────────────────────────────────────────
//
// Slash-command inputs (text starting with `/`) are passed through untouched
// so we never interfere with command routing or `/skill:<name>` expansion
// (which already loads the skill inline — appending a pointer would be
// redundant).
//
// Config lives in `config.json` next to this file, read fresh each turn, so
// edits apply on the next message — no `/reload` needed for config changes.
//
// Toggled via the impulso settings page (feature id `on-demand-skills`); off =
// the extension registers nothing and adds no context. Core so every profile
// gets it; triggers silently no-op for skills not installed on a profile.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || dirname(dirname(MODULE_DIR));
const CONFIG_PATH = join(MODULE_DIR, "config.json");
const SKILLS_DIR = join(CONFIG_DIR, "skills");

// ─────────────────────────────────────────────────────────────────────────
// Feature flag (inline — same pattern as system-prompt/gws, so this extension
// has no import-time dependency on impulso-settings being present).
// ─────────────────────────────────────────────────────────────────────────

function isFeatureEnabled(id: string): boolean {
  try {
    const raw = readFileSync(join(CONFIG_DIR, "impulso-settings.json"), "utf8");
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

// Read fresh each input so config edits apply without /reload. Tiny file.
function readConfig(): OnDemandConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as OnDemandConfig;
  } catch {
    return {};
  }
}

// Case-insensitive, word-boundary matcher that also accepts a trailing "s"
// (so `dashboard` matches `dashboards`, `metric` matches `metrics`).
// `\b…\b` keeps short keywords like `pup` from matching `puppet`/`puppy`.
function buildMatcher(keywords: string[]): RegExp | null {
  const escaped = keywords
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return null;
  return new RegExp(`\\b(?:${escaped.map((k) => `${k}s?`).join("|")})\\b`, "i");
}

// Resolve a skill's SKILL.md path under <configDir>/skills/<name>/. Returns
// null when the skill isn't installed on this profile (no-op signal).
function skillPath(name: string): string | null {
  const p = join(SKILLS_DIR, name, "SKILL.md");
  return existsSync(p) ? p : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Extension factory
// ─────────────────────────────────────────────────────────────────────────

export default function (pi: any): void {
  if (!isFeatureEnabled("on-demand-skills")) return;

  pi.on("input", async (event: any) => {
    const text: string = typeof event?.text === "string" ? event.text : "";
    if (!text) return;
    // Pass slash commands through untouched (don't interfere with command
    // routing or /skill:<name> expansion, which already loads the skill).
    if (text.trimStart().startsWith("/")) return;

    const config = readConfig();
    const triggers = config.triggers;
    if (!triggers) return;

    const hints: string[] = [];
    for (const [skillName, trigger] of Object.entries(triggers)) {
      if (!trigger || !Array.isArray(trigger.keywords) || typeof trigger.hint !== "string")
        continue;
      const path = skillPath(skillName);
      if (!path) continue; // skill not installed on this profile — skip silently

      const matcher = buildMatcher(trigger.keywords);
      if (!matcher) continue;
      if (!matcher.test(text)) continue;

      hints.push(trigger.hint.replace(/\{path\}/g, path));
    }

    if (hints.length === 0) return;

    // Append as a clearly-delimited continuation of the user's message so the
    // model can tell the pointer apart from the user's actual request.
    const block = `\n\n<skill_hint>\n${hints.join("\n\n")}\n</skill_hint>`;
    return { action: "transform", text: text + block };
  });
}
