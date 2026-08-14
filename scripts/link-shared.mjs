#!/usr/bin/env node
// Link shared-but-ignored dirs (e.g. reference-impl/) from the main worktree
// into the current worktree. Git worktrees only check out tracked files, so
// anything gitignored is left behind — this restores the shared copies via
// symlinks so they're present without being committed or duplicated on disk.
//
// Idempotent and safe:
//   - main worktree: no-op (the canonical copy already lives there)
//   - linked worktree missing the dir: creates a symlink to the main copy
//   - symlink already pointing at the right place: no-op
//   - real dir/file already present (user's own copy): left alone, warns
//
// Intended to be called from .envrc (direnv) so entering any worktree
// auto-links, but can also be run on demand: `node scripts/link-shared.mjs`.
//
// To share more ignored dirs, add their top-level names to SHARED_DIRS below.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Top-level gitignored dirs that should be shared across worktrees.
const SHARED_DIRS = ["reference-impl"];

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function main() {
  const cwd = process.cwd();

  // Resolve the main worktree root: parent dir of the shared .git common dir.
  let commonDir;
  try {
    commonDir = git(["rev-parse", "--git-common-dir"]);
  } catch {
    console.error("link-shared: not inside a git worktree/repo; skipping");
    return;
  }
  const mainRoot = path.dirname(path.resolve(commonDir)); // .../repo/.git -> .../repo

  // Determine the current worktree's own root.
  let topRoot;
  try {
    topRoot = git(["rev-parse", "--show-toplevel"]);
  } catch {
    topRoot = cwd;
  }
  const inMain = path.resolve(topRoot) === path.resolve(mainRoot);

  for (const name of SHARED_DIRS) {
    const source = path.join(mainRoot, name);
    const target = path.join(topRoot, name);

    if (inMain) {
      // Canonical location; nothing to link.
      continue;
    }

    if (!existsSync(source)) {
      // No canonical copy to link from — skip silently (AGENTS.md tells agents
      // to ask the user to clone it).
      continue;
    }

    if (!existsSync(target)) {
      symlinkSync(source, target);
      console.log(`link-shared: linked ${name} -> ${path.relative(topRoot, source) || source}`);
      continue;
    }

    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      const resolved = readlinkSync(target);
      const real = path.resolve(path.dirname(target), resolved);
      if (real === path.resolve(source)) {
        // Already correctly linked.
        continue;
      }
      console.warn(
        `link-shared: ${name} is a symlink but points elsewhere (${resolved}); leaving as-is`,
      );
      continue;
    }

    // A real dir/file the user placed there — never clobber.
    console.warn(
      `link-shared: ${name} exists as a real ${st.isDirectory() ? "directory" : "file"}; leaving as-is (remove it to re-link)`,
    );
  }
}

try {
  main();
} catch (err) {
  console.error(`link-shared: ${err.message}`);
  process.exit(1);
}
