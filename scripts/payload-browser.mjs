#!/usr/bin/env node
// payload-browser.mjs — a tiny zero-dependency TUI for browsing files written
// by the payload-exporter pi extension.
//
// Usage:
//   node scripts/payload-browser.mjs              # auto-detect a payloads dir
//   node scripts/payload-browser.mjs <dir>        # browse <dir> (the payloads/)
//   node scripts/payload-browser.mjs <profile>    # shortcut: ~/.pi/profiles/<profile>/payloads
//
// Keys (LIST):   ↑/↓ move · Enter open · e errors.jsonl · r reload · q quit
//      (DETAIL): ↑/↓ scroll · 1-5 jump to section · Esc/⌫/h back · q quit
//      (ERRORS): ↑/↓ move · Enter open source payload · Esc/⌫/h back · q quit
//
// The script only reads files; it never writes or deletes anything.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { stdout, stdin } from "node:process";

// ────────────────────────────── ANSI ──────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bg: "\x1b[48;5;238m",
};
const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
// pad a (possibly ANSI-colored) string to a visible width
const padVis = (s, n) => {
  const pad = Math.max(0, n - visibleLen(s));
  return s + " ".repeat(pad);
};
const c = (color, s) => `${C[color]}${s}${C.reset}`;
const width = () => stdout.columns || 100;
const height = () => stdout.rows || 40;

// ────────────────────────────── helpers ──────────────────────────────
function wrap(text, max, indent = 0) {
  if (!text) return [];
  const pad = " ".repeat(indent);
  const out = [];
  for (const rawLine of String(text).split("\n")) {
    let line = rawLine;
    if (line.length === 0) {
      out.push(pad);
      continue;
    }
    while (line.length > max) {
      out.push(pad + line.slice(0, max));
      line = line.slice(max);
    }
    out.push(pad + line);
  }
  return out;
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Parse `payload--DATE--TIME.ms--seq-NNNN--turn-N--model.json`
const NAME_RE =
  /payload--(\d{4}-\d{2}-\d{2})--(\d{2})(\d{2})(\d{2})\.(\d{3})--seq-(\d+)--turn-(\d+)--(.+)\.json$/;
function parseName(filename) {
  const m = filename.match(NAME_RE);
  if (!m) return null;
  return {
    date: m[1],
    time: `${m[2]}:${m[3]}:${m[4]}.${m[5]}`,
    seq: Number(m[6]),
    turn: Number(m[7]),
    model: m[8],
  };
}

// ────────────────────────────── data ──────────────────────────────
function listPayloadFiles(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.startsWith("payload--") && f.endsWith(".json"))
    .map((f) => {
      const meta = parseName(f) || {};
      const path = join(dir, f);
      let size = 0;
      let hasResp = false;
      try {
        size = statSync(path).size;
        const data = JSON.parse(readFileSync(path, "utf8"));
        hasResp = !!data.response;
      } catch {}
      return { file: f, path, size, hasResp, ...meta };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function readPayload(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { __error: String(e) };
  }
}

function readErrors(dir) {
  const p = join(dir, "errors.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return { i, ...JSON.parse(line) };
      } catch {
        return { i, raw: line };
      }
    });
}

function detectDir(arg) {
  if (arg) {
    const profileDir = join(homedir(), ".pi/profiles", arg, "payloads");
    if (existsSync(profileDir)) return profileDir;
    if (existsSync(arg)) return arg;
    throw new Error(`Directory not found: ${arg}`);
  }
  if (process.env.PI_CODING_AGENT_DIR) {
    const d = join(process.env.PI_CODING_AGENT_DIR, "payloads");
    if (existsSync(d)) return d;
  }
  const base = join(homedir(), ".pi");
  const candidates = [];
  const agentDir = join(base, "agent/payloads");
  if (existsSync(agentDir)) candidates.push(agentDir);
  try {
    for (const sub of readdirSync(join(base, "profiles"), { withFileTypes: true })) {
      if (sub.isDirectory()) {
        const d = join(base, "profiles", sub.name, "payloads");
        if (existsSync(d)) candidates.push(d);
      }
    }
  } catch {}
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    let best = candidates[0];
    let bestN = -1;
    for (const d of candidates) {
      const n = listPayloadFiles(d).length;
      if (n > bestN) {
        bestN = n;
        best = d;
      }
    }
    return best;
  }
  throw new Error("No payloads dir found. Pass one explicitly: payload-browser.mjs <dir>");
}

