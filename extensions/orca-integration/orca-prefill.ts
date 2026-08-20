// @orca-managed-pi-extension
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isFeatureEnabled(id) {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || dirname(dirname(fileURLToPath(import.meta.url)))
    const raw = readFileSync(join(dir, "impulso-settings.json"), "utf8")
    return !((JSON.parse(raw).disabled ?? [])).includes(id)
  } catch {
    return true
  }
}

export default function (pi) {
  if (!isFeatureEnabled("orca-integration")) return;
  pi.on('session_start', async (event, ctx) => {
    if (!process.env.ORCA_PANE_KEY) return
    if (event.reason !== 'startup') return
    const prefill = process.env.ORCA_PI_PREFILL
    if (!prefill) return
    delete process.env.ORCA_PI_PREFILL
    try {
      ctx.ui.setEditorText(prefill)
    } catch {}
  })
}
