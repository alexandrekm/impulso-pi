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
//   ./install.sh [install] <profile>  sync one profile (e.g. work-dev)
//   ./install.sh [install] <group>    sync every profile in a group (e.g. work)
//   ./install.sh [install] --all       sync every profile in profiles.jsonc
//   ./install.sh [install] --base      sync raw ~/.pi/agent with ALL resources
//   ./install.sh status [target]      show per-file sync state, no changes
//   ./install.sh pull   [target]      promote local edits back into the repo
//
// Target is a profile name, a group name, --all, or --base. status/pull take
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
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";

import { loadProfiles, validateProfiles, classify, resourcesForProfile } from "./profiles.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, "..");
const PROFILES_JSON = join(REPO_DIR, "profiles.jsonc");

const PI_ROOT = process.env.PPI_PI_ROOT || join(homedir(), ".pi");
const PROFILES_DIR = join(PI_ROOT, "profiles");
const AGENT_DIR = process.env.PI_AGENT_DIR || join(PI_ROOT, "agent");

const MANIFEST_NAME = ".impulso-pi-manifest.tsv";
const COMMANDS = new Set(["install", "status", "pull"]);

// ---- hashing -------------------------------------------------------------

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function hashFile(p) {
  return sha256(readFileSync(p));
}

// Deterministic, order-independent hash of a directory's contents, matching
// the prior bash installer's `find -print0 | sort -z | xargs shasum | shasum`.
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
  const blob = files.map((fp) => `${sha256(readFileSync(fp))}  ${fp}`).join("\n") + "\n";
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
  if (kind === "npm") return null;
  const rel = kind === "skill" ? key.replace(/\/$/, "") : key;
  return join(REPO_DIR, rel);
}

function destPath(dir, key) {
  const kind = classify(key);
  if (kind === "npm") return null;
  if (kind === "file") return join(dir, "extensions", basename(key));
  return join(dir, "skills", basename(key.replace(/\/$/, "")));
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
  if (spec.group) {
    return (profiles.groups?.[spec.group] || []).map((name) => ({
      name,
      base: false,
      dir: join(PROFILES_DIR, name),
    }));
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
  const groups = Object.keys(profiles.groups || {}).sort();
  const opts = [];
  for (const p of profs) opts.push({ label: `profile: ${p}`, spec: { profile: p } });
  for (const g of groups) opts.push({ label: `group:  ${g}`, spec: { group: g } });
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
  console.error("Groups:   " + Object.keys(profiles.groups || {}).join(", "));
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

  // ppi: required when any target is a profile/group/all.
  if (needsPpi && !hasCmd("ppi")) {
    items.push({ key: "ppi", kind: "ppi", label: "ppi (pi-profiles)", state: "missing" });
  }

  // npm packages: union across targets.
  const npmKeys = new Set();
  for (const t of names) {
    for (const k of keysForTarget(t, profiles)) {
      if (classify(k) === "npm") npmKeys.add(k);
    }
  }

  for (const key of [...npmKeys].sort()) {
    const pkgName = pkgNameFromSpec(key);
    // installed everywhere? (manifest marker present in every target)
    const installedEverywhere = names.every((t) => manifestGet(manifestRead(t.dir), key));
    if (!installedEverywhere) {
      items.push({ key, kind: "npm", label: key, state: "missing" });
      continue;
    }
    // installed everywhere — check for an update (first target's version)
    const installed = installedPkgVersion(names[0].dir, pkgName);
    const latest = latestVersion(pkgName);
    if (installed && latest && installed !== latest) {
      items.push({
        key,
        kind: "npm",
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
    const ans = await rl.question(`Install which? [all/<numbers>/none] (default: all): `);
    rl.close();
    const a = ans.trim().toLowerCase();
    if (a === "" || a === "all") {
      selected = items.map((it) => it.key);
    } else if (a === "none") {
      selected = [];
    } else {
      const idxs = a
        .split(/[,\s]+/)
        .map((s) => parseInt(s, 10) - 1)
        .filter((n) => !Number.isNaN(n) && n >= 0 && n < items.length);
      selected = idxs.map((i) => items[i].key);
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
    if (!it || it.kind !== "npm") continue;
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

// ---- per-target file sync ------------------------------------------------

function doInstallFiles(t, profiles) {
  const keys = keysForTarget(t, profiles).filter((k) => classify(k) !== "npm");
  const map = manifestRead(t.dir);
  mkdirSync(join(t.dir, "extensions"), { recursive: true });
  mkdirSync(join(t.dir, "skills"), { recursive: true });
  for (const key of keys) {
    const src = srcPath(key);
    const dest = destPath(t.dir, key);
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
  const keys = keysForTarget(t, profiles);
  const map = manifestRead(t.dir);
  for (const key of keys) {
    if (classify(key) === "npm") {
      const state = manifestGet(map, key) ? "in sync" : "not installed";
      console.log(`  ${key.padEnd(43)} ${state}`);
      continue;
    }
    const src = srcPath(key);
    const dest = destPath(t.dir, key);
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
  const keys = keysForTarget(t, profiles).filter((k) => classify(k) !== "npm");
  const map = manifestRead(t.dir);
  let pulled = 0;
  for (const key of keys) {
    const src = srcPath(key);
    const dest = destPath(t.dir, key);
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
    else if (profiles.groups?.[target]) spec = { group: target };
    else {
      console.error(`Unknown target '${target}'. Not a profile or group.`);
      printAvailable(profiles);
      process.exit(1);
    }
  }

  if (!spec) {
    if (process.stdin.isTTY) {
      spec = await chooseSpec(profiles);
    } else {
      console.error(
        "No target specified (and stdin is not interactive). Use a profile/group name, --all, or --base.",
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
      doInstallFiles(t, profiles);
    }
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

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
