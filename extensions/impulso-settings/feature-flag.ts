// Shared impulso-pi feature-flag store.
//
// The /impulso settings page writes a per-profile manifest of *disabled*
// feature ids to `<configDir>/impulso-settings.json`. Local extensions
// import `isFeatureEnabled(id)` from this module and bail out of their
// factory when their id is disabled — so toggling a local extension off
// in the settings UI + `/reload` stops it from registering anything,
// without renaming or moving files (which would fight install.sh's
// non-clobber sync).
//
// `<configDir>` is the active pi config dir: PI_CODING_AGENT_DIR (set per
// profile by ppi) or the parent of this extension's own directory (the
// folder holding extensions/). This module always lives at
// `extensions/impulso-settings/feature-flag.ts`, so two dirname() hops
// land on the config dir regardless of which extension imports it.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || dirname(dirname(MODULE_DIR));
const MANIFEST_PATH = join(CONFIG_DIR, "impulso-settings.json");

export interface ImpulsoManifest {
  /** Feature ids currently disabled by the user. Absent = everything on. */
  disabled?: string[];
}

/** Read the on-disk manifest. Missing/unreadable → empty (everything enabled). */
export function readManifest(): ImpulsoManifest {
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const data = JSON.parse(raw) as ImpulsoManifest;
    return Array.isArray(data.disabled) ? { disabled: data.disabled } : {};
  } catch {
    return {};
  }
}

/** Persist the manifest. Best-effort; failures are non-fatal. */
export function writeManifest(manifest: ImpulsoManifest): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      MANIFEST_PATH,
      JSON.stringify({ disabled: manifest.disabled ?? [] }, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // Non-fatal: in-memory flag still works for the session.
  }
}

/** True when the feature is enabled (not listed in the manifest's disabled[]). */
export function isFeatureEnabled(id: string): boolean {
  const manifest = readManifest();
  return !(manifest.disabled ?? []).includes(id);
}

export function setFeatureEnabled(id: string, enabled: boolean): void {
  const manifest = readManifest();
  const disabled = new Set(manifest.disabled ?? []);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  writeManifest({ disabled: [...disabled] });
}

export const manifestPath = MANIFEST_PATH;
