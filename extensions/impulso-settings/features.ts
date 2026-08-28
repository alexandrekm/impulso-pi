// Declarative feature registry for the /impulso settings page.
//
// Each feature is a single row in the tabbed settings UI. Add a new entry
// here and it shows up automatically — no UI code to touch. Three kinds:
//
//   package    — an npm:/git: entry in settings.json `packages[]`. Toggled
//                by flipping the entry between its string form (enabled)
//                and `{ source, autoload: false }` (disabled, pi skips it).
//   local      — a local extension under extensions/. Toggled via the
//                impulso-settings manifest; the extension's own factory
//                guards on isFeatureEnabled(id) (see feature-flag.ts).
//   pi-setting — a key in settings.json (booleans cycle on/off; enums cycle
//                their declared values). Only keys NOT managed by
//                profiles.jsonc `settings` are safe here — install.sh would
//                otherwise reset profiles-managed keys on every sync.
//
// Changes persist immediately and the UI prompts `/reload` to apply them.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFeatureEnabled, setFeatureEnabled } from "./feature-flag.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || dirname(dirname(MODULE_DIR));
const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");

// ─────────────────────────────────────────────────────────────────────────
// Tabs & feature schema
// ─────────────────────────────────────────────────────────────────────────

export type FeatureKind = "package" | "local" | "pi-setting" | "launch" | "config";

export interface Feature {
  id: string;
  /** Tab id this feature belongs to (see TABS). */
  tab: string;
  /** Section heading within the tab. */
  group: string;
  label: string;
  description: string;
  kind: FeatureKind;
  /** For `package`: the npm:/git: spec as it appears in packages[]. */
  spec?: string;
  /** For `pi-setting`: dotted settings.json key. */
  key?: string;
  /** For `pi-setting` enum: the cycle options. Booleans use ["on","off"]. */
  values?: string[];
  /** Default value when the settings.json key is absent (pi-setting). */
  defaultValue?: string;
  /** For `launch`: the slash command to dispatch on activate (e.g. "/vision-handoff"). Must be an extension command, not a pi built-in. */
  command?: string;
  /** For `launch`: returns the display value shown on the row (e.g. the configured model ref). */
  display?: () => string;
  /** For `config`: a JSON file name relative to <configDir> (e.g. "pi-btw.json").
   *  The feature reads/writes a top-level key in that file. */
  configFile?: string;
  /** For `config`: whether the value is picked via a searchable overlay
   *  (large/dynamic lists like models) rather than cycled in-row. */
  picker?: boolean;
  /** For `pi-setting` + `picker`: base dotted path of a composite
   *  `{ provider, id[, thinking] }` model object in settings.json. The picker
   *  yields a `provider/id` string that is split into the two sub-keys
   *  (and `""` clears provider/id while preserving `thinking`). */
  modelKey?: string;
}

export interface Tab {
  id: string;
  label: string;
}

export const TABS: Tab[] = [
  { id: "search", label: "Search" },
  { id: "obs", label: "Observability" },
  { id: "providers", label: "Providers" },
  { id: "tools", label: "Tools & Safety" },
  { id: "orca", label: "Orca & Misc" },
  { id: "pi", label: "Pi" },
];

