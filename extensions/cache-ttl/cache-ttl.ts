// Prompt-cache TTL control (PI_CACHE_RETENTION) driven by a per-profile config.
//
// pi's providers resolve prompt-cache retention per request through
// `resolveCacheRetention()`: explicit option → `PI_CACHE_RETENTION` env var →
// "short" (packages/ai/src/api/anthropic-messages.ts, openai-responses.ts,
// openai-completions.ts, bedrock-converse-stream.ts). "short" is the provider
// default (Anthropic 5m, OpenAI in-memory); "long" asks for extended retention
// (Anthropic ttl:"1h", OpenAI prompt_cache_retention:"24h", Bedrock
// CacheTTL.ONE_HOUR) on models whose compat flag supportsLongCacheRetention
// allows it. pi exposes no settings.json key for this — only the env var.
//
// This extension bridges that gap: it reads `cache-ttl.json` at the config-dir
// root ({ "retention": "short" | "long" }) and sets PI_CACHE_RETENTION=long in
// the process env when "long" is selected. Because the providers read the env
// var lazily at request time (not at factory time), setting it here at load is
// enough, and /reload re-applies it without a restart.
//
// The toggle lives in /settings → Providers → Prompt caching (a `config`
// feature in impulso-settings/features.ts writing cache-ttl.json). Default is
// "short": key absent → env untouched → pi's built-in default. A pre-existing
// shell-provided PI_CACHE_RETENTION is preserved and restored when the toggle
// goes back to short (tracked via PI_CACHE_RETENTION_PREV), so this never
// clobbers an explicit user env. If you export PI_CACHE_RETENTION yourself,
// leave this feature on "short".

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR =
  process.env.PI_CODING_AGENT_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(CONFIG_DIR, "cache-ttl.json");

const ENV_KEY = "PI_CACHE_RETENTION";
/** Marker holding the env value that predates our override ("" = was unset). */
const PREV_KEY = "PI_CACHE_RETENTION_PREV";

type Retention = "short" | "long";

function readRetention(): Retention {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return (JSON.parse(raw) as { retention?: unknown }).retention === "long" ? "long" : "short";
  } catch {
    return "short";
  }
}

function applyCacheRetention(): void {
  if (readRetention() === "long") {
    // First application in this process: remember any pre-existing value so a
    // later flip back to "short" restores it instead of deleting blindly.
    if (process.env[PREV_KEY] === undefined) {
      process.env[PREV_KEY] = process.env[ENV_KEY] ?? "";
    }
    process.env[ENV_KEY] = "long";
  } else if (process.env[PREV_KEY] !== undefined) {
    // Toggle flipped back to short (+ /reload): restore what was there before
    // we overrode it (or remove the var if it was unset).
    const prev = process.env[PREV_KEY];
    if (prev) process.env[ENV_KEY] = prev;
    else delete process.env[ENV_KEY];
    delete process.env[PREV_KEY];
  }
}

// Run at import time: before any extension factory body executes.
applyCacheRetention();

export default function (_pi: any): void {
  // Re-apply on /reload (module state may reset, but the env persists in the
  // process) and act as the extension factory pi expects.
  applyCacheRetention();
}