// ──────────────────────────── rendering ────────────────────────────
function renderScalar(v) {
  if (typeof v === "string") return c("yellow", v);
  if (typeof v === "number") return c("blue", String(v));
  if (typeof v === "boolean") return c("magenta", String(v));
  if (v === null) return c("gray", "null");
  return c("cyan", JSON.stringify(v));
}

function kv(label, value, indent = 2) {
  const pad = " ".repeat(indent);
  if (value === undefined || value === null)
    return [`${pad}${c("gray", label.padEnd(14))} ${c("gray", "—")}`];
  return [`${pad}${c("gray", label.padEnd(14))} ${renderScalar(value)}`];
}

const SECTION_RE = /═══ (.+) ═══/;
function section(title) {
  return `${C.cyan}${C.bold}═══ ${title} ═══${C.reset}`;
}

function buildDetail(payload) {
  const max = width() - 4;
  const lines = [];
  if (payload.__error) {
    lines.push(c("red", `error reading file: ${payload.__error}`));
    return lines;
  }

  // METADATA
  lines.push(section("METADATA"));
  lines.push(...kv("savedAt", payload.savedAt));
  lines.push(...kv("turnIndex", payload.turnIndex));
  lines.push(...kv("model", payload.model?.id));
  lines.push(...kv("provider", payload.model?.provider));
  lines.push(...kv("has response", payload.response ? "yes" : "no"));
  lines.push("");

  // MESSAGES
  const messages = payload.payload?.messages ?? [];
  lines.push(section(`MESSAGES (${messages.length})`));
  messages.forEach((msg, i) => {
    const role = msg.role ?? "?";
    const roleColor =
      role === "system"
        ? "magenta"
        : role === "user"
          ? "green"
          : role === "assistant"
            ? "cyan"
            : "yellow";
    lines.push(`  ${c("bold", `[${i}]`)} ${c(roleColor, role)}`);
    const content = msg.content;
    if (typeof content === "string") {
      lines.push(...wrap(content, max - 4, 4));
    } else if (Array.isArray(content)) {
      content.forEach((block) => {
        const type = block?.type ?? "?";
        lines.push(
          `    ${c("gray", "·")} ${c("blue", type)}${block.id ? c("gray", " " + block.id) : ""}`,
        );
        if (type === "text" && typeof block.text === "string") {
          lines.push(...wrap(block.text, max - 6, 6));
        } else if (type === "tool_use" || type === "functionCall") {
          lines.push(...kv("name", block.name ?? block.function?.name, 6));
          const input = block.input ?? block.function?.arguments ?? block.arguments;
          if (input !== undefined) {
            lines.push(`      ${c("gray", "input:")}`);
            lines.push(
              ...wrap(
                typeof input === "string" ? input : JSON.stringify(input, null, 2),
                max - 8,
                8,
              ),
            );
          }
        } else if (type === "tool_result" || type === "functionCallOutput" || type === "output") {
          const out = block.content ?? block.output;
          lines.push(...kv("toolUseId", block.tool_use_id ?? block.toolCallId ?? block.call_id, 6));
          if (typeof out === "string") lines.push(...wrap(out, max - 6, 6));
          else if (Array.isArray(out)) {
            out.forEach((part) => {
              if (part?.type === "text") lines.push(...wrap(part.text, max - 6, 6));
              else lines.push(...wrap(JSON.stringify(part, null, 2), max - 6, 6));
            });
          } else if (out !== undefined) {
            lines.push(...wrap(JSON.stringify(out, null, 2), max - 6, 6));
          }
        } else if (type === "thinking" || type === "reasoning") {
          const t = block.thinking ?? block.reasoning ?? block.text;
          lines.push(...wrap(String(t ?? ""), max - 6, 6));
        } else {
          lines.push(...wrap(JSON.stringify(block, null, 2), max - 6, 6));
        }
      });
    } else if (content !== undefined) {
      lines.push(...wrap(JSON.stringify(content, null, 2), max - 4, 4));
    }
    if (msg.tool_calls || msg.toolCalls) {
      const calls = msg.tool_calls ?? msg.toolCalls;
      lines.push(`    ${c("gray", "tool_calls:")}`);
      calls.forEach((tc, ci) => {
        lines.push(
          `      ${c("bold", `[${ci}]`)} ${c("blue", tc.function?.name ?? tc.name ?? "?")}`,
        );
        const args = tc.function?.arguments ?? tc.arguments;
        lines.push(
          ...wrap(typeof args === "string" ? args : JSON.stringify(args, null, 2), max - 8, 8),
        );
      });
    }
    lines.push("");
  });

  // TOOLS
  const tools = payload.payload?.tools ?? [];
  lines.push(section(`TOOLS (${tools.length})`));
  tools.forEach((tool, i) => {
    const fn = tool.function ?? tool;
    const name = fn.name ?? tool.name ?? "?";
    const desc = fn.description ?? tool.description ?? "";
    lines.push(
      `  ${c("bold", `[${i}]`)} ${c("green", name)} ${c("gray", truncate(desc, max - 8 - name.length))}`,
    );
  });
  lines.push("");

  // MISC payload fields
  const known = new Set(["model", "messages", "tools"]);
  const misc = Object.entries(payload.payload ?? {}).filter(([k]) => !known.has(k));
  if (misc.length) {
    lines.push(section("OTHER PAYLOAD FIELDS"));
    for (const [k, v] of misc) {
      if (typeof v === "object" && v !== null) {
        lines.push(`  ${c("gray", k + ":")}`);
        lines.push(...wrap(JSON.stringify(v, null, 2), max - 4, 4));
      } else {
        lines.push(...kv(k, v));
      }
    }
    lines.push("");
  }

  // RESPONSE
  const r = payload.response;
  lines.push(section("RESPONSE"));
  if (!r) {
    lines.push(`  ${c("gray", "(no response recorded — request-only dump)")}`);
  } else {
    lines.push(...kv("stopReason", r.stopReason));
    lines.push(...kv("model", r.model));
    lines.push(...kv("responseId", r.responseId));
    lines.push(...kv("provider", r.provider));
    if (r.timestamp) lines.push(...kv("timestamp", r.timestamp));
    if (r.usage) {
      lines.push(`  ${c("gray", "usage:")}`);
      const u = r.usage;
      for (const k of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "cacheWrite1h",
        "reasoning",
        "totalTokens",
      ]) {
        if (u[k] !== undefined) lines.push(...kv(k, u[k], 4));
      }
    }
    if (r.cost) lines.push(...kv("cost", r.cost));
    if (r.errorMessage) lines.push(...kv("errorMessage", r.errorMessage));
    if (r.textPreview) {
      lines.push(`  ${c("gray", "preview:")}`);
      lines.push(...wrap(r.textPreview, max - 4, 4));
    }
  }
  return lines;
}

