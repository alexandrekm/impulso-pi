// Google Workspace (gws) skills — mode-gated.
//
// Vendors the `gws` CLI agent skills for Docs, Sheets, Drive, and Gmail
// (plus the shared auth/flags reference and each service's granular helper
// sub-skills) from https://github.com/googleworkspace/cli under
// ./skills/gws-*/SKILL.md. Those files are NOT placed in pi's skill
// discovery locations, so pi never loads them by default — they stay out of
// context entirely until the user opts in.
//
// Opt-in is a per-profile mode toggled by the `/gws` command:
//
//   /gws on        enable gws skills for the rest of the session
//   /gws off       disable them again
//   /gws toggle    flip the mode
//   /gws           show status
//
// State persists in <configDir>/gws.json ({ enabled: boolean }), default
// off. The mode is read fresh on every turn inside `before_agent_start`, so
// toggling takes effect on the next user message — no `/reload` needed.
//
// When enabled, this extension:
//   1. parses the 5 primary SKILL.md files (shared + docs/sheets/drive/gmail)
//      for name + description, and
//   2. injects them as skill objects into event.systemPromptOptions.skills,
//   3. and appends an <available_skills> block to the chained system prompt.
//
// The granular sub-skills (gws-gmail-send, gws-docs-write, …) are not listed
// in the prompt — the primary skills link to them via relative paths
// (../gws-gmail-send/SKILL.md), and the model loads those on demand with the
// `read` tool, exactly like any other skill. The skill `filePath`/`baseDir`
// point at the vendored copies on disk, so relative references resolve.
//
// Injection is robust against the optional `system-prompt` extension (which
// rebuilds the whole prompt from systemPromptOptions): we both mutate
// opts.skills (so a later-rebuilding system-prompt includes them) AND append
// to event.systemPrompt (so a system-prompt that already ran, or none, still
// gets them). At most one copy survives: if system-prompt rebuilds after us
// it overwrites our append and re-emits skills from opts.skills (with ours);
// if it ran before us or is absent, our append is the sole copy.
//
// Toggled via the impulso settings page (feature id `gws`); off = the
// extension registers nothing and adds no context. Core so every profile
// gets it; the mode itself is per-profile and off by default.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || dirname(dirname(MODULE_DIR));
const STATE_PATH = join(CONFIG_DIR, "gws.json");
const SKILLS_DIR = join(MODULE_DIR, "skills");

// Primary skills surfaced in the system prompt. The granular helper
// sub-skills live on disk as siblings and are reached via relative links
// from these — no need to list them all (keeps context minimal).
const PRIMARY_SKILLS = ["gws-shared", "gws-docs", "gws-sheets", "gws-drive", "gws-gmail"] as const;

// ─────────────────────────────────────────────────────────────────────────
// Feature flag (inline — same pattern as system-prompt, so this extension
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
// Mode state (<configDir>/gws.json)
// ─────────────────────────────────────────────────────────────────────────

interface GwsState {
  enabled?: boolean;
}

function readState(): boolean {
  try {
    const data = JSON.parse(readFileSync(STATE_PATH, "utf8")) as GwsState;
    return data.enabled === true;
  } catch {
    return false;
  }
}

function writeState(enabled: boolean): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ enabled }, null, 2) + "\n", "utf8");
  } catch {
    // Non-fatal: in-memory flag still works for the session.
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SKILL.md frontmatter parsing (name + description only)
// ─────────────────────────────────────────────────────────────────────────

interface ParsedSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Parse the YAML frontmatter block (between the first two `---` lines) for
// `name` and `description`. Both are single-line in the gws skills. Returns
// null if the file is missing or malformed.
function parseSkill(skillDir: string): ParsedSkill | null {
  const filePath = join(SKILLS_DIR, skillDir, "SKILL.md");
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n");

  // Frontmatter must start with a `---` line.
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  let name = "";
  let description = "";
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const nameMatch = /^name:\s*(.*)$/.exec(line);
    if (nameMatch && !name) {
      name = unquote(nameMatch[1]);
      continue;
    }
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch && !description) {
      description = unquote(descMatch[1]);
      continue;
    }
  }
  if (!name || !description) return null;

  return {
    name,
    description,
    filePath,
    baseDir: dirname(filePath),
  };
}

let cachedSkills: ParsedSkill[] | null = null;

function primarySkills(): ParsedSkill[] {
  if (cachedSkills) return cachedSkills;
  const out: ParsedSkill[] = [];
  for (const dir of PRIMARY_SKILLS) {
    const parsed = parseSkill(dir);
    if (parsed) out.push(parsed);
  }
  cachedSkills = out;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Prompt injection
// ─────────────────────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Mirror of pi's formatSkillsForPrompt shape (see extensions/system-prompt).
function formatSkillsBlock(skills: ParsedSkill[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Extension factory
// ─────────────────────────────────────────────────────────────────────────

export default function (pi: any): void {
  if (!isFeatureEnabled("gws")) return;

  // Inject the gws skills into the system prompt when the mode is on.
  pi.on("before_agent_start", async (event: any) => {
    if (!readState()) return;
    const skills = primarySkills();
    if (skills.length === 0) return;

    // 1) Mutate the structured options so a later-rebuilding system-prompt
    //    extension re-emits our skills from opts.skills.
    const opts = event.systemPromptOptions;
    if (opts && Array.isArray(opts.skills)) {
      const existing = new Set<string>(opts.skills.map((s: any) => s?.name));
      for (const skill of skills) {
        if (!existing.has(skill.name)) {
          opts.skills.push({
            name: skill.name,
            description: skill.description,
            filePath: skill.filePath,
            baseDir: skill.baseDir,
            source: "custom",
            disableModelInvocation: false,
          });
        }
      }
    }

    // 2) Append an <available_skills> block to the chained prompt so the
    //    skills appear even if system-prompt already ran (or is disabled).
    const block = formatSkillsBlock(skills);
    if (block) {
      return { systemPrompt: event.systemPrompt + block };
    }
  });

  // /gws on|off|toggle|status — toggle the mode.
  pi.registerCommand("gws", {
    description: "Toggle Google Workspace (gws) skills on/off. Usage: /gws on|off|toggle|status",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "toggle", "status"];
      const matches = options.filter((o) => o.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const action = (args.trim().toLowerCase() || "status") as string;
      if (!["on", "off", "toggle", "status"].includes(action)) {
        ctx.ui.notify("Usage: /gws on|off|toggle|status", "error");
        return;
      }

      let enabled = readState();
      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action === "toggle") enabled = !enabled;

      if (action !== "status") writeState(enabled);

      if (action === "status") {
        ctx.ui.notify(
          `gws skills are ${enabled ? "ON" : "OFF"} — ${
            enabled
              ? "Docs/Sheets/Drive/Gmail skills are in context."
              : "use /gws on to enable Docs/Sheets/Drive/Gmail skills."
          }`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `gws skills ${enabled ? "enabled" : "disabled"} — applies on your next message.`,
          "info",
        );
      }
    },
  });
}