export const FEATURES: Feature[] = [
  // ── Search ─────────────────────────────────────────────────────────────
  {
    id: "fff",
    tab: "search",
    group: "File search",
    label: "FFF file finder",
    description:
      "Rust-native, SIMD-accelerated find/grep (override mode). Replaces pi's built-in fd/rg. npm:@ff-labs/pi-fff.",
    kind: "package",
    spec: "npm:@ff-labs/pi-fff",
  },
  {
    id: "fff-env",
    tab: "search",
    group: "File search",
    label: "FFF env overrides",
    description:
      "Pins PI_FFF_MODE=override and FFF_ENABLE_HOME_SCAN=0 before FFF loads. Disable only if you want FFF defaults.",
    kind: "local",
  },
  {
    id: "websearch",
    tab: "search",
    group: "Web search",
    label: "Web search",
    description: "Web search providers/keys. npm:@alfonzjanfrithz/pi-websearch.",
    kind: "package",
    spec: "npm:@alfonzjanfrithz/pi-websearch",
  },
  {
    id: "search_docs",
    tab: "search",
    group: "Web search",
    label: "search_docs (KB)",
    description:
      "Query the team's internal docs Knowledge Base (Bedrock) before the web. Work-only. Needs KB_GATEWAY_URL + KB_GATEWAY_KEY.",
    kind: "local",
  },

  // ── Observability ──────────────────────────────────────────────────────
  {
    id: "dynamic-footer",
    tab: "obs",
    group: "Footer",
    label: "Dynamic footer",
    description:
      "Live observability footer: context gauge, TPS, tokens, cost, cache %, git branch, thinking level, quota bars. /obs dashboard.",
    kind: "local",
  },
  {
    id: "cache-graph",
    tab: "obs",
    group: "Footer",
    label: "Cache graph",
    description:
      "Per-turn / cumulative prompt+KV cache hit-rate overlay and CSV export. /cache commands. npm:pi-cache-graph.",
    kind: "package",
    spec: "npm:pi-cache-graph",
  },
  {
    id: "footer-settings",
    tab: "obs",
    group: "Footer",
    label: "Footer segments…",
    description:
      "Open the dynamic-footer segment settings (toggle metrics, context zones, presets). Runs /obs-settings.",
    kind: "launch",
    command: "/obs-settings",
    display: () => "open →",
  },
  {
    id: "cache-graph-open",
    tab: "obs",
    group: "Footer",
    label: "Cache graph…",
    description: "Open the cache hit-rate overlay and stats. Runs /cache.",
    kind: "launch",
    command: "/cache",
    display: () => "open →",
  },
  {
    id: "payload-exporter",
    tab: "obs",
    group: "Diagnostics",
    label: "Payload exporter",
    description:
      "Save every provider request payload + response under <configDir>/payloads/. /payload-exporter on|off|toggle|status.",
    kind: "local",
  },

  // ── Providers ──────────────────────────────────────────────────────────
  {
    id: "cursor",
    tab: "providers",
    group: "Cursor",
    label: "Cursor provider",
    description:
      "Cursor models (Claude/GPT/Gemini/Grok/Composer) as a pi provider. OAuth /login cursor, native HTTP/2 streaming. npm:@rahularya01/pi-cursor.",
    kind: "package",
    spec: "npm:@rahularya01/pi-cursor",
  },
  {
    id: "cursor-env",
    tab: "providers",
    group: "Cursor",
    label: "Cursor env overrides",
    description:
      "Pins fresh Cursor client version + chat endpoint before the provider loads. Disable only if you override via env yourself.",
    kind: "local",
  },
  {
    id: "litellm",
    tab: "providers",
    group: "LiteLLM",
    label: "LiteLLM proxy provider",
    description:
      "Self-hosted LiteLLM proxy as a pi provider. /login litellm, MCP tools, Skills Gateway. npm:pi-provider-litellm.",
    kind: "package",
    spec: "npm:pi-provider-litellm",
  },

  // ── Tools & Safety ─────────────────────────────────────────────────────
  {
    id: "ask-user-question",
    tab: "tools",
    group: "Tools",
    label: "ask-user-question",
    description: "Structured clarifying questions tool. npm:@juicesharp/rpiv-ask-user-question.",
    kind: "package",
    spec: "npm:@juicesharp/rpiv-ask-user-question",
  },
  {
    id: "vision-handoff",
    tab: "tools",
    group: "Tools",
    label: "Vision handoff",
    description:
      "Transparent image→text swap for non-vision models via a chosen describer. /vision-handoff. npm:pi-vision-handoff.",
    kind: "package",
    spec: "npm:pi-vision-handoff",
  },
  {
    id: "vision-handoff-model",
    tab: "tools",
    group: "Tools",
    label: "Vision describer model…",
    description:
      "Pick which vision-capable model describes images for text-only models, and toggle the describer's thinking. Runs /vision-handoff (opens the picker). Config: <configDir>/extensions/pi-vision-handoff.json.",
    kind: "launch",
    command: "/vision-handoff",
    display: () => {
      const cfg = readPackageConfig("pi-vision-handoff.json") as { visionModel?: string | null };
      return cfg.visionModel ? cfg.visionModel : "not set";
    },
  },
  {
    id: "hashline",
    tab: "tools",
    group: "Tools",
    label: "Hashline edit",
    description:
      "Hash-anchored read/edit: every line carries LINE#HASH so edits never land on the wrong line. npm:pi-hashline-edit.",
    kind: "package",
    spec: "npm:pi-hashline-edit",
  },
  {
    id: "pi-btw",
    tab: "tools",
    group: "pi-btw",
    label: "pi-btw side thread",
    description:
      "Ask side questions in a separate thread without derailing the main task. /btw <question> or /btw menu; Ctrl+R brings selected context back to the main editor. npm:@narumitw/pi-btw.",
    kind: "package",
    spec: "npm:@narumitw/pi-btw",
  },
  {
    id: "pi-btw-model",
    tab: "tools",
    group: "pi-btw",
    label: "Side-thread model",
    description:
      "Model that answers /btw side questions. 'Same as main thread' uses the session's current model+creds; pick a cheaper model (Haiku/Flash/mini) to keep side questions off the main budget. Written to <configDir>/pi-btw.json (read fresh each /btw, no /reload needed).",
    kind: "config",
    configFile: "pi-btw.json",
    key: "model",
    picker: true,
  },
  {
    id: "pi-btw-thinking",
    tab: "tools",
    group: "pi-btw",
    label: "Side thinking level",
    description:
      "Starting reasoning level for /btw side threads. 'Same as main thread' tracks the session level; a fixed level is clamped to the side model's capabilities. <configDir>/pi-btw.json.",
    kind: "config",
    configFile: "pi-btw.json",
    key: "thinkingLevel",
    values: ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "pi-btw-remember",
    tab: "tools",
    group: "pi-btw",
    label: "Remember thinking level",
    description:
      "When the side thinking level is fixed, persist in-thread Shift+Tab changes to pi-btw.json for next time. Defaults to on. No effect while 'Same as main thread' is selected.",
    kind: "config",
    configFile: "pi-btw.json",
    key: "rememberThinkingLevelChanges",
    defaultValue: "on",
  },
  {
    id: "command-guard",
    tab: "tools",
    group: "Safety",
    label: "Command guard",
    description: "Default-allow bash command-guard (ask/deny globs in command-guard.json).",
    kind: "local",
  },
  {
    id: "pi-themes",
    tab: "tools",
    group: "Appearance",
    label: "pi-themes",
    description: "Companion themes incl. catppuccin-mocha. git:github.com/sting8k/pi-themes.",
    kind: "package",
    spec: "git:github.com/sting8k/pi-themes",
  },
  {
    id: "border-on-user-messages",
    tab: "tools",
    group: "Appearance",
    label: "Border on user messages",
    description:
      "Draw a `┌─ You ─┐` box around every user message in the TUI transcript so your own messages stand out. TUI-only.",
    kind: "local",
  },
  {
    id: "border-on-tool-calls",
    tab: "tools",
    group: "Appearance",
    label: "Border on tool calls",
    description:
      "Draw a `┌─ <toolName> ─┐` box around every tool call in the TUI transcript so each invocation reads as a discrete framed block labeled with its name. TUI-only.",
    kind: "local",
  },

  // ── Modes ──────────────────────────────────────────────────────────────
  {
    id: "modes",
    tab: "tools",
    group: "Modes",
    label: "Skill modes (code / doc)",
    description:
      "Per-profile mode that gates which skills reach the system prompt. /mode code|doc|toggle; code = full dev workflow (jira, create-pr, commit), doc = Google Docs authoring + glean + datadog + gws skills (Docs/Sheets/Drive/Gmail, injected in doc mode). State in mode.json, applies next message. Work-only.",
    kind: "local",
  },
  // ── Orca & Misc ────────────────────────────────────────────────────────
  {
    id: "orca-integration",
    tab: "orca",
    group: "Orca",
    label: "Orca integration",
    description:
      "Orca dashboard status, prefill, and titlebar spinner. Inert outside an Orca-launched terminal (ORCA_* env unset).",
    kind: "local",
  },
  {
    id: "herdr",
    tab: "orca",
    group: "Orca",
    label: "herdr agent state",
    description:
      "Per-pane working/blocked/idle state to herdr over a unix socket. Inert without HERDR_* env.",
    kind: "local",
  },
  {
    id: "print-config-dir",
    tab: "orca",
    group: "Misc",
    label: "Print config dir",
    description:
      "Notifies the active pi config dir at startup so you can see which profile loaded.",
    kind: "local",
  },

  // ── System prompt ──────────────────────────────────────────────────────
  {
    id: "system-prompt",
    tab: "pi",
    group: "System prompt",
    label: "Custom fixed prompt",
    description:
      "Owns the fixed parts of pi's system prompt (intro, Pi-docs block) while keeping dynamic parts (tools, guidelines, context, skills, cwd). Edit extensions/system-prompt/system-prompt.ts.",
    kind: "local",
  },
  {
    id: "on-demand-skills",
    tab: "pi",
    group: "Input",
    label: "On-demand skills (keyword)",
    description:
      "Appends a skill pointer to your message only when it mentions configured keywords, so skills stay out of the always-on system prompt. Set disable-model-invocation: true on the skill + list it in extensions/on-demand-skills/config.json.",
    kind: "local",
  },

  // ── Pi built-in settings (safe subset — NOT managed by profiles.jsonc) ──
  {
    id: "pi-compaction",
    tab: "pi",
    group: "Context",
    label: "Auto-compaction",
    description: "Compact the context automatically as it approaches the model's window.",
    kind: "pi-setting",
    key: "compaction.enabled",
    defaultValue: "on",
  },
  {
    id: "pi-retry",
    tab: "pi",
    group: "Context",
    label: "Provider retry",
    description: "Retry failed provider requests with exponential backoff.",
    kind: "pi-setting",
    key: "retry.enabled",
    defaultValue: "on",
  },
  {
    id: "pi-cache-miss-notices",
    tab: "pi",
    group: "Context",
    label: "Cache-miss notices",
    description: "Show transcript notices for significant prompt-cache misses.",
    kind: "pi-setting",
    key: "showCacheMissNotices",
    defaultValue: "off",
  },

  // ── Observational memory ───────────────────────────────────────────────
  {
    id: "observational-memory",
    tab: "pi",
    group: "Observational memory",
    label: "Observational memory",
    description:
      "Continuously captures observations + distills reflections so long sessions survive compactions with less drift and faster compaction. /om:status, /om:view, recall tool. npm:pi-observational-memory.",
    kind: "package",
    spec: "npm:pi-observational-memory",
  },
  {
    id: "observational-memory-model",
    tab: "pi",
    group: "Observational memory",
    label: "Memory worker model…",
    description:
      "Model used for background observation/reflection work. 'Same as main thread' uses the session model; pick a cheaper/faster model (Haiku/Flash/mini/gemma) to keep memory work off the main budget. Written to settings.json observational-memory.model.{provider,id}.",
    kind: "pi-setting",
    key: "observational-memory.model",
    modelKey: "observational-memory.model",
    picker: true,
  },
  {
    id: "observational-memory-thinking",
    tab: "pi",
    group: "Observational memory",
    label: "Memory worker thinking",
    description:
      "Reasoning level for the memory worker model. 'Same as main thread' (key absent) uses the model's default. settings.json observational-memory.model.thinking.",
    kind: "pi-setting",
    key: "observational-memory.model.thinking",
    values: ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "observational-memory-passive",
    tab: "pi",
    group: "Observational memory",
    label: "Passive mode",
    description:
      "Disable proactive background observation/reflection/maintenance and the auto-compaction trigger. Memory work only happens on explicit /om:* commands. settings.json observational-memory.passive.",
    kind: "pi-setting",
    key: "observational-memory.passive",
    defaultValue: "off",
  },
  {
    id: "observational-memory-notices",
    tab: "pi",
    group: "Observational memory",
    label: "Worker notifications",
    description:
      "Show routine observer/reflector/dropper progress messages. Warnings/errors stay visible either way. settings.json observational-memory.showWorkerNotifications.",
    kind: "pi-setting",
    key: "observational-memory.showWorkerNotifications",
    defaultValue: "on",
  },
  {
    id: "observational-memory-compact-mode",
    tab: "pi",
    group: "Observational memory",
    label: "Compaction trigger mode",
    description:
      "calibrated: use compactAfterTokens (81k) directly. ratio: scale the threshold by the active model's context window (compactAfterTokensRatio, default 0.68) — better for large-context models. settings.json observational-memory.compactAfterTokensMode.",
    kind: "pi-setting",
    key: "observational-memory.compactAfterTokensMode",
    values: ["calibrated", "ratio"],
    defaultValue: "calibrated",
  },
  {
    id: "pi-skill-commands",
    tab: "pi",
    group: "Tasks",
    label: "Skill commands",
    description: "Register skills as /skill:<name> commands.",
    kind: "pi-setting",
    key: "enableSkillCommands",
    defaultValue: "on",
  },
  {
    id: "pi-quiet-startup",
    tab: "pi",
    group: "Display",
    label: "Quiet startup",
    description: "Suppress the startup banner / extensions list.",
    kind: "pi-setting",
    key: "quietStartup",
    defaultValue: "off",
  },
  {
    id: "pi-block-images",
    tab: "pi",
    group: "Display",
    label: "Block images",
    description: "Prevent all images from being sent to LLM providers.",
    kind: "pi-setting",
    key: "images.blockImages",
    defaultValue: "off",
  },
  {
    id: "pi-mermaid",
    tab: "pi",
    group: "Display",
    label: "Mermaid rendering",
    description: "How Mermaid diagrams render in the transcript.",
    kind: "pi-setting",
    key: "markdown.mermaid",
    values: ["streaming", "final", "off"],
    defaultValue: "streaming",
  },
];

