// Modes — a per-profile mode switch that gates which skills reach the system
// prompt each turn. Layered on top of profiles (which decide which skill *files*
// are synced in); modes decide which of those synced skills are *in context*.
//
// Only relevant to the work profile right now (tagged `work` in profiles.jsonc),
// but the mechanism is generic — add modes to config.json and the extension
// extension picks them up.
//
//   /mode             flip code <-> doc (toggle)
//   /mode status      show current mode
//   /mode code        switch to code mode (default)
//   /mode doc         switch to doc mode
//   /mode toggle      flip code <-> doc
//
// State persists in <configDir>/mode.json ({ mode: "code" | "doc" }) but is
// reset to the config `default` (code) on every session_start — the mode is
// per-session, not a sticky cross-session preference. The mode is read
// fresh on every turn inside `before_agent_start`, so switching takes
// effect on the next user message — no `/reload` needed.
//
// Gating is declared in ./config.json under `gated`: a map of skill name -> the
// modes in which it is visible. A skill NOT listed in `gated` is always visible
// (e.g. address-pr-comments, datadog, glean). A skill listed is hidden (its
// `disableModelInvocation` flag is set true on the discovered skill object) in
// any mode not in its allowed list. Hiding is prompt-only: it removes the skill
// from the <available_skills> auto-context block; command-only skills
// (disable-model-invocation: true in their frontmatter) are
// never in that block anyway, so gating them is a harmless no-op on the prompt
// but documents intent. Command-only flows like /create-pr are now prompt
// templates under prompts/, which bypass skill gating entirely.
//
// Doc mode also brings in the Google Workspace (`gws`) skills (Docs/Sheets/
// Drive/Gmail): the gws extension reads mode.json directly and injects them
// when mode === "doc", so there is no separate /gws toggle — /mode doc *is*
// the gws switch. This extension only owns skill gating + the mode state.
// Composes with the system-prompt extension (which rebuilds the whole prompt
// from event.systemPromptOptions.skills) and the gws extension (which injects
// gws-* skills into that same array): we mutate opts.skills in place so any
// later rebuild emits the gated set, AND we rewrite any already-built
// <available_skills> block(s) in event.systemPrompt so a prompt that was
// assembled before us (or with system-prompt disabled) is corrected too.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || dirname(dirname(MODULE_DIR));
const STATE_PATH = join(CONFIG_DIR, "mode.json");
const CONFIG_PATH = join(MODULE_DIR, "config.json");

// ─────────────────────────────────────────────────────────────────────────
// Feature flag (inline — same pattern as gws / system-prompt, so this
// extension has no import-time dependency on impulso-settings being present).
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
// Mode config + state
// ─────────────────────────────────────────────────────────────────────────

interface ModeConfig {
  default: string;
  modes: string[];
  gated: Record<string, string[]>;
}

let cachedConfig: ModeConfig | null = null;

function readConfig(): ModeConfig {
  if (cachedConfig) return cachedConfig;
  const raw = readFileSync(CONFIG_PATH, "utf8");
  cachedConfig = JSON.parse(raw) as ModeConfig;
  return cachedConfig;
}

interface ModeState {
  mode?: string;
}

function readMode(): string {
  const cfg = readConfig();
  try {
    const data = JSON.parse(readFileSync(STATE_PATH, "utf8")) as ModeState;
    const mode = data.mode;
    if (mode && cfg.modes.includes(mode)) return mode;
  } catch {
    // no state file yet
  }
  return cfg.default;
}

