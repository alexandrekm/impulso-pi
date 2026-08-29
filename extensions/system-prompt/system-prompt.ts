// Owns the FIXED parts of pi's system prompt while keeping the DYNAMIC parts
// (active tools list, guidelines contributed by tools, --append-system-prompt
// text, loaded <project_context> files, skills, cwd) flowing from pi exactly
// as pi would have generated them.
//
// How it works: pi assembles the full system prompt before firing
// `before_agent_start`. We get the structured pieces via
// `event.systemPromptOptions` and reassemble the prompt ourselves, substituting
// our own INTRO, "in addition" line, always-on guidelines, and a concise pointer
// to the pi-development skill.
// The dynamic pieces (selectedTools/toolSnippets, promptGuidelines,
// appendSystemPrompt, contextFiles, skills, cwd) come straight from the
// options, so tool activation, skill loading, AGENTS.md, /append, etc. keep
// working without us having to know about them.
//
// If the user supplied their own custom prompt (SYSTEM.md / --system-prompt),
// `options.customPrompt` is set and pi took the custom-prompt branch — we
// respect that and do nothing.
//
// Toggled via the impulso settings page (feature id `system-prompt`); off =
// pi's stock prompt is used verbatim.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────
// Feature flag (same pattern as other local extensions — inline so this
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
// FIXED parts — owned here. Edit these to change the non-dynamic prompt.
// The intro/footer/guidelines match pi defaults; the Pi-development pointer is
// an intentional divergence from pi's verbose always-on documentation block.
// ─────────────────────────────────────────────────────────────────────────

const INTRO =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

// Sandwiched between the tools list and the Guidelines section.
const TOOLS_FOOTER =
  "In addition to the tools above, you may have access to other custom tools depending on the project.";

// Guidelines appended for every prompt (after any tool-dependent / tool-
// contributed bullets). Order matches pi's default.
const ALWAYS_ON_GUIDELINES = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
];

// Tool-dependent guideline pi adds when bash is active but none of
// grep/find/ls are (i.e. the user would otherwise have no file-search tool).
const BASH_ONLY_FILEOPS_GUIDELINE = "Use bash for file operations like ls, rg, find";

// Detailed Pi-development guidance belongs in an on-demand skill rather than
// every system prompt. The pointer is emitted only when the model-invocable skill
// is actually loaded (for example, not under --no-skills).
const PI_DEVELOPMENT_SKILL_POINTER =
  "For pi-specific work (core, SDK, extensions, themes, skills, or TUI), load the `pi-development` skill before acting.";

// ─────────────────────────────────────────────────────────────────────────
// Helpers — replicate pi's internal assembly so output matches pi's default
// when the constants above are unchanged.
// ─────────────────────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Mirror of pi's formatSkillsForPrompt (dist/core/skills.js).
function formatSkillsForPrompt(skills: any[]): string {
  const visible = (skills ?? []).filter((s: any) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

// Reassemble the prompt from structured options + our fixed constants.
function buildPrompt(opts: any): string {
  const selectedTools: string[] = opts.selectedTools ?? ["read", "bash", "edit", "write"];
  const toolSnippets: Record<string, string> = opts.toolSnippets ?? {};

  // Available tools — only tools with a snippet are listed; "(none)" otherwise.
  const visible = selectedTools.filter((name) => !!toolSnippets[name]);
  const toolsList =
    visible.length > 0
      ? visible.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n")
      : "(none)";

  // Guidelines — deduped, order: bash-only fileops, tool-contributed, always-on.
  const guidelinesList: string[] = [];
  const seen = new Set<string>();
  const add = (g: string) => {
    if (!seen.has(g)) {
      seen.add(g);
      guidelinesList.push(g);
    }
  };
  const hasBash = selectedTools.includes("bash");
  const hasGrep = selectedTools.includes("grep");
  const hasFind = selectedTools.includes("find");
  const hasLs = selectedTools.includes("ls");
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    add(BASH_ONLY_FILEOPS_GUIDELINE);
  }
  for (const g of opts.promptGuidelines ?? []) {
    const norm = g.trim();
    if (norm.length > 0) add(norm);
  }
  for (const g of ALWAYS_ON_GUIDELINES) add(g);
  const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

  const hasPiDevelopmentSkill = (opts.skills ?? []).some(
    (skill: any) => skill.name === "pi-development" && !skill.disableModelInvocation,
  );
  const skillPointer = hasPiDevelopmentSkill ? `\n\n${PI_DEVELOPMENT_SKILL_POINTER}` : "";

  let prompt = `${INTRO}\n\nAvailable tools:\n${toolsList}\n\n${TOOLS_FOOTER}\n\nGuidelines:\n${guidelines}${skillPointer}`;

  // appendSystemPrompt (--append-system-prompt / APPEND_SYSTEM.md)
  const append: string[] | undefined = opts.appendSystemPrompt;
  const appendText = Array.isArray(append) ? append.filter(Boolean).join("\n\n") : append;
  if (appendText) prompt += `\n\n${appendText}`;

  // <project_context> files (AGENTS.md etc.)
  const contextFiles: any[] = opts.contextFiles ?? [];
  if (contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }

  // Skills — only when read is available (mirrors pi).
  if (selectedTools.includes("read")) {
    prompt += formatSkillsForPrompt(opts.skills ?? []);
  }

  prompt += `\nCurrent working directory: ${String(opts.cwd ?? "").replace(/\\/g, "/")}`;
  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────
// Extension factory
// ─────────────────────────────────────────────────────────────────────────

export default function (pi: any): void {
  if (!isFeatureEnabled("system-prompt")) return;

  pi.on("before_agent_start", async (event: any) => {
    const opts = event.systemPromptOptions;
    if (!opts) return; // older pi without structured options — leave prompt alone

    // Respect an explicit user override (SYSTEM.md / --system-prompt): pi
    // took the customPrompt branch, so the "fixed parts" aren't pi's default
    // anyway. Don't double-process.
    if (opts.customPrompt) return;

    return { systemPrompt: buildPrompt(opts) };
  });
}