/** Features for a tab, ordered by group declaration order. */
export function featuresForTab(tabId: string): Feature[] {
  const inTab = FEATURES.filter((f) => f.tab === tabId);
  const groupOrder: string[] = [];
  for (const f of inTab) {
    if (!groupOrder.includes(f.group)) groupOrder.push(f.group);
  }
  return inTab.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
}

/** Effective toggle values for a feature (the SettingsList `values` column). */
export function featureValues(f: Feature): string[] {
  if (f.kind === "pi-setting" && f.values) return f.values;
  if (f.kind === "config" && f.values) return f.values;
  return ["on", "off"];
}

// ─────────────────────────────────────────────────────────────────────────
// settings.json read/write
// ─────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
type PackageEntry = string | { source: string; autoload?: boolean };

/** Read a package's JSON config from <configDir>/extensions/<filename>. Used by
 * `launch` features to show the current value (e.g. vision-handoff's model). */
function readPackageConfig(filename: string): Json {
  try {
    return JSON.parse(readFileSync(join(CONFIG_DIR, "extensions", filename), "utf8")) as Json;
  } catch {
    return {};
  }
}

/** Read a package's top-level JSON config from <configDir>/<filename> (e.g.
 * pi-btw.json, pi-vision-handoff.json) for `config` features. Missing/
 * unreadable → empty object (all keys unset). */
