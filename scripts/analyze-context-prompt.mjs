#!/usr/bin/env node
// analyze-context-prompt: attribute the composed system prompt to its
// resources — what each of the profile's prompt chars actually IS.
//
// Input: a context-measure prompt dump (extensions/context-measure with
// PI_CONTEXT_MEASURE_DEBUG=1 appends one `# ==== request N · … ====` block
// per request to `<configDir>/context-measure-prompt.txt`). By default the
// NEWEST dump found across profile dirs is analyzed, latest request block
// first. Args:
//
//   node scripts/analyze-context-prompt.mjs                 # latest dump, latest block
//   node scripts/analyze-context-prompt.mjs <file>          # explicit dump file
//   node scripts/analyze-context-prompt.mjs --request 3      # Nth request block
//   node scripts/analyze-context-prompt.mjs --all            # list every block (hash drift check)
//
// Method: the prompt is segmented by its known structural markers, in order —
// the `<project_context>`/`<project_instructions path>` wrapper pi builds
// from AGENTS.md files, the `<available_skills>` block (one `<skill>` entry
// per skill), the trailing cwd line, and (stock pi ≥0.87) the `<tools>` /
// `<rules>` / `<docs>` / `<cwd>` section tags. Text outside any marker is
// reported as `pi core prompt` (before the first marker) or as explicit
// `unattributed remainder` gaps, so the table always reconciles to the
// prompt's total character count — the number the context-budget panel
// reports as systemPromptChars. Characters, not tokens; per-request constant
// cost, paid whether or not the resource is ever used.
//
// For A/B attribution of a single resource (e.g. what one skill costs):
// measure → toggle it in /settings → re-measure with PI_CONTEXT_MEASURE_DEBUG=1
// and diff two dumps (`--all` shows the hash change; this table shows which
// row shrank).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith("--"));
const requestArg = args.find((a) => a.startsWith("--request="));
const listAll = args.includes("--all");

/** Dump-file discovery: newest context-measure-prompt.txt under the profile
 *  dirs and the base agent dir (same roots the recorder writes to). */
function findLatestDump() {
  const candidates = [];
  const roots = [
    path.join(os.homedir(), ".pi", "profiles"),
    path.join(os.homedir(), ".pi", "agent"),
  ];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "context-measure-prompt.txt");
      try {
        candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
      } catch {
        /* no dump in this profile */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file ?? null;
}

/** Parse the dump into request blocks: {requestId, at, model, sha, text}. */
function parseBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  const header = /^# ==== request (\d+) · (.+?) · (\S+) · prompt sha256:([0-9a-f]+) =+\s*$/;
  for (const line of lines) {
    const m = line.match(header);
    if (m) {
      current = { requestId: Number(m[1]), at: m[2], model: m[3], sha: m[4], text: "" };
      blocks.push(current);
    } else if (current) {
      current.text += line + "\n";
    }
  }
  for (const block of blocks) block.text = block.text.replace(/\n+$/, "");
  return blocks;
}

