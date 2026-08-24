#!/usr/bin/env node
// Syncs impulso-pi customizations into pi profile directories managed by
// pi-profiles (ppi), or into the raw ~/.pi/agent dir via --base.
//
// Which resources land where is decided by repo-root profiles.jsonc (JSONC):
// a resource is installed on a profile if it has the "core" tag or any tag
// the profile declares. See investigation/PROFILES.md.
//
// Usage:
//   ./install.sh [install]            interactive: prompt for a target
//   ./install.sh [install] <profile>  sync one profile (e.g. work)
//   ./install.sh [install] --all       sync every profile in profiles.jsonc
//   ./install.sh [install] --base      sync raw ~/.pi/agent with ALL resources
//   ./install.sh status [target]      show per-file sync state, no changes
//   ./install.sh pull   [target]      promote local edits back into the repo
//
// Target is a profile name, --all, or --base. status/pull take
// the same targets. Before file sync, `install` reviews dependencies (the
// `ppi` CLI if a profile target needs it, and the `npm:` packages from
// profiles.jsonc) and asks which to install. -y/--yes is non-interactive:
// install all missing deps, no version checks, no updates (for CI).
// Zero dependencies — Node standard library only.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  readdirSync,
  lstatSync,
  cpSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import * as readline from "node:readline/promises";

import {
  loadProfiles,
  validateProfiles,
  classify,
  isPackageKind,
  resourcesForProfile,
  relDestPath,
  resolveFileKeys,
} from "./profiles.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, "..");
const PROFILES_JSON = join(REPO_DIR, "profiles.jsonc");

const PI_ROOT = process.env.PPI_PI_ROOT || join(homedir(), ".pi");
const PROFILES_DIR = join(PI_ROOT, "profiles");
const AGENT_DIR = process.env.PI_AGENT_DIR || join(PI_ROOT, "agent");

const MANIFEST_NAME = ".impulso-pi-manifest.tsv";
const STATE_FILE = ".exporter-state.json";
const ERRORS_FILE = "errors.jsonl";
const COMMANDS = new Set(["install", "status", "pull"]);

// ---- hashing -------------------------------------------------------------

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function hashFile(p) {
  return sha256(readFileSync(p));
}

// Deterministic, order-independent hash of a directory's contents. Paths
// are stored relative to the directory root so the hash is location-
// independent: a freshly copied directory hashes the same as its source
// (absolute path prefixes would otherwise differ), keeping skill (directory)
// resources in sync across installs instead of always "locally modified".
function hashDir(p) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const fp = join(d, name);
      if (lstatSync(fp).isDirectory()) walk(fp);
      else files.push(fp);
    }
  };
  walk(p);
  files.sort();
  const blob =
    files.map((fp) => `${sha256(readFileSync(fp))}  ${relative(p, fp)}`).join("\n") + "\n";
  return sha256(Buffer.from(blob));
}

function hashOf(p) {
  return lstatSync(p).isDirectory() ? hashDir(p) : hashFile(p);
}

// ---- manifest ------------------------------------------------------------

function manifestRead(dir) {
  const p = join(dir, MANIFEST_NAME);
  const map = new Map();
  if (!existsSync(p)) return map;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    const [hash, repoPath, localPath] = line.split("\t");
    map.set(repoPath, { hash, localPath });
  }
  return map;
}

function manifestWrite(dir, map) {
  const p = join(dir, MANIFEST_NAME);
  mkdirSync(dir, { recursive: true });
  const lines = [...map.entries()].map(
    ([rp, { hash, localPath }]) => `${hash}\t${rp}\t${localPath}`,
  );
  writeFileSync(p, lines.join("\n") + (lines.length ? "\n" : ""));
}

function manifestGet(map, repoPath) {
  return map.get(repoPath)?.hash;
}

function manifestSet(map, hash, repoPath, localPath) {
  map.set(repoPath, { hash, localPath });
}

// ---- external CLIs -------------------------------------------------------

function hasCmd(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]);
  return r.status === 0;
}

function ensurePpiInstalled() {
  const r = spawnSync("npm", ["install", "-g", "pi-profiles"], { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    throw new Error("'npm install -g pi-profiles' failed");
  }
}

function ensureProfile(name) {
  const dir = join(PROFILES_DIR, name);
  if (existsSync(dir)) return dir;
  const r = spawnSync("ppi", ["create", name], { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    throw new Error(`'ppi create ${name}' failed. Is pi-profiles installed?`);
  }
  return dir;
}

function piInstall(pkg, dir) {
  const r = spawnSync("pi", ["install", pkg], {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: dir },
  });
  if (r.error) throw new Error("'pi' CLI not found. Install pi first: https://pi.dev");
  if (r.status !== 0) throw new Error(`pi install ${pkg} failed`);
}

function piUpdate(pkg, dir) {
  const r = spawnSync("pi", ["update", pkg], {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: dir },
  });
  if (r.error) throw new Error("'pi' CLI not found. Install pi first: https://pi.dev");
  if (r.status !== 0) throw new Error(`pi update ${pkg} failed`);
}