function writeMode(mode: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ mode }, null, 2) + "\n", "utf8");
  } catch {
    // Non-fatal: in-memory behaviour still works for the session.
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Prompt block helpers (mirror pi's formatSkillsForPrompt shape)
// ─────────────────────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkillsBlock(skills: any[]): string {
  const visible = (skills ?? []).filter((s: any) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(String(skill.name))}</name>`);
    lines.push(`    <description>${escapeXml(String(skill.description ?? ""))}</description>`);
    if (skill.filePath) lines.push(`    <location>${escapeXml(String(skill.filePath))}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

// Matches one whole skills chunk: the intro sentences + the <available_skills>
// block. There can be more than one (e.g. the gws extension appends its own).
const SKILLS_BLOCK_RE =
  /The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>\n?/g;

// Replace every existing skills chunk in the prompt with a single regenerated
// one (or remove them all if no skills are visible). The first occurrence is
// rewritten in place so positioning relative to the cwd line is preserved.
function rewriteSkillsBlocks(prompt: string, skills: any[]): string {
  const block = formatSkillsBlock(skills);
  let first = true;
  return prompt.replace(SKILLS_BLOCK_RE, () => {
    if (first) {
      first = false;
      return block ? (block.startsWith("\n") ? block : "\n\n" + block) : "";
    }
    return "";
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Extension factory
// ─────────────────────────────────────────────────────────────────────────

export default function (pi: any): void {
  if (!isFeatureEnabled("modes")) return;

  // A session always starts in the default mode (code). mode.json is
  // within-session state, not a cross-session preference: /mode is for
  // temporarily flipping mid-session, and the next session starts clean.
  pi.on("session_start", async () => {
    const cfg = readConfig();
    if (readMode() !== cfg.default) writeMode(cfg.default);
  });

  // Gate the discovered skills for the current mode on every turn.
  pi.on("before_agent_start", async (event: any) => {
    const mode = readMode();
    const cfg = readConfig();
    const opts = event.systemPromptOptions;

    // 1) Mutate the structured skill list so any later-rebuilding system-prompt
    //    extension re-emits the gated set from opts.skills.
    if (opts && Array.isArray(opts.skills)) {
      for (const skill of opts.skills) {
        const allowed = cfg.gated[skill?.name];
        if (allowed && !allowed.includes(mode)) {
          skill.disableModelInvocation = true;
        }
      }
    }

    // 2) If the prompt was already assembled (system-prompt ran before us, or
    //    is disabled and pi built its default), rewrite any <available_skills>
    //    block(s) from the now-gated skill set.
    if (event.systemPrompt && SKILLS_BLOCK_RE.test(event.systemPrompt)) {
      SKILLS_BLOCK_RE.lastIndex = 0; // .test advances the global regex
      const rewritten = rewriteSkillsBlocks(event.systemPrompt, opts?.skills ?? []);
      return { systemPrompt: rewritten };
    }
  });

  // /mode [code|doc|toggle|status] — bare /mode toggles.
  pi.registerCommand("mode", {
    description:
      "Switch skill mode (code | doc). Bare /mode toggles; also: /mode [code|doc|toggle|status]",
    getArgumentCompletions: (prefix: string) => {
      const cfg = readConfig();
      const options = [...cfg.modes, "toggle", "status"];
      const matches = options.filter((o) => o.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const cfg = readConfig();
      const action = args.trim().toLowerCase();

      let mode = readMode();
      if (action === "status") {
        // just report
      } else if (action === "" || action === "toggle") {
        const idx = cfg.modes.indexOf(mode);
        mode = cfg.modes[(idx + 1) % cfg.modes.length];
        writeMode(mode);
      } else if (cfg.modes.includes(action)) {
        mode = action;
        writeMode(mode);
      } else {
        ctx.ui.notify(`Usage: /mode [${cfg.modes.join("|")}|toggle|status]`, "error");
        return;
      }

      const gatedForMode = Object.entries(cfg.gated)
        .filter(([, allowed]) => allowed.includes(mode))
        .map(([name]) => name);
      const hiddenForMode = Object.entries(cfg.gated)
        .filter(([, allowed]) => !allowed.includes(mode))
        .map(([name]) => name);

      if (action === "status") {
        ctx.ui.notify(
          `Current mode: ${mode} — visible: ${gatedForMode.join(", ") || "(none gated)"}; hidden: ${hiddenForMode.join(", ") || "(none)"}. Use /mode ${cfg.modes.filter((m) => m !== mode).join("|")} to switch.`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Mode: ${mode} — applies on your next message. (gws skills ${mode === "doc" ? "injected" : "off"})`,
          "info",
        );
      }
    },
  });
}
