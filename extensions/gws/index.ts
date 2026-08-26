// Google Workspace (gws) skills — injected in doc mode.
//
// Vendors the `gws` CLI agent skills for Docs, Sheets, Drive, and Gmail
// (plus the shared auth/flags reference and each service's granular helper
// sub-skills) from https://github.com/googleworkspace/cli under
// ./skills/gws-*/SKILL.md. Those files are NOT placed in pi's skill
// discovery locations, so pi never loads them by default — they stay out of
// context entirely until doc mode is active.
//
// The toggle is the `modes` extension's `/mode doc` command (state in
// <configDir>/mode.json). There is no separate `/gws` command or settings
// toggle: doc mode *is* the gws toggle. This extension reads mode.json fresh
// on every turn inside `before_agent_start`, so switching modes takes effect
// on the next user message — no `/reload` needed. On profiles without the
// modes extension (mode.json absent), this extension is inert.
//
// When mode === "doc", this extension:
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
// gets them). The `modes` extension's own skills-block rewrite (which runs on
// the same event) collapses any duplicate blocks into one regardless of
// handler order, so the final prompt is clean either way.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || dirname(dirname(MODULE_DIR));
const MODE_PATH = join(CONFIG_DIR, "mode.json");
const SKILLS_DIR = join(MODULE_DIR, "skills");

// Primary skills surfaced in the system prompt. The granular helper
// sub-skills live on disk as siblings and are reached via relative links
// from these — no need to list them all (keeps context minimal).
const PRIMARY_SKILLS = ["gws-shared", "gws-docs", "gws-sheets", "gws-drive", "gws-gmail"] as const;

// ─────────────────────────────────────────────────────────────────────────
// Mode state (<configDir>/mode.json) — owned by the `modes` extension.
// ─────────────────────────────────────────────────────────────────────────

interface ModeState {
  mode?: string;
}

// True iff the current mode is "doc" (the gws-injecting mode). mode.json
// absent (no modes extension on this profile) → false → inert.
function isDocMode(): boolean {
  try {
    const data = JSON.parse(readFileSync(MODE_PATH, "utf8")) as ModeState;
    return data.mode === "doc";
  } catch {
    return false;
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
  // Inject the gws skills into the system prompt when doc mode is active.
  pi.on("before_agent_start", async (event: any) => {
    if (!isDocMode()) return;
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
    //    The modes extension collapses this with any other block into one.
    const block = formatSkillsBlock(skills);
    if (block) {
      return { systemPrompt: event.systemPrompt + block };
    }
  });
}