function piUninstall(pkg, dir) {
  const r = spawnSync("pi", ["uninstall", pkg], {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: dir },
  });
  if (r.error) throw new Error("'pi' CLI not found. Install pi first: https://pi.dev");
  return r.status === 0;
}

// ---- npm version checks --------------------------------------------------

const latestCache = new Map();
function latestVersion(pkgName) {
  if (latestCache.has(pkgName)) return latestCache.get(pkgName);
  const r = spawnSync("npm", ["view", pkgName, "version"], { encoding: "utf8" });
  const v = r.status === 0 ? r.stdout.trim() : null;
  latestCache.set(pkgName, v);
  return v;
}

function installedPkgVersion(dir, pkgName) {
  const pj = join(dir, "npm", "node_modules", pkgName, "package.json");
  if (!existsSync(pj)) return null;
  try {
    return JSON.parse(readFileSync(pj, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function pkgNameFromSpec(spec) {
  return spec.slice("npm:".length);
}

// ---- paths ---------------------------------------------------------------

function srcPath(key) {
  const kind = classify(key);
  if (isPackageKind(kind)) return null;
  const rel = kind === "skill" ? key.replace(/\/$/, "") : key;
  return join(REPO_DIR, rel);
}

function destPath(dir, key, entry) {
  if (isPackageKind(classify(key))) return null;
  return join(dir, relDestPath(key, entry));
}

// Collision resolution lives in profiles.mjs (shared with CI); here we just
// wire up the shadow warning.
function resolveTargetFileKeys(keys, profiles) {
  return resolveFileKeys(keys, profiles.resources, (loser, winner, d) =>
    console.log(`  [shadowed]     ${loser} (dest "${d}" also claimed by ${winner})`),
  );
}

function copyEntry(src, dest) {
  if (lstatSync(src).isDirectory()) {
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

// ---- target resolution ---------------------------------------------------

function allResourceKeys(profiles) {
  return Object.keys(profiles.resources || {});
}

// Resolve target names + dirs WITHOUT creating profiles (so dep review can
// run first). Base returns a single entry with base:true.
function resolveNames(spec, profiles) {
  if (spec.base) return [{ name: null, base: true, dir: AGENT_DIR }];
  if (spec.all) {
    return Object.keys(profiles.profiles || {})
      .sort()
      .map((name) => ({ name, base: false, dir: join(PROFILES_DIR, name) }));
  }
  if (spec.profile) {
    return [{ name: spec.profile, base: false, dir: join(PROFILES_DIR, spec.profile) }];
  }
  return [];
}

// Keys for a resolved target (core + matching tags). Base gets all resources.
function keysForTarget(t, profiles) {
  if (t.base) return allResourceKeys(profiles);
  const tags = profiles.profiles[t.name].tags || [];
  return resourcesForProfile(tags, profiles.resources || {});
}

async function chooseSpec(profiles) {
  const profs = Object.keys(profiles.profiles || {}).sort();
  const opts = [];
  for (const p of profs) opts.push({ label: `profile: ${p}`, spec: { profile: p } });
  opts.push({ label: "all profiles", spec: { all: true } });
  opts.push({ label: "base (~/.pi/agent)", spec: { base: true } });

  console.log("Choose a target:");
  opts.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`Select [1-${opts.length}]: `);
  rl.close();
  const idx = parseInt(ans, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= opts.length) {
    console.error("Invalid selection.");
    process.exit(1);
  }
  return opts[idx].spec;
}

function printAvailable(profiles) {
  console.error("Profiles: " + Object.keys(profiles.profiles || {}).join(", "));
  console.error("Or use --all / --base.");
}

// ---- dependency review ---------------------------------------------------

// Build the list of dependencies to act on for the given targets.
// Returns { items: [{key, kind, label, state, installed?, latest?}], needsPpi }.
// state ∈ "missing" | "update" | "installed". "installed" (up-to-date) items
// are dropped (hidden) — only missing + update-available are shown.
function buildDepList(names, profiles) {
  const needsPpi = names.some((n) => !n.base);
  const items = [];

  // `pi` CLI is a hard prerequisite, not a choosable dep — checked elsewhere.

  // ppi: required when any target is a profile.
  if (needsPpi && !hasCmd("ppi")) {
    items.push({ key: "ppi", kind: "ppi", label: "ppi (pi-profiles)", state: "missing" });
  }

  // packages (npm: and git:): union across targets.
  const pkgKeys = new Set();
  for (const t of names) {
    for (const k of keysForTarget(t, profiles)) {
      if (isPackageKind(classify(k))) pkgKeys.add(k);
    }
  }

  for (const key of [...pkgKeys].sort()) {
    const kind = classify(key);
    // installed everywhere? (manifest marker present in every target)
    const installedEverywhere = names.every((t) => manifestGet(manifestRead(t.dir), key));
    if (!installedEverywhere) {
      items.push({ key, kind, label: key, state: "missing" });
      continue;
    }
    // update checks only apply to npm packages (git: has no registry version)
    if (kind !== "npm") continue;
    const pkgName = pkgNameFromSpec(key);
    // installed everywhere — check for an update (first target's version)
    const installed = installedPkgVersion(names[0].dir, pkgName);
    const latest = latestVersion(pkgName);
    if (installed && latest && installed !== latest) {
      items.push({
        key,
        kind,
        label: key,
        state: "update",
        installed,
        latest,
      });
    }
    // else up-to-date → hidden
  }

  return { items, needsPpi };
}

async function reviewDepsSelect(names, profiles, yes) {
  const { items, needsPpi } = buildDepList(names, profiles);

  if (items.length === 0) {
    console.log("==> All dependencies already installed and up to date.");
    return { items, needsPpi, selected: [] };
  }

  let selected;
  if (yes) {
    // Non-interactive: install all missing, skip updates, no version checks
    // were needed for missing items (none performed for them).
    selected = items.filter((it) => it.state === "missing").map((it) => it.key);
  } else {
    console.log("==> Dependencies");
    items.forEach((it, i) => {
      const n = `${i + 1}.`.padStart(4);
      if (it.state === "missing") {
        const tag = it.kind === "ppi" ? "  [required]" : "";
        console.log(`${n} ${it.label.padEnd(34)} not installed${tag}`);
      } else {
        console.log(`${n} ${it.label.padEnd(34)} update (${it.installed} -> ${it.latest})`);
      }
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Y/N to install everything; answer N to go through items one by one.
    const allAns = await rl.question(`Install all of the above? [Y/n]: `);
    const a = allAns.trim().toLowerCase();
    if (a === "" || a === "y" || a === "yes") {
      selected = items.map((it) => it.key);
      rl.close();
    } else {
      selected = [];
      console.log("==> Selecting one by one (Enter = yes, n = skip)");
      for (const it of items) {
        let detail;
        if (it.state === "missing") {
          const tag = it.kind === "ppi" ? "  [required]" : "";
          detail = `not installed${tag}`;
        } else {
          detail = `update (${it.installed} -> ${it.latest})`;
        }
        // eslint-disable-next-line no-await-in-loop
        const one = await rl.question(`Install ${it.label} (${detail})? [Y/n]: `);
        const oa = one.trim().toLowerCase();
        if (oa === "" || oa === "y" || oa === "yes") {
          selected.push(it.key);
        }
      }
      rl.close();
    }
  }

  return { items, needsPpi, selected };
}

// Install `ppi` if selected; abort if it was required and not selected.
// Must run BEFORE profile dirs are created (ensureProfile needs ppi).
function applyPpiSelection(needsPpi, selected) {
  const ppiMissing = !hasCmd("ppi");
  if (needsPpi && ppiMissing && !selected.includes("ppi")) {
    console.error("`ppi` is required for profile targets but was not selected. Aborting.");
    console.error("Install it with: npm install -g pi-profiles");
    process.exit(1);
  }
  if (selected.includes("ppi")) {
    console.log("==> Installing ppi (pi-profiles) globally");
    ensurePpiInstalled();
  }
}

// npm packages: missing → pi install in profiles where missing;
// update → pi update in profiles where installed. Runs AFTER profile dirs
// exist (pi install writes into each profile dir).
function executeNpmInstalls(selected, items, names) {
  const byKey = new Map(items.map((it) => [it.key, it]));
  for (const key of selected) {
    if (key === "ppi") continue;
    const it = byKey.get(key);
    if (!it || !isPackageKind(it.kind)) continue;
    for (const t of names) {
      const map = manifestRead(t.dir);
      const has = manifestGet(map, key);
      if (it.state === "missing" && !has) {
        piInstall(key, t.dir);
        manifestSet(map, key, key, join(t.dir, "settings.json"));
        manifestWrite(t.dir, map);
        console.log(`  [pkg new]      ${key}  ->  ${t.base ? "base" : t.name}`);
      } else if (it.state === "update" && has) {
        piUpdate(key, t.dir);
        console.log(`  [pkg updated]  ${key}  ->  ${t.base ? "base" : t.name}`);
      }
    }
  }
}

// ---- settings sync ---------------------------------------------------------

// ---- legacy payload migration -------------------------------------------

// The payload-exporter now groups files under payloads/<date>/<session>/.
// Remove legacy flat payload--*.json files and the root errors.jsonl that
// were written directly under payloads/ by older versions, so the top level
// is clean. Only deletes files matching the exact legacy patterns; leaves
// date dirs, the state file, and everything else untouched.
function migrateLegacyPayloads(t) {
  const dir = join(t.dir, "payloads");
  if (!existsSync(dir)) return;
  let removed = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) continue; // keep date/session subdirs
    if (e.name === STATE_FILE || e.name === MANIFEST_NAME) continue;
    if (e.name === ERRORS_FILE || /^payload--.*\.json$/.test(e.name)) {
      rmSync(join(dir, e.name), { force: true });
      removed++;
    }
  }
  if (removed > 0)
    console.log(`  [migrated]    removed ${removed} legacy flat payload file(s) under payloads/`);
}

// command-guard replaced @gotgenes/pi-permission-system. Drop the npm package,
// its leftover config dir, and the old manifest rows so both gates cannot run.
const LEGACY_PERMISSION_PKG = "npm:@gotgenes/pi-permission-system";
const LEGACY_PERMISSION_DIR = "extensions/pi-permission-system";
const LEGACY_PERMISSION_MANIFEST_KEYS = [
  LEGACY_PERMISSION_PKG,
  "extensions/pi-permission-system/config.work.json",
  "extensions/pi-permission-system/config.personal.json",
];

// pi-dynamic-footer replaced pi-droid-styling and footer-status-widgets.
// Both former extensions own or patch the bottom TUI zone, so leaving them in
// an existing profile alongside the dynamic footer produces duplicate/stale
// status rows. These resources predate the manifest's current declarations,
// so they must be explicitly migrated rather than relying on normal sync.
const LEGACY_DROID_PKG = "git:github.com/sting8k/pi-droid-styling";
const LEGACY_DROID_DIR = join("git", "github.com", "sting8k", "pi-droid-styling");
const LEGACY_DROID_FILES = [
  "extensions/footer-status-widgets.ts",
  "extensions/droid-render-safety-env.ts",
];
const LEGACY_DROID_MANIFEST_KEYS = [
  LEGACY_DROID_PKG,
  "extensions/footer-status-widgets/footer-status-widgets.ts",
  "extensions/pi-droid-styling/droid-render-safety-env.ts",
];

function settingsHasPackage(dir, spec) {
  const p = join(dir, "settings.json");
  if (!existsSync(p)) return false;
  try {
    const current = JSON.parse(readFileSync(p, "utf8"));
    return (
      Array.isArray(current.packages) &&
      current.packages.some((entry) => entry === spec || entry?.source === spec)
    );
  } catch {
    return false;
  }
}

function migrateLegacyPermissionSystem(t) {
  const map = manifestRead(t.dir);
  const pkgDir = join(t.dir, "npm", "node_modules", "@gotgenes", "pi-permission-system");
  const hasPkg =
    Boolean(manifestGet(map, LEGACY_PERMISSION_PKG)) ||
    existsSync(pkgDir) ||
    settingsHasPackage(t.dir, LEGACY_PERMISSION_PKG);
  const legacyDir = join(t.dir, LEGACY_PERMISSION_DIR);
  const hasDir = existsSync(legacyDir);
  const hasManifest = LEGACY_PERMISSION_MANIFEST_KEYS.some((k) => map.has(k));
  if (!hasPkg && !hasDir && !hasManifest) return;

  if (hasPkg) piUninstall(LEGACY_PERMISSION_PKG, t.dir);
  if (existsSync(legacyDir)) rmSync(legacyDir, { recursive: true, force: true });
  for (const key of LEGACY_PERMISSION_MANIFEST_KEYS) map.delete(key);
  manifestWrite(t.dir, map);
  console.log(`  [migrated]    removed @gotgenes/pi-permission-system`);
}

function migrateLegacyDroidStyling(t) {
  const map = manifestRead(t.dir);
  const pkgDir = join(t.dir, LEGACY_DROID_DIR);
  const hasPkg =
    Boolean(manifestGet(map, LEGACY_DROID_PKG)) ||
    existsSync(pkgDir) ||
    settingsHasPackage(t.dir, LEGACY_DROID_PKG);
  const existingFiles = LEGACY_DROID_FILES.filter((path) => existsSync(join(t.dir, path)));
  const hasManifest = LEGACY_DROID_MANIFEST_KEYS.some((key) => map.has(key));
  if (!hasPkg && existingFiles.length === 0 && !hasManifest) return;

  if (hasPkg) piUninstall(LEGACY_DROID_PKG, t.dir);
  // Remove only the two retired files; no general stale-file pruning, which
  // would violate the syncer's non-clobber promise for user-owned files.
  for (const path of existingFiles) rmSync(join(t.dir, path), { force: true });
  if (existsSync(pkgDir)) rmSync(pkgDir, { recursive: true, force: true });
  for (const key of LEGACY_DROID_MANIFEST_KEYS) map.delete(key);
  manifestWrite(t.dir, map);
  console.log(`  [migrated]    removed pi-droid-styling and footer-status-widgets`);
}

// Merge settings from profiles.jsonc into a target's settings.json. Two
// sources, with deliberately different semantics:
//
//   profiles.settings         — MANAGED keys. Overwrite on every sync (the
//                              repo owns these: theme, hideThinkingBlock, …).
//                              Shallow merge; declared scalars/arrays replace
//                              whatever is there. `packages` is rejected here.
//
//   profiles.settingsDefaults — DEFAULTS. Deep fill-only: a key (and its
//                              nested sub-keys) is written ONLY when absent
//                              in settings.json, so user overrides made via
//                              /settings survive sync. Used to seed safe
//                              initial values for extension-managed namespaces
//                              (e.g. observational-memory compaction
//                              thresholds) on fresh machines without clobbering
//                              per-user tuning. Keys removed from profiles.jsonc
//                              are left as-is (non-clobber).
export function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Recursively fill `defaults` into `current`: for each key, write it only
// when absent. Plain-object sub-keys recurse so a nested default can fill
// individual missing leaves while preserving the user's existing ones.
export function fillSettingsDefaults(current, defaults) {
  const out = { ...current };
  for (const [k, val] of Object.entries(defaults)) {
    if (isPlainObject(val)) {
      const cur = current[k];
      if (cur === undefined) {
        out[k] = val;
      } else if (isPlainObject(cur)) {
        out[k] = fillSettingsDefaults(cur, val);
      }
      // else: user has a scalar where a default object lives — keep it.
    } else if (current[k] === undefined) {
      out[k] = val;
    }
  }
  return out;
}

export function doInstallSettings(t, profiles) {
  const settings = profiles.settings;
  const defaults = profiles.settingsDefaults;
  const hasManaged = settings && Object.keys(settings).length > 0;
  const hasDefaults = defaults && Object.keys(defaults).length > 0;
  if (!hasManaged && !hasDefaults) return;
  const p = join(t.dir, "settings.json");
  let current = {};
  if (existsSync(p)) {
    try {
      current = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      console.log(`  [skipped]     settings.json (unparseable — fix manually)`);
      return;
    }
  }
  let merged = current;
  const changed = [];
  // Managed keys: overwrite (repo-owned).
  if (hasManaged) {
    for (const [k, val] of Object.entries(settings)) {
      if (current[k] !== val) changed.push(k);
      merged = { ...merged, [k]: val };
    }
  }
  // Defaults: deep fill-only (user overrides preserved).
  if (hasDefaults) {
    const before = merged;
    merged = fillSettingsDefaults(before, defaults);
    for (const k of Object.keys(defaults)) {
      if (JSON.stringify(before[k]) !== JSON.stringify(merged[k])) changed.push(k);
    }
  }
  if (changed.length === 0) {
    console.log(`  [in sync]     settings.json`);
    return;
  }
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
  console.log(`  [updated]     settings.json (${changed.join(", ")})`);
}

// ---- per-target file sync ------------------------------------------------

function doInstallFiles(t, profiles) {
  const keys = resolveTargetFileKeys(
    keysForTarget(t, profiles).filter((k) => !isPackageKind(classify(k))),
    profiles,
  );
  const map = manifestRead(t.dir);
  mkdirSync(join(t.dir, "extensions"), { recursive: true });
  mkdirSync(join(t.dir, "skills"), { recursive: true });
  for (const key of keys) {
    const src = srcPath(key);
    const dest = destPath(t.dir, key, profiles.resources[key]);
    const repoHash = hashOf(src);
    if (!existsSync(dest)) {
      copyEntry(src, dest);
      manifestSet(map, repoHash, key, dest);
      console.log(`  [new]         ${key}`);
      continue;
    }
    const localHash = hashOf(dest);
    const lastHash = manifestGet(map, key);
    if (localHash === repoHash) {
      manifestSet(map, repoHash, key, dest);
      console.log(`  [in sync]     ${key}`);
    } else if (lastHash === localHash) {
      copyEntry(src, dest);
      manifestSet(map, repoHash, key, dest);
      console.log(`  [updated]     ${key}`);
    } else if (lastHash === repoHash) {
      console.log(`  [skipped]     ${key} (locally modified — run 'pull')`);
    } else {
      console.log(`  [CONFLICT]    ${key} (both changed — resolve manually)`);
    }
  }
  manifestWrite(t.dir, map);
}

function doStatus(t, profiles) {
  const allKeys = keysForTarget(t, profiles);
  const keys = resolveTargetFileKeys(
    allKeys.filter((k) => !isPackageKind(classify(k))),
    profiles,
  );
  const map = manifestRead(t.dir);
  for (const key of allKeys.filter((k) => isPackageKind(classify(k)))) {
    const state = manifestGet(map, key) ? "in sync" : "not installed";
    console.log(`  ${key.padEnd(43)} ${state}`);
  }
  for (const key of keys) {
    const src = srcPath(key);
    const dest = destPath(t.dir, key, profiles.resources[key]);
    const repoHash = hashOf(src);
    if (!existsSync(dest)) {
      console.log(`  ${key.padEnd(43)} new (not installed)`);
      continue;
    }
    const localHash = hashOf(dest);
    const lastHash = manifestGet(map, key);
    let state;
    if (localHash === repoHash) state = "in sync";
    else if (lastHash === localHash) state = "upstream updated (safe to install)";
    else if (lastHash === repoHash) state = "locally modified (run 'pull' to promote)";
    else state = "CONFLICT (both changed independently)";
    console.log(`  ${key.padEnd(43)} ${state}`);
  }
}

function doPull(t, profiles) {
  const keys = resolveTargetFileKeys(
    keysForTarget(t, profiles).filter((k) => !isPackageKind(classify(k))),
    profiles,
  );
  const map = manifestRead(t.dir);
  let pulled = 0;
  for (const key of keys) {
    const src = srcPath(key);
    const dest = destPath(t.dir, key, profiles.resources[key]);
    if (!existsSync(dest)) continue;
    const localHash = hashOf(dest);
    const repoHash = hashOf(src);
    const lastHash = manifestGet(map, key);
    if (localHash === repoHash) continue;
    if (lastHash === repoHash || !lastHash) {
      copyEntry(dest, src);
      manifestSet(map, localHash, key, dest);
      console.log(`  [pulled]  ${key}`);
      pulled++;
    } else if (lastHash === localHash) {
      // local unchanged since last sync
    } else {
      console.log(`  [CONFLICT] ${key} (both changed — resolve manually)`);
    }
  }
  manifestWrite(t.dir, map);
  console.log(
    pulled
      ? `\nPulled ${pulled} file(s). Review with 'git diff' in ${REPO_DIR}.`
      : "\nNothing to pull — no locally-diverged files found.",
  );
}

// ---- wrapper deployment (ppi-auto) --------------------------

function deployPpiAuto() {
  const src = join(REPO_DIR, "scripts", "ppi-auto");
  const destDir = join(homedir(), ".local", "bin");
  const dest = join(destDir, "ppi-auto");

  // Copy wrapper script — non-clobber, same logic as the profile file
  // sync: track the last-installed hash in a manifest next to the dest so
  // manual edits to the installed copy survive install runs. Use
  // 'install.sh pull' (or re-copy from scripts/ppi-auto) to promote a local
  // edit back into the repo.
  mkdirSync(destDir, { recursive: true });
  const key = "ppi-auto";
  const repoHash = hashFile(src);
  const map = manifestRead(destDir);
  if (!existsSync(dest)) {
    copyFileSync(src, dest);
    manifestSet(map, repoHash, key, dest);
    console.log(`  [new]         ppi-auto -> ${dest}`);
  } else {
    const localHash = hashFile(dest);
    const lastHash = manifestGet(map, key);
    if (localHash === repoHash) {
      manifestSet(map, repoHash, key, dest);
      console.log(`  [in sync]     ppi-auto -> ${dest}`);
    } else if (!lastHash) {
      // No manifest baseline yet (e.g. adopted from a pre-guard install):
      // copy and start tracking rather than spuriously conflicting.
      copyFileSync(src, dest);
      manifestSet(map, repoHash, key, dest);
      console.log(`  [adopted]     ppi-auto -> ${dest}`);
    } else if (lastHash === localHash) {
      copyFileSync(src, dest);
      manifestSet(map, repoHash, key, dest);
      console.log(`  [updated]     ppi-auto -> ${dest}`);
    } else if (lastHash === repoHash) {
      console.log(`  [skipped]     ppi-auto (locally modified — run 'install.sh pull')`);
    } else {
      console.log(`  [CONFLICT]    ppi-auto (both changed — resolve manually)`);
    }
  }
  manifestWrite(destDir, map);
  spawnSync("chmod", ["+x", dest]);

  // Ensure global gitignore includes ppi-auto.
  const excludesFile = (() => {
    const r = spawnSync("git", ["config", "--global", "core.excludesfile"], {
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    // Default global gitignore location.
    return join(homedir(), ".config", "git", "ignore");
  })();

  const entry = "ppi-auto";
  mkdirSync(dirname(excludesFile), { recursive: true });
  const current = existsSync(excludesFile) ? readFileSync(excludesFile, "utf8") : "";
  if (!current.split("\n").some((l) => l.trim() === entry)) {
    const nl = current.endsWith("\n") || current === "" ? "" : "\n";
    writeFileSync(excludesFile, current + nl + entry + "\n");
    console.log(`  Added '${entry}' to ${excludesFile}`);
  }

  // Ensure git knows about the excludesfile.
  const cfgResult = spawnSync("git", ["config", "--global", "core.excludesfile"], {
    encoding: "utf8",
  });
  if (cfgResult.status !== 0 || !cfgResult.stdout.trim()) {
    spawnSync("git", ["config", "--global", "core.excludesfile", excludesFile]);
    console.log(`  Set git global core.excludesfile = ${excludesFile}`);
  }
}

// ---- standalone global tools (NOT pi resources) ---------------------------
// Reads profiles.tools: a map of name -> { path } for standalone npm packages
// that live in this repo and should be installed globally (npm i -g). Separate
// from the profile resource sync — these are not synced into any profile dir.
// Always rebuilds + reinstalls: a plain version-string comparison isn't safe
// here because these packages are checked out from git, not published — a
// `git pull`/merge can change the source without bumping `version`, leaving a
// stale `dist/` behind if we skip the rebuild. `npm install` (dist/ via
// `prepare`) and `npm install -g .` are both cheap/idempotent when nothing
// changed, so we just always run them.
export function installStandaloneTools(profiles) {
  const tools = profiles.tools || {};
  const entries = Object.entries(tools);
  const freshlyInstalled = [];
  if (entries.length === 0) return freshlyInstalled;
  if (!hasCmd("npm")) {
    console.error("  standalone tools: 'npm' not found on PATH, skipping");
    return freshlyInstalled;
  }
  const globalRootRes = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  const globalRoot = globalRootRes.status === 0 ? globalRootRes.stdout.trim() : null;

  for (const [name, tool] of entries) {
    const dir = join(REPO_DIR, tool.path || name);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) {
      console.error(`  ${name}: no package.json at ${dir}, skipping`);
      continue;
    }
    let localPkg;
    try {
      localPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      console.error(`  ${name}: could not parse ${pkgPath}, skipping`);
      continue;
    }
    const pkgName = localPkg.name || name;
    const localVersion = localPkg.version;

    // Only used to report whether this is a fresh install (for the
    // maybeOfferStatsService prompt below) — no longer used to decide
    // whether to rebuild/reinstall; see comment above installStandaloneTools.
    let globalVersion = null;
    if (globalRoot) {
      const gpkg = join(globalRoot, pkgName, "package.json");
      if (existsSync(gpkg)) {
        try {
          globalVersion = JSON.parse(readFileSync(gpkg, "utf8")).version;
        } catch {
          /* unreadable — treat as missing */
        }
      }
    }
    const wasMissing = !globalVersion;

    console.log(`==> tool -> ${pkgName} v${localVersion} (global install from ${dir})`);
    // `npm install` installs devDeps and runs `prepare` (builds dist/).
    if (
      spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" })
        .status !== 0
    ) {
      console.error(`  ${pkgName}: 'npm install' failed, skipping`);
      continue;
    }
    // Global install packs the dir (dist/ included via the package's `files`)
    // and links the bin. `prepare` may be blocked by npm's allow-scripts
    // policy here, but dist/ was already built by the step above.
    if (
      spawnSync("npm", ["install", "-g", ".", "--no-audit", "--no-fund"], {
        cwd: dir,
        stdio: "inherit",
      }).status !== 0
    ) {
      console.error(`  ${pkgName}: 'npm install -g .' failed, skipping`);
      continue;
    }
    const binName =
      localPkg.bin && typeof localPkg.bin === "object" ? Object.keys(localPkg.bin)[0] : pkgName;
    console.log(`  ${pkgName}: v${localVersion} installed (bin: ${binName})`);
    freshlyInstalled.push({ pkgName, binName, version: localVersion, wasMissing });
  }
  return freshlyInstalled;
}

// ---- pi-omp-stats service offer -------------------------------------------
// After a *fresh* global install of pi-omp-stats (not present before, or
// version changed), offer to register it as a launchd/systemd user service so
// the dashboard always runs. Skipped in --yes mode (a background daemon is a
// side effect you don't want auto-enabled in CI); we just print a hint there.
// Also skipped if the service is already registered.
export async function maybeOfferStatsService(freshlyInstalled, yes, profilesMode) {
  const stats = freshlyInstalled.find(
    (t) => t.binName === "pi-omp-stats" || t.pkgName === "pi-omp-stats",
  );
  if (!stats) return;

  // If the bin isn't resolvable on PATH, we can't do anything useful.
  if (!hasCmd("pi-omp-stats")) return;

  // Already registered? `service status` exits 0 when loaded/running.
  const serviceEnv = profilesMode
    ? { ...process.env, PI_STATS_PROFILES_DIR: PROFILES_DIR }
    : process.env;
  const statusRes = spawnSync("pi-omp-stats", ["service", "status"], {
    stdio: "ignore",
    env: serviceEnv,
  });
  if (statusRes.status === 0) {
    // The service is already registered, but install.sh just rebuilt +
    // reinstalled the global pi-omp-stats binary. Restart the running
    // process so it picks up the new code — otherwise launchd/systemd
    // KeepAlive keeps the *old* binary alive forever and the dashboard
    // serves stale assets (e.g. missing new panels after an upgrade).
    if (profilesMode) {
      // Re-bake PI_STATS_PROFILES_DIR into the plist/unit first, in case
      // the profile set changed since last install.
      console.log("==> pi-omp-stats service install (refresh profile discovery)");
      const ins = spawnSync("pi-omp-stats", ["service", "install"], {
        stdio: "inherit",
        env: serviceEnv,
      });
      if (ins.status !== 0)
        console.error("  service refresh failed; rerun pi-omp-stats service install");
    }
    console.log("==> pi-omp-stats service restart (pick up freshly installed build)");
    const res = spawnSync("pi-omp-stats", ["service", "restart"], {
      stdio: "inherit",
      env: serviceEnv,
    });
    if (res.status !== 0)
      console.error("  service restart failed; rerun pi-omp-stats service restart");
    else console.log("  pi-omp-stats service restarted with the latest build.");
    return;
  }

  if (yes) {
    console.log(
      "  Tip: run `pi-omp-stats service install` to keep the dashboard always on (launchd/systemd).",
    );
    return;
  }

  // Interactive prompt (y/N, default No — a daemon is opt-in).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(
      "Register pi-omp-stats as a background service so the dashboard always runs? [y/N]: ",
    );
    rl.close();
    const a = ans.trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      console.log("  Skipped. You can register it later with: pi-omp-stats service install");
      return;
    }
  } catch {
    rl.close();
    return;
  }

  console.log("==> pi-omp-stats service install");
  const res = spawnSync("pi-omp-stats", ["service", "install"], {
    stdio: "inherit",
    env: serviceEnv,
  });
  if (res.status !== 0) {
    console.error("  service install failed; you can retry with: pi-omp-stats service install");
  }
}

// ---- main ----------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let cmd = "install";
  let i = 0;
  if (args[i] && COMMANDS.has(args[i])) cmd = args[i++];

  let baseFlag = false;
  let allFlag = false;
  let yes = false;
  let target = null;
  while (i < args.length) {
    const a = args[i++];
    if (a === "--all") allFlag = true;
    else if (a === "--base") baseFlag = true;
    else if (a === "-y" || a === "--yes") yes = true;
    else if (!a.startsWith("-")) target = a;
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    }
  }

  if (!existsSync(PROFILES_JSON)) {
    console.error(`Missing ${PROFILES_JSON}`);
    process.exit(1);
  }
  const profiles = loadProfiles(PROFILES_JSON);
  const errs = validateProfiles(profiles, REPO_DIR);
  if (errs.length) {
    console.error("profiles.jsonc is invalid:\n  " + errs.join("\n  "));
    process.exit(1);
  }

  let spec = null;
  if (baseFlag) spec = { base: true };
  else if (allFlag) spec = { all: true };
  else if (target) {
    if (profiles.profiles?.[target]) spec = { profile: target };
    else {
      console.error(`Unknown target '${target}'. Not a profile.`);
      printAvailable(profiles);
      process.exit(1);
    }
  }

  if (!spec) {
    if (process.stdin.isTTY) {
      spec = await chooseSpec(profiles);
    } else {
      console.error(
        "No target specified (and stdin is not interactive). Use a profile name, --all, or --base.",
      );
      process.exit(1);
    }
  }

  // `pi` CLI is a hard prerequisite for install (needs pi install); for
  // status/pull we only read/move files, so pi isn't required.
  if (cmd === "install" && !hasCmd("pi")) {
    console.error("'pi' CLI not found on PATH. Install pi first: https://pi.dev");
    process.exit(1);
  }

  const names = resolveNames(spec, profiles);

  if (cmd === "install") {
    // 1. Dependency review + select (interactive unless --yes). No dirs needed
    //    yet — buildDepList treats a missing dir as "not installed".
    const { items, needsPpi, selected } = await reviewDepsSelect(names, profiles, yes);
    // 2. Install ppi if selected; abort if required & not selected.
    applyPpiSelection(needsPpi, selected);
    // 3. Create profile dirs (ppi is now available for non-base targets).
    for (const t of names) {
      if (!t.base) ensureProfile(t.name);
    }
    // 4. Execute npm installs/updates (dirs now exist).
    executeNpmInstalls(selected, items, names);
    // 5. File sync.
    for (const t of names) {
      console.log(`==> install -> ${t.base ? "base" : t.name} (${t.dir})`);
      migrateLegacyPermissionSystem(t);
      migrateLegacyDroidStyling(t);
      doInstallFiles(t, profiles);
      doInstallSettings(t, profiles);
      migrateLegacyPayloads(t);
    }
    // 6. Deploy ppi-auto wrapper (only if work profile is being installed,
    //    meaning this machine has both profiles and needs routing).
    if (names.some((t) => t.name === "work" || t.base)) deployPpiAuto();
    // Standalone global CLI tools (profiles.tools) — regular npm packages
    // installed globally, separate from the profile sync above.
    const freshlyInstalledTools = installStandaloneTools(profiles);
    // Offer to register pi-omp-stats as a background service after a fresh
    // install (interactive only; --yes prints a hint instead).
    await maybeOfferStatsService(
      freshlyInstalledTools,
      yes,
      names.some((t) => !t.base),
    );
    console.log("\nDone. Reload pi (/reload) or start a new session to pick up changes.");
  } else if (cmd === "status") {
    for (const t of names) {
      if (!t.base && !existsSync(t.dir)) {
        console.error(`Profile '${t.name}' not found at ${t.dir}. Run install first.`);
        continue;
      }
      console.log(`==> status -> ${t.base ? "base" : t.name} (${t.dir})`);
      doStatus(t, profiles);
    }
  } else if (cmd === "pull") {
    for (const t of names) {
      if (!t.base && !existsSync(t.dir)) {
        console.error(`Profile '${t.name}' not found at ${t.dir}. Run install first.`);
        continue;
      }
      console.log(`==> pull -> ${t.base ? "base" : t.name} (${t.dir})`);
      doPull(t, profiles);
    }
  }
}

// Only run main() when invoked directly (so the module is also importable for
// unit tests of the helper functions without triggering a full install).
const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