function readConfigFile(filename: string): Json {
  try {
    return JSON.parse(readFileSync(join(CONFIG_DIR, filename), "utf8")) as Json;
  } catch {
    return {};
  }
}

function writeConfigFile(filename: string, data: Json): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(join(CONFIG_DIR, filename), JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (e) {
    throw new Error(`Could not write ${filename}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readSettings(): Json {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Json;
  } catch {
    return {};
  }
}

function writeSettings(data: Json): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (e) {
    throw new Error(`Could not write settings.json: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function getByPath(obj: Json, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      cur = (cur as Json)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setByPath(obj: Json, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: Json = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cur[p] = {} as Json;
    }
    cur = cur[p] as Json;
  }
  cur[parts[parts.length - 1]] = value;
}

// ─────────────────────────────────────────────────────────────────────────
// State read / apply
// ─────────────────────────────────────────────────────────────────────────

/** Current display value ("on" | "off" | enum string) for a feature. */
export function getFeatureState(f: Feature): string {
  if (f.kind === "launch") {
    try {
      return f.display ? f.display() : "open →";
    } catch {
      return "open →";
    }
  }
  if (f.kind === "package") {
    const pkgs = readSettings().packages;
    if (!Array.isArray(pkgs)) return "off";
    const entry = (pkgs as PackageEntry[]).find(
      (p) =>
        (typeof p === "string" && p === f.spec) || (typeof p === "object" && p.source === f.spec),
    );
    if (!entry) return "off";
    return typeof entry === "string" || entry.autoload !== false ? "on" : "off";
  }

  if (f.kind === "local") {
    return isFeatureEnabled(f.id) ? "on" : "off";
  }

  if (f.kind === "config") {
    const raw = readConfigFile(f.configFile!)[f.key!];
    // `picker` features are free-form strings drawn from a dynamic list
    // (e.g. a model id); "" means the key is absent / "same as main".
    // They must NOT be treated as booleans even though they have no `values`.
    if (f.picker) {
      return raw === undefined ? "" : String(raw);
    }
    const isBool =
      !f.values ||
      f.values.length === 0 ||
      (f.values.length === 2 && f.values.includes("on") && f.values.includes("off"));
    if (isBool) {
      const def = f.defaultValue === "on";
      return raw === undefined ? (def ? "on" : "off") : raw === true ? "on" : "off";
    }
    // enum: "" (first value) means the key is absent / "same as main".
    const fallback = f.defaultValue ?? f.values![0] ?? "";
    const str = raw === undefined ? "" : String(raw);
    return f.values!.includes(str) ? str : fallback;
  }

  // pi-setting
  if (f.picker && f.modelKey) {
    const model = getByPath(readSettings(), f.modelKey) as
      { provider?: string; id?: string } | undefined;
    if (model && typeof model === "object" && model.provider && model.id) {
      return `${model.provider}/${model.id}`;
    }
    return "";
  }
  const raw = getByPath(readSettings(), f.key!);
  const isBool =
    !f.values ||
    f.values.length === 0 ||
    (f.values.length === 2 && f.values.includes("on") && f.values.includes("off"));
  if (isBool) {
    const def = f.defaultValue === "on";
    return raw === undefined ? (def ? "on" : "off") : raw === true ? "on" : "off";
  }
  // enum
  const fallback = f.defaultValue ?? f.values![0] ?? "";
  const str = raw === undefined ? fallback : String(raw);
  return f.values!.includes(str) ? str : fallback;
}

/** Apply a new display value to the underlying config. Throws on failure. */
export function setFeatureState(f: Feature, value: string): void {
  if (f.kind === "package") {
    const data = readSettings();
    const pkgs = Array.isArray(data.packages) ? (data.packages as PackageEntry[]) : [];
    const idx = pkgs.findIndex(
      (p) =>
        (typeof p === "string" && p === f.spec) || (typeof p === "object" && p.source === f.spec),
    );
    const next: PackageEntry = value === "on" ? f.spec! : { source: f.spec!, autoload: false };
    if (idx >= 0) pkgs[idx] = next;
    else pkgs.push(next);
    data.packages = pkgs;
    writeSettings(data);
    return;
  }

  if (f.kind === "local") {
    setFeatureEnabled(f.id, value === "on");
    return;
  }

  if (f.kind === "config") {
    const data = readConfigFile(f.configFile!);
    // `picker` features are free-form strings (e.g. a model id); "" removes
    // the key ("same as main / use default"). Not boolean despite no `values`.
    if (f.picker) {
      if (value === "") delete data[f.key!];
      else data[f.key!] = value;
      writeConfigFile(f.configFile!, data);
      return;
    }
    const isBool =
      !f.values ||
      f.values.length === 0 ||
      (f.values.length === 2 && f.values.includes("on") && f.values.includes("off"));
    if (isBool) {
      data[f.key!] = value === "on";
    } else if (value === "") {
      // "" is the "same as main / use default" sentinel: remove the key.
      delete data[f.key!];
    } else {
      data[f.key!] = value;
    }
    writeConfigFile(f.configFile!, data);
    return;
  }

  // pi-setting
  const data = readSettings();
  if (f.picker && f.modelKey) {
    if (value === "") {
      // Clear: drop provider/id, keep thinking if set.
      const model = getByPath(data, f.modelKey);
      if (model && typeof model === "object" && !Array.isArray(model)) {
        const m = model as Record<string, unknown>;
        delete m.provider;
        delete m.id;
      }
    } else {
      const slash = value.indexOf("/");
      if (slash > 0) {
        setByPath(data, `${f.modelKey}.provider`, value.slice(0, slash));
        setByPath(data, `${f.modelKey}.id`, value.slice(slash + 1));
      }
    }
    writeSettings(data);
    return;
  }
  const isBool =
    !f.values ||
    f.values.length === 0 ||
    (f.values.length === 2 && f.values.includes("on") && f.values.includes("off"));
  if (isBool) {
    setByPath(data, f.key!, value === "on");
  } else {
    setByPath(data, f.key!, value);
  }
  writeSettings(data);
}

export const settingsPath = SETTINGS_PATH;