// ────────────────────────────── TUI ──────────────────────────────
class TUI {
  constructor(dir) {
    this.dir = dir;
    this.mode = "list"; // list | detail | errors
    this.files = listPayloadFiles(dir);
    this.errors = readErrors(dir);
    this.cursor = 0;
    this.scroll = 0;
    this.detailLines = [];
    this.sectionStarts = [];
    this.payloadCache = new Map();
    this.currentPath = null;
  }

  reload() {
    this.files = listPayloadFiles(this.dir);
    this.errors = readErrors(this.dir);
    this.cursor = 0;
    this.scroll = 0;
    this.render();
  }

  async start() {
    if (this.files.length === 0 && this.errors.length === 0) {
      console.error(`No payload files or errors.jsonl found in ${this.dir}`);
      process.exit(1);
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdout.write(C.reset);
    stdout.on("resize", () => this.render());
    stdin.on("data", (d) => this.onKey(d));
    this.render();
  }

  quit() {
    stdout.write(C.reset);
    stdout.cursorTo(0, height() - 1);
    stdout.clearLine(0);
    stdin.setRawMode(false);
    stdin.pause();
    process.exit(0);
  }

  indexSections() {
    this.sectionStarts = [];
    this.detailLines.forEach((line, i) => {
      if (SECTION_RE.test(line)) this.sectionStarts.push(i);
    });
  }

  getPayload(path) {
    if (!this.payloadCache.has(path)) {
      this.payloadCache.set(path, readPayload(path));
    }
    return this.payloadCache.get(path);
  }

  openDetail(path) {
    const payload = this.getPayload(path);
    this.currentPath = path;
    this.detailLines = buildDetail(payload);
    this.indexSections();
    this.scroll = 0;
    this.mode = "detail";
    this.render();
  }

  // Clamp scroll so the cursor stays visible in list/error modes.
  clampListScroll(items) {
    const h = this.bodyHeight();
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + h) this.scroll = this.cursor - h + 1;
    if (items.length <= h) this.scroll = 0;
  }

  clampDetailScroll() {
    const h = this.bodyHeight();
    const max = Math.max(0, this.detailLines.length - h);
    if (this.scroll > max) this.scroll = max;
    if (this.scroll < 0) this.scroll = 0;
  }

  bodyHeight() {
    return Math.max(1, height() - 2); // header + footer
  }

