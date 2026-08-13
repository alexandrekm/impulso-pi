// Notifies the active pi config directory at startup so you can see which
// profile dir (~/.pi/profiles/<name>/) or ~/.pi/agent pi actually loaded —
// useful with pi-profiles (ppi), which swaps the whole agentDir per profile.
//
// The config dir is read from PI_CODING_AGENT_DIR (the env var ppi sets when
// activating a profile). Falls back to the parent of this extension's own
// directory (the folder holding extensions/), which is the same config dir
// for a normally-placed extension (e.g. when running --base without ppi).
//
// Only fires on reason "startup", not on /new, /resume, or /fork.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

function configDir(): string {
  return process.env.PI_CODING_AGENT_DIR || dirname(EXT_DIR);
}

export default function (pi: any): void {
  pi.on("session_start", (event: any, ctx: any) => {
    if (event.reason !== "startup") return;
    ctx.ui.notify(`pi config: ${configDir()}`, "info");
  });
}