/** Attribution segments: each consumes [start, end) of the prompt text. */
function attribute(prompt) {
  const rows = [];
  let whitespace = 0;
  let tagOverhead = 0;
  const add = (resource, segment) => {
    if (segment == null) return;
    if (segment.trim().length === 0) {
      whitespace += segment.length;
    } else {
      rows.push({ resource, chars: segment.length });
    }
  };
  const addCore = (segment) => {
    // The leading segment is the core prompt: pi's fixed instructions,
    // the "Available tools:" list (per-tool prompt lines), the "Guidelines:"
    // section (fixed + tool-contributed rules), and — after the last bullet —
    // any --append-system-prompt text (e.g. APPEND_SYSTEM.md). Partitions its
    // input exactly, so the reconciliation check stays exact.
    if (segment == null) return;
    if (segment.trim().length === 0) {
      whitespace += segment.length;
      return;
    }
    const toolsAt = segment.indexOf("Available tools:");
    const guidelinesAt = toolsAt >= 0 ? segment.indexOf("Guidelines:", toolsAt) : -1;
    if (toolsAt < 0 || guidelinesAt < 0) {
      rows.push({
        resource: "pi core prompt (fixed instructions + sections)",
        chars: segment.length,
      });
      return;
    }
    rows.push({ resource: "pi core prompt (fixed instructions)", chars: toolsAt });
    // Tools list: per-line attribution of "- name: snippet" lines.
    const toolsSection = segment.slice(toolsAt, guidelinesAt);
    const perTool = new Map();
    let toolsOther = 0;
    const toolLines = toolsSection.split("\n");
    for (let i = 0; i < toolLines.length; i++) {
      const line = toolLines[i] + (i < toolLines.length - 1 ? "\n" : "");
      const m = line.match(/^- (\S+): /);
      if (m) perTool.set(m[1], (perTool.get(m[1]) ?? 0) + line.length);
      else toolsOther += line.length;
    }
    rows.push({ resource: "tools list — heading/other", chars: toolsOther });
    for (const [name, chars] of [...perTool.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      rows.push({ resource: `tools list — ${name}`, chars });
    }
    // Guidelines: the rules are one contiguous run of "- " bullets; the
    // first non-bullet, non-blank line ends the section (later text — e.g.
    // the pi-development pointer or APPEND_SYSTEM.md — is --append-system-prompt
    // content even when it carries bullets of its own).
    const guidelines = segment.slice(guidelinesAt);
    const guidelineLines = guidelines.split("\n");
    let offset = 0;
    let rulesEnd = -1;
    for (let i = 0; i < guidelineLines.length; i++) {
      const line = guidelineLines[i];
      const isBlank = line.trim().length === 0;
      if (!isBlank && !line.startsWith("- ")) {
        if (i === 0) {
          offset += line.length + 1;
          continue; // the "Guidelines:" heading itself
        }
        rulesEnd = offset;
        break;
      }
      offset += line.length + 1; // +1 for the split-off newline
    }
    if (rulesEnd < 0) rulesEnd = guidelines.length;
    rows.push({ resource: "guidelines (fixed + tool-contributed rules)", chars: rulesEnd });
    const appendRest = guidelines.slice(rulesEnd);
    if (appendRest.trim().length > 0) {
      rows.push({
        resource: "append (--append-system-prompt / APPEND_SYSTEM.md)",
        chars: appendRest.length,
      });
    } else {
      whitespace += appendRest.length;
    }
  };

  // Marker positions, in order of appearance. Each finds its own span.
  const indexOf = (re, from = 0) => {
    const m = prompt.slice(from).match(re);
    return m ? { start: from + m.index, end: from + m.index + m[0].length, match: m } : null;
  };

  let cursor = 0;
  const take = (endExclusive) => {
    const segment = prompt.slice(cursor, endExclusive);
    cursor = endExclusive;
    return segment;
  };
  // Markup tags (<project_context>, <skill>…) are real prompt chars pi pays
  // for; attribute them to their own bucket so content rows stay pure.
  const skipTags = (endExclusive) => {
    tagOverhead += take(endExclusive).length;
  };

  const projectOpen = indexOf(/<project_context>/);
  if (projectOpen) {
    addCore(take(projectOpen.start));
    skipTags(projectOpen.end);
    // Per <project_instructions path=...> block until </project_context>.
    const close = indexOf(/<\/project_context>/, cursor);
    const contextEnd = close ? close.start : prompt.length;
    const fileRe = /<project_instructions path="([^"]*)">/;
    while (cursor < contextEnd) {
      const open = indexOf(fileRe, cursor);
      if (!open || open.start >= contextEnd) break;
      add("project_context header/wrapper", take(open.start));
      skipTags(open.end);
      const inner = indexOf(/<\/project_instructions>/, cursor);
      const contentEnd = inner
        ? inner.start >= contextEnd
          ? contextEnd
          : inner.start
        : contextEnd;
      add(`AGENTS guidance — ${open.match[1]}`, take(contentEnd));
      if (inner && inner.start < contextEnd) skipTags(inner.end);
    }
    if (cursor < contextEnd) add("project_context header/wrapper", take(contextEnd));
    if (close) skipTags(close.end);
  }

  // Skills block: intro sentence(s) + <available_skills> with <skill> entries.
  const skillsIntro = indexOf(/The following skills provide specialized instructions/, cursor);
  const skillsOpen = indexOf(/<available_skills>/, cursor);
  if (skillsIntro && (!skillsOpen || skillsIntro.start < skillsOpen.start)) {
    // With a project_context the gap is --append-system-prompt text; without
    // one (stock pi <tools>/<rules>/<docs> shape) it is the core prompt itself.
    const core = take(skillsIntro.start);
    if (projectOpen) add("append (--append-system-prompt / APPEND_SYSTEM.md)", core);
    else addCore(core);
  }
  if (skillsOpen && skillsOpen.start >= cursor) {
    add("skills list — intro", take(skillsOpen.start));
    skipTags(skillsOpen.end);
    const close = indexOf(/<\/available_skills>/, cursor);
    const skillsEnd = close ? close.start : prompt.length;
    while (cursor < skillsEnd) {
      const open = indexOf(/<skill>/, cursor);
      if (!open || open.start >= skillsEnd) break;
      add("skills list — spacing/unparsed", take(open.start));
      skipTags(open.end);
      const name = indexOf(/<name>([^<]*)<\/name>/, cursor);
      const inner = indexOf(/<\/skill>/, cursor);
      const skillEnd = inner ? (inner.start >= skillsEnd ? skillsEnd : inner.start) : skillsEnd;
      const label =
        name && name.start < skillEnd ? `skill — ${name.match[1]}` : "skill — (unnamed)";
      add(label, take(skillEnd));
      if (inner && inner.start < skillsEnd) skipTags(inner.end);
    }
    if (close) skipTags(close.end);
  }

  // Trailing cwd line (our system-prompt extension) or <cwd> section (stock).
  const cwd = indexOf(/Current working directory: /, cursor);
  if (cwd && cwd.start >= cursor) {
    add("unattributed remainder", take(cwd.start));
    add("cwd", take(prompt.length));
  }
  add("unattributed remainder", take(prompt.length));
  if (tagOverhead > 0) {
    rows.push({ resource: "markup tags (project_context / skill wrappers)", chars: tagOverhead });
  }
  if (whitespace > 0) {
    rows.push({ resource: "layout whitespace (blank lines between sections)", chars: whitespace });
  }
  return rows;
}