  // ── key handling ──
  onKey(d) {
    if (d === "q" || d === "\x03") return this.quit();

    if (this.mode === "list") return this.onListKey(d);
    if (this.mode === "detail") return this.onDetailKey(d);
    if (this.mode === "errors") return this.onErrorsKey(d);
  }

  onListKey(d) {
    const n = this.files.length;
    if (n === 0) {
      if (d === "e" && this.errors.length) {
        this.mode = "errors";
        this.cursor = 0;
        this.scroll = 0;
        this.render();
      }
      return;
    }
    if (d === "\u001b[A" || d === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (d === "\u001b[B" || d === "j") this.cursor = Math.min(n - 1, this.cursor + 1);
    else if (d === "\u001b[5~")
      this.cursor = Math.max(0, this.cursor - 10); // PgUp
    else if (d === "\u001b[6~")
      this.cursor = Math.min(n - 1, this.cursor + 10); // PgDn
    else if (d === "g") this.cursor = 0;
    else if (d === "G") this.cursor = n - 1;
    else if (d === "\r" || d === "\n" || d === "l" || d === "\u001b[C") {
      this.openDetail(this.files[this.cursor].path);
      return;
    } else if (d === "e") {
      if (!this.errors.length) return;
      this.mode = "errors";
      this.cursor = 0;
      this.scroll = 0;
      this.render();
      return;
    } else if (d === "r") {
      this.reload();
      return;
    } else {
      return;
    }
    this.clampListScroll(this.files);
    this.render();
  }

  onDetailKey(d) {
    const h = this.bodyHeight();
    const max = Math.max(0, this.detailLines.length - h);
    if (d === "\u001b[A" || d === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (d === "\u001b[B" || d === "j") this.scroll = Math.min(max, this.scroll + 1);
    else if (d === "\u001b[5~")
      this.scroll = Math.max(0, this.scroll - h); // PgUp
    else if (d === "\u001b[6~")
      this.scroll = Math.min(max, this.scroll + h); // PgDn
    else if (d === "g") this.scroll = 0;
    else if (d === "G") this.scroll = max;
    else if (d === "\u001b" || d === "\u007f" || d === "h" || d === "\u001b[D") {
      // back
      this.mode = "list";
      this.scroll = 0;
      this.clampListScroll(this.files);
      this.render();
      return;
    } else if (d >= "1" && d <= "9") {
      const idx = Number(d) - 1;
      if (idx < this.sectionStarts.length) {
        this.scroll = this.sectionStarts[idx];
        this.clampDetailScroll();
      }
    } else {
      return;
    }
    this.clampDetailScroll();
    this.render();
  }

  onErrorsKey(d) {
    const n = this.errors.length;
    if (n === 0) {
      if (d === "\u001b" || d === "\u007f" || d === "h") {
        this.mode = "list";
        this.cursor = 0;
        this.scroll = 0;
        this.render();
      }
      return;
    }
    if (d === "\u001b[A" || d === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (d === "\u001b[B" || d === "j") this.cursor = Math.min(n - 1, this.cursor + 1);
    else if (d === "\u001b[5~") this.cursor = Math.max(0, this.cursor - 10);
    else if (d === "\u001b[6~") this.cursor = Math.min(n - 1, this.cursor + 10);
    else if (d === "g") this.cursor = 0;
    else if (d === "G") this.cursor = n - 1;
    else if (d === "\u001b" || d === "\u007f" || d === "h" || d === "\u001b[D") {
      this.mode = "list";
      this.cursor = 0;
      this.scroll = 0;
      this.clampListScroll(this.files);
      this.render();
      return;
    } else if (d === "\r" || d === "\n" || d === "l" || d === "\u001b[C") {
      const e = this.errors[this.cursor];
      if (e?.file) {
        const path = join(this.dir, e.file);
        if (existsSync(path)) {
          this.openDetail(path);
          return;
        }
      }
      return;
    } else {
      return;
    }
    this.clampListScroll(this.errors);
    this.render();
  }

  // ── rendering ──
  render() {
    if (this.mode === "list") this.renderList();
    else if (this.mode === "detail") this.renderDetail();
    else if (this.mode === "errors") this.renderErrors();
  }

  writeScreen(header, bodyLines, footer) {
    const h = height();
    const bodyH = h - 2;
    const visible = bodyLines.slice(0, bodyH);
    stdout.write(C.reset);
    stdout.cursorTo(0, 0);
    stdout.clearScreenDown();
    stdout.write(header + "\n");
    for (const line of visible) {
      stdout.write((line ?? "") + "\n");
    }
    // pad to footer row
    for (let i = visible.length; i < bodyH; i++) stdout.write("\n");
    stdout.write(footer);
  }

  renderList() {
    const w = width();
    const title = ` payload-browser — ${this.dir} `;
    const header =
      c("cyan", C.bold + "┌" + "─".repeat(Math.max(0, w - title.length - 2)) + "┐" + C.reset) +
      "\n" +
      c("cyan", "│") +
      c("bold", title) +
      c("cyan", "│") +
      C.reset;
    void header;
    const modelW = Math.max(10, w - 60);
    const headLine =
      ` ${c("gray", "seq  turn  time          ")} ` +
      `${c("gray", "model".padEnd(modelW))} ` +
      `${c("gray", "resp  size")}`;
    const body = [headLine, c("gray", "─".repeat(w))];
    this.clampListScroll(this.files);
    const h = this.bodyHeight();
    const start = this.scroll;
    const end = Math.min(this.files.length, start + h - 2);
    for (let i = start; i < end; i++) {
      const f = this.files[i];
      const sel = i === this.cursor;
      const modelW = Math.max(10, w - 60);
      const seq = String(f.seq ?? "?").padStart(4);
      const time = (f.time ?? f.date ?? "").padEnd(13);
      const model = truncate(f.model ?? "?", modelW).padEnd(modelW);
      const resp = f.hasResp ? c("green", "✓") : c("dim", "·");
      const size = fmtBytes(f.size).padStart(7);
      const row =
        ` ${c("gray", seq)}  t${f.turn ?? "?"}  ${c("blue", time)} ` +
        `${c("green", model)} ` +
        `${resp}    ${c("gray", size)}`;
      body.push(sel ? c("bg", row) : row);
    }
    const errHint = this.errors.length
      ? c("yellow", `${this.errors.length} errors`)
      : c("gray", "no errors");
    const footer =
      ` ${c("gray", "↑/↓ move · Enter open · e errors · r reload · q quit")}`.padEnd(w - 30) +
      ` ${errHint}`;
    this.writeScreen(` ${c("bold", "payload-browser")}  ${c("gray", this.dir)}\n`, body, footer);
  }

  renderDetail() {
    this.clampDetailScroll();
    const h = this.bodyHeight();
    const visible = this.detailLines.slice(this.scroll, this.scroll + h);
    const name = this.currentPath ? this.currentPath.split(/[/\\]/).pop() : "";
    const header = ` ${c("bold", "payload-browser")}  ${c("green", name)}  ${c("gray", `(scroll ${this.scroll + 1}/${this.detailLines.length})`)}\n`;
    const footer = ` ${c("gray", "↑/↓ scroll · 1-5 jump section · Esc/h back · q quit")}`;
    this.writeScreen(header, visible, footer);
  }

  renderErrors() {
    const w = width();
    const body = [`${c("gray", " #   src       pattern")}`, c("gray", "─".repeat(w))];
    this.clampListScroll(this.errors);
    const h = this.bodyHeight();
    const start = this.scroll;
    const end = Math.min(this.errors.length, start + h - 2);
    for (let i = start; i < end; i++) {
      const e = this.errors[i];
      const first = e.matches?.[0];
      const label = first
        ? `${first.pattern}${first.toolName ? " · " + first.toolName : ""}`
        : e.raw
          ? "(unparseable)"
          : "?";
      const snipW = Math.max(10, w - 40);
      const snippet = truncate(first?.snippet ?? "", snipW);
      const idx = String(e.i).padStart(3);
      const src = (e.source ?? "?").padEnd(8);
      const lbl = truncate(label, 22).padEnd(22);
      const row =
        ` ${c("gray", idx)}  ${c("magenta", src)} ` + `${c("yellow", lbl)}  ${c("gray", snippet)}`;
      body.push(i === this.cursor ? c("bg", row) : row);
    }
    const footer = ` ${c("gray", "↑/↓ move · Enter open source payload · Esc/h back · q quit")}`;
    const header = ` ${c("bold", "payload-browser")}  ${c("yellow", "errors.jsonl")}  ${c("gray", this.dir)}\n`;
    this.writeScreen(header, body, footer);
  }
}

// ────────────────────────────── main ──────────────────────────────
const argv = process.argv.slice(2);
const printPath = argv.includes("--path") || argv.includes("-p");
const positional = argv.find((a) => !a.startsWith("-"));
let dir;
try {
  dir = detectDir(positional);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (printPath) {
  // just print the resolved dir and exit
  console.log(dir);
  process.exit(0);
}
const tui = new TUI(dir);
tui.start();
