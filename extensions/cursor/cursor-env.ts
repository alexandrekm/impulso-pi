// Wire-config overrides for @rahularya01/pi-cursor.
//
// pi-cursor (https://github.com/Rahularya01/pi-cursor) is a complete Cursor
// provider for pi: OAuth, model discovery, native Connect/protobuf streaming
// over HTTP/2, and a tool-execution bridge that maps onto pi's own tool loop
// (it emits pi toolcall events, parks the HTTP/2 bridge, and resumes it on the
// next streamSimple call with the tool result — so pi's permission/confirm
// system stays in charge).
//
// The upstream package ships two stale wire defaults that Cursor now rejects
// connections for:
//   - client version  cli-2026.05.01-eea359f   (~2.5 months old)
//   - chat endpoint   https://agentn.us.api5.cursor.sh  (stale regional host)
//
// oh-my-pi's built-in Cursor provider (reference-impl/oh-my-pi, refreshed
// 2026-07-23) still connects, and uses:
//   - client version  cli-2026.07.23-e383d2b
//   - chat endpoint   https://api2.cursor.sh        (path /agent.v1.AgentService/Run)
//
// pi-cursor reads both of these from process.env at *call time*
// (getCursorClientVersion() / getCursorAgentUrl() in its config.ts), and its
// activation does no network work, so setting the env during the extension-load
// phase — before any provider call — is sufficient. We set it at module
// top-level so it is in place before any other extension's factory runs,
// regardless of import order. Existing user overrides are preserved.

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

const WIRE_CLIENT_VERSION = "cli-2026.07.23-e383d2b";
const WIRE_AGENT_URL = "https://api2.cursor.sh";

function applyCursorWireEnv(): void {
  if (!process.env.PI_CURSOR_CLIENT_VERSION) {
    process.env.PI_CURSOR_CLIENT_VERSION = WIRE_CLIENT_VERSION;
  }
  if (!process.env.PI_CURSOR_AGENT_URL && !process.env.CURSOR_AGENT_URL) {
    process.env.PI_CURSOR_AGENT_URL = WIRE_AGENT_URL;
  }
}

// Run at import time: before any extension factory body executes.
// Guarded by the impulso /impulso settings page (feature id `cursor-env`).
if (isFeatureEnabled("cursor-env")) applyCursorWireEnv();

export default function (_pi: any): void {
  // Re-apply in case another extension cleared or reordered env, and as a
  // no-op marker so pi recognises this module as an extension factory.
  if (isFeatureEnabled("cursor-env")) applyCursorWireEnv();
}