const file = fileArg || findLatestDump();
if (!file) {
  console.error(
    "No context-measure-prompt.txt found under ~/.pi/profiles/*/ or ~/.pi/agent/.\n" +
      "Record one first: PI_CONTEXT_MEASURE_DEBUG=1 in the session env, switch the\n" +
      "model to measure/measure-model once (or run npm run measure:context with the\n" +
      "env set), then re-run this script.",
  );
  process.exit(1);
}
let blocks;
try {
  blocks = parseBlocks(fs.readFileSync(file, "utf8"));
} catch (err) {
  console.error(`Cannot read ${file}: ${err.message}`);
  process.exit(1);
}
if (blocks.length === 0) {
  console.error(
    `No request blocks found in ${file} (expected "# ==== request N · … ====" headers).`,
  );
  process.exit(1);
}

console.log(`Dump: ${file}`);
console.log(`Request blocks: ${blocks.length}\n`);

if (listAll) {
  for (const b of blocks) {
    console.log(
      `request ${b.requestId} · ${b.at} · ${b.model} · prompt sha256:${b.sha} · ${b.text.length} chars`,
    );
  }
  process.exit(0);
}

const wanted = requestArg
  ? blocks.find((b) => b.requestId === Number(requestArg.slice(10)))
  : blocks[blocks.length - 1];
if (!wanted) {
  console.error(`No request ${requestArg ? requestArg.slice(10) : ""} in ${file}.`);
  process.exit(1);
}

console.log(
  `Analyzing request ${wanted.requestId} · ${wanted.at} · ${wanted.model} · prompt sha256:${wanted.sha}\n`,
);
const rows = attribute(wanted.text);
const total = wanted.text.length;
const width = Math.max(...rows.map((r) => r.resource.length), 40);
for (const row of rows) {
  const pct = ((row.chars / total) * 100).toFixed(1);
  console.log(
    `${row.resource.padEnd(width)} ${row.chars.toLocaleString("en-US").padStart(7)}  ${pct.padStart(5)}%`,
  );
}
const sum = rows.reduce((acc, r) => acc + r.chars, 0);
console.log("-".repeat(width + 16));
console.log(`${"total".padEnd(width)} ${total.toLocaleString("en-US").padStart(7)}  100.0%`);
if (sum !== total) {
  console.error(`\nRECONCILIATION FAILED: segments sum to ${sum}, prompt is ${total}.`);
  process.exit(1);
}
console.log(
  `\nMethod: segments are cut at the prompt's structural markers (in order): the\n` +
    `<project_context>/<project_instructions path> wrapper pi builds from AGENTS.md\n` +
    `files, the <available_skills> block (one entry per skill), the trailing cwd\n` +
    `line. Text before the first marker is pi's core prompt; gaps are reported as\n` +
    `unattributed remainder so the table always reconciles to the total.\n` +
    `Characters, not tokens — the per-request constant cost the context-budget\n` +
    `panel reports as systemPromptChars.`,
);
