// Wire-config overrides for @ff-labs/pi-fff.
//
// pi-fff (https://github.com/dmtrKovalenko/fff, package @ff-labs/pi-fff) is a
// Rust-native, SIMD-accelerated file finder that pi loads as an extension. It
// can run in three modes (tools-and-ui | tools-only | override); we want
// `override` so FFF *replaces* pi's built-in `find`/`grep` (which spawn `fd` /
// `rg` per call) instead of registering a second `fffind`/`ffgrep` pair
// alongside them. Two search tools with overlapping names just makes the model
// flip between them and wastes context.
//
// It also defaults to indexing `$HOME` when pi is launched from there (a
// normal flow). On machines with large home trees (toolchains, kernel
// sources, build outputs) that background scan runs for a long time and burns
// CPU/RAM, so we opt out and let FFF index only the project cwd.
//
// pi-fff resolves both settings at *factory* time (the top of its default
// export), reading `pi.getFlag("fff-mode")` then `process.env.PI_FFF_MODE`,
// and `--fff-enable-home-scan` / `FFF_ENABLE_HOME_SCAN`. A flag would need to
// be passed on every `pi` launch; setting the env here is sticky. Because pi
// discovers and loads local `extensions/*.ts` files before npm-package
// extensions (resource-loader: localExtDir → globalExtDir → configured
// package paths), and loads them sequentially (import+factory one at a time),
// this module's top-level runs before @ff-labs/pi-fff is even imported — so
// the env is in place before its factory reads it. The same trick is used by
// extensions/cursor/cursor-env.ts. Existing user overrides are preserved.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isFeatureEnabled(id: string): boolean {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
    const raw = readFileSync(join(dir, "impulso-settings.json"), "utf8");
    return !((JSON.parse(raw).disabled ?? []) as string[]).includes(id);
  } catch {
    return true;
  }
}

const FFF_MODE = "override";
const FFF_ENABLE_HOME_SCAN = "0";

function applyFffEnv(): void {
  if (!process.env.PI_FFF_MODE) {
    process.env.PI_FFF_MODE = FFF_MODE;
  }
  if (!process.env.FFF_ENABLE_HOME_SCAN && !process.env.PI_FFF_ENABLE_HOME_SCAN) {
    process.env.FFF_ENABLE_HOME_SCAN = FFF_ENABLE_HOME_SCAN;
  }
}

// Run at import time: before any extension factory body executes.
// Guarded by the impulso /impulso settings page (feature id `fff-env`).
if (isFeatureEnabled("fff-env")) applyFffEnv();

export default function (_pi: any): void {
  // Re-apply in case another extension cleared or reordered env, and as a
  // no-op marker so pi recognises this module as an extension factory.
  if (isFeatureEnabled("fff-env")) applyFffEnv();
}
