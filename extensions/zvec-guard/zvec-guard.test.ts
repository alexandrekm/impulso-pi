import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

// Feature-flag reads PI_CODING_AGENT_DIR at module load; point it at a
// throwaway config dir so the tests never see (or touch) the real manifest.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "impulso-cfg-"));
process.env.PI_CODING_AGENT_DIR = CONFIG_DIR;

const {
  default: factory,
  assessRoot,
  bestRealPath,
  countNestedRepos,
  isNetworkFsRoot,
  loadRootPolicy,
  mountTypeFor,
  normalizeRoot,
  parseMounts,
  setMountTable,
} = await import("./zvec-guard.ts");

// Hermetic: prime a purely local mount table so the network-fs rule never
// depends on the host's real mounts (reset in the after() hook).
setMountTable([{ point: "/", type: "apfs" }]);

const MANIFEST = join(CONFIG_DIR, "impulso-settings.json");

/** A throwaway tree with `count` nested git repos under `root/<name>/`. */
function makeUmbrella(count: number, gitStyle: "dir" | "file" = "dir"): string {
  const root = mkdtempSync(join(tmpdir(), "impulso-umbrella-"));
  for (let i = 0; i < count; i += 1) {
    const repo = join(root, `sub${i}`);
    mkdirSync(repo, { recursive: true });
    if (gitStyle === "dir") mkdirSync(join(repo, ".git"));
    else writeFileSync(join(repo, ".git"), "gitdir: /elsewhere\n");
  }
  return root;
}

const ZVEC_CONFIG_DIR = join(CONFIG_DIR, "pi-zvec-grep");

/** Write a pi-zvec-grep config with the given rootPolicy (user layer). */
function setRootPolicy(policy: {
  allowRoots: string[];
  maxNestedRepos: number;
  allowNetworkFs?: boolean;
}): void {
  mkdirSync(ZVEC_CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(ZVEC_CONFIG_DIR, "config.json"),
    JSON.stringify({ rootPolicy: policy }),
    "utf8",
  );
}

function setDisabled(featureId: string | null): void {
  if (featureId === null) rmSync(MANIFEST, { force: true });
  else writeFileSync(MANIFEST, JSON.stringify({ disabled: [featureId] }), "utf8");
}

/** Fresh handler with zvec-guard enabled (no manifest = everything on). */
function enabledHandler() {
  setDisabled(null);
  const hooks: Array<(event: unknown, ctx: unknown) => unknown> = [];
  factory({ on: (_name: string, fn: (event: unknown, ctx: unknown) => unknown) => hooks.push(fn) });
  assert.equal(hooks.length, 1, "exactly one tool_call hook registered");
  return hooks[0];
}

function call(root: unknown, mode: unknown, toolName = "zvec_index", cwd?: string) {
  return enabledHandler()(
    { toolName, input: mode === undefined && root === undefined ? {} : { root, mode } },
    cwd === undefined ? {} : { cwd },
  );
}

describe("factory", () => {
  test("registers nothing when the feature is disabled", () => {
    setDisabled("zvec-guard");
    const hooks: unknown[] = [];
    factory({ on: () => hooks.push(1) });
    assert.equal(hooks.length, 0);
  });

  test("registers exactly one hook when enabled", () => {
    enabledHandler(); // asserts internally
  });
});

describe("hook", () => {
  test("ignores non-zvec_index tools entirely", async () => {
    const result = await call("~", "index", "bash");
    assert.equal(result, undefined);
  });

  test("blocks indexing $HOME (bare ~)", async () => {
    const result = (await call("~", undefined)) as { block: boolean; reason: string };
    assert.ok(result && result.block === true);
    assert.match(result.reason, /\[zvec-guard\]/);
    assert.match(result.reason, /zg index ~ --drop --yes/);
  });

  test("blocks indexing $HOME (absolute)", async () => {
    const result = (await call(homedir(), "index")) as { block: boolean };
    assert.ok(result && result.block === true);
  });

  test("blocks indexing $HOME on rebuild", async () => {
    const result = (await call("~/", "rebuild")) as { block: boolean };
    assert.ok(result && result.block === true);
  });

  test("blocks $HOME reached via a relative path from a home cwd", async () => {
    // cwd = $HOME, root "." → normalizeRoot resolves to $HOME → blocked.
    const result = (await call(".", "index", "zvec_index", homedir())) as { block: boolean };
    assert.ok(result && result.block === true);
  });

  test("allows dropping a home index (remediation path)", async () => {
    const result = await call("~", "drop");
    assert.equal(result, undefined);
  });

  test("allows a normal workspace root", async () => {
    // NOT tmpdir() itself: on CI it is shared with concurrently running
    // suites that create nested git-repo fixtures there, and the umbrella
    // heuristic would correctly block it. A fresh empty dir is the real
    // "normal workspace" case.
    const plain = mkdtempSync(join(tmpdir(), "impulso-plain-"));
    assert.equal(await call(plain, "index"), undefined);
  });

  test("allows a workspace root that does not exist yet (realpath fallback)", async () => {
    assert.equal(await call(join(tmpdir(), "fresh-workspace-xyz"), "index"), undefined);
  });

  test("passes through when no root argument is present", async () => {
    const h = enabledHandler();
    const result = await h({ toolName: "zvec_index", input: {} }, {});
    assert.equal(result, undefined);
  });
});

describe("normalizeRoot", () => {
  const base = "/work";

  test("returns undefined for missing / non-string / blank roots", () => {
    assert.equal(normalizeRoot(undefined, base), undefined);
    assert.equal(normalizeRoot(42, base), undefined);
    assert.equal(normalizeRoot("   ", base), undefined);
  });

  test("expands bare ~ and ~/prefixed paths to the real home", () => {
    assert.equal(normalizeRoot("~", base), homedir());
    assert.equal(normalizeRoot("~/code", base), join(homedir(), "code"));
  });

  test("strips a leading @ (tool-path convention)", () => {
    assert.equal(normalizeRoot("@/abs/path", base), "/abs/path");
  });

  test("resolves relative roots against cwd when given, else process.cwd()", () => {
    assert.equal(normalizeRoot("sub/dir", "/work"), "/work/sub/dir");
    assert.equal(normalizeRoot("sub", undefined), join(process.cwd(), "sub"));
  });

  test("keeps absolute roots as-is", () => {
    assert.equal(normalizeRoot("/already/absolute", base), "/already/absolute");
  });
});

describe("bestRealPath", () => {
  test("realpaths existing paths", () => {
    // macOS tmpdir resolves through /private; the realpath must reflect that.
    assert.equal(bestRealPath(tmpdir()), realpathSync(tmpdir()));
  });

  test("falls back to resolve() for non-existent paths", () => {
    const missing = join(tmpdir(), "does-not-exist-zvec-guard-test");
    assert.ok(!existsSync(missing));
    assert.equal(bestRealPath(missing), resolve(missing));
  });
});

describe("root policy (umbrella roots)", () => {
  test("countNestedRepos counts depth-1 .git dirs", () => {
    assert.equal(countNestedRepos(makeUmbrella(3)), 3);
  });

  test("worktree-style .git files count as nested repos", () => {
    assert.equal(countNestedRepos(makeUmbrella(3, "file")), 3);
  });

  test("depth-2 repos are counted (a directory-of-repos layout)", () => {
    const root = mkdtempSync(join(tmpdir(), "impulso-deep-"));
    mkdirSync(join(root, "group", "a", ".git"), { recursive: true });
    mkdirSync(join(root, "group", "b", ".git"), { recursive: true });
    mkdirSync(join(root, "group", "c", ".git"), { recursive: true });
    assert.equal(countNestedRepos(root), 3);
  });

  test("a found repo is not descended into; noise dirs are skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "impulso-noise-"));
    mkdirSync(join(root, "repo", ".git", "objects"), { recursive: true });
    mkdirSync(join(root, "node_modules", "dep", ".git"), { recursive: true });
    assert.equal(countNestedRepos(root), 1);
  });

  test("two nested repos stay under the default threshold of 3", () => {
    assert.equal(assessRoot(makeUmbrella(2)).allowed, true);
  });

  test("three or more nested repos mark an umbrella root", () => {
    const verdict = assessRoot(makeUmbrella(3));
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? "", /umbrella/);
    assert.match(verdict.reason ?? "", /allowRoots/);
  });

  test("the threshold is configurable via maxNestedRepos", () => {
    assert.equal(
      assessRoot(makeUmbrella(2), { allowRoots: [], maxNestedRepos: 2, allowNetworkFs: false })
        .allowed,
      false,
    );
  });

  test("allowRoots bypasses the umbrella rule (realpath-matched)", () => {
    const umbrella = makeUmbrella(5);
    assert.equal(
      assessRoot(umbrella, { allowRoots: [umbrella], maxNestedRepos: 3, allowNetworkFs: false })
        .allowed,
      true,
    );
    assert.equal(
      assessRoot(realpathSync(umbrella), {
        allowRoots: [umbrella],
        maxNestedRepos: 3,
        allowNetworkFs: false,
      }).allowed,
      true,
    );
  });

  test("allowRoots never unlocks $HOME", () => {
    assert.equal(
      assessRoot("~", { allowRoots: ["~"], maxNestedRepos: 3, allowNetworkFs: true }).allowed,
      false,
    );
  });
});

describe("root policy config (pi-zvec-grep/config.json)", () => {
  test("loadRootPolicy returns built-in defaults without a config file", () => {
    rmSync(ZVEC_CONFIG_DIR, { recursive: true, force: true });
    assert.deepEqual(loadRootPolicy(), {
      allowRoots: [],
      maxNestedRepos: 3,
      allowNetworkFs: false,
    });
  });

  test("loadRootPolicy reads the user-layer rootPolicy", () => {
    setRootPolicy({ allowRoots: ["~/umbrella-ok"], maxNestedRepos: 5 });
    assert.deepEqual(loadRootPolicy(), {
      allowRoots: ["~/umbrella-ok"],
      maxNestedRepos: 5,
      allowNetworkFs: false,
    });
  });

  test("invalid values fall back per sub-key, never to garbage", () => {
    setRootPolicy({ allowRoots: ["ok", 42, ""] as unknown as string[], maxNestedRepos: -1 });
    assert.deepEqual(loadRootPolicy(), {
      allowRoots: ["ok"],
      maxNestedRepos: 3,
      allowNetworkFs: false,
    });
  });

  test("the hook blocks an umbrella root and honors allowRoots from the config", async () => {
    rmSync(ZVEC_CONFIG_DIR, { recursive: true, force: true });
    const umbrella = makeUmbrella(3);
    const blocked = (await call(umbrella, "index")) as { block: boolean; reason: string };
    assert.ok(blocked && blocked.block === true);
    assert.match(blocked.reason, /umbrella/);

    setRootPolicy({ allowRoots: [umbrella], maxNestedRepos: 3, allowNetworkFs: false });
    assert.equal(await call(umbrella, "index"), undefined);
    rmSync(ZVEC_CONFIG_DIR, { recursive: true, force: true });
  });

  test("drop on an umbrella root stays allowed (remediation path)", async () => {
    assert.equal(await call(makeUmbrella(3), "drop"), undefined);
  });
});

describe("network filesystem detection", () => {
  test("parseMounts accepts Linux mount(8), macOS mount(8) and /proc/self/mounts shapes", () => {
    const parsed = parseMounts(
      [
        "/dev/disk1s1 on / (apfs, local, journaled)",
        "//u@s/share on /Volumes/share (smbfs)",
        "server:/e on /mnt/nfs (nfs)",
        "/dev/sda1 on /boot type ext4 (rw,relatime)",
        "server:/e /proc/shape/nfs nfs4 rw 0 0",
        "junk line",
      ].join("\n"),
    );
    assert.deepEqual(
      parsed.map((m) => [m.point, m.type]),
      [
        ["/", "apfs"],
        ["/Volumes/share", "smbfs"],
        ["/mnt/nfs", "nfs"],
        ["/boot", "ext4"],
        ["/proc/shape/nfs", "nfs4"],
      ],
    );
  });

  test("mountTypeFor resolves by longest prefix; the mount point itself matches", () => {
    const table = parseMounts(
      [
        "/dev/disk1s1 on / (apfs, local)",
        "//u@s/d on /Volumes/data (smbfs)",
        "server:/x on /Volumes/data/deep/export (nfs)",
      ].join("\n"),
    );
    assert.equal(mountTypeFor("/Volumes/data/file", table), "smbfs");
    assert.equal(mountTypeFor("/Volumes/data/deep/export/file", table), "nfs");
    assert.equal(
      mountTypeFor("/Volumes/data/deep/export", table),
      "nfs",
      "the mount point itself matches",
    );
    assert.equal(mountTypeFor("/System", table), "apfs");
    assert.equal(mountTypeFor("/no/match", [{ point: "/mnt/x", type: "nfs" }]), undefined);
  });

  test("isNetworkFsRoot flags network mounts and fails open on unknown roots", () => {
    const table = [
      { point: "/mnt/local", type: "apfs" },
      { point: "/mnt/nfs", type: "nfs" },
      { point: "/mnt/sshfs", type: "fuse.sshfs" },
    ];
    assert.equal(isNetworkFsRoot("/mnt/nfs/work", table), true);
    assert.equal(isNetworkFsRoot("/mnt/sshfs/work", table), true);
    assert.equal(isNetworkFsRoot("/mnt/local/work", table), false);
    assert.equal(isNetworkFsRoot("/elsewhere/work", table), false, "no mount match fails open");
  });

  test("assessRoot blocks network roots; allowNetworkFs and allowRoots override", () => {
    const nfsRoot = join(tmpdir(), "impulso-netfs-root");
    mkdirSync(nfsRoot, { recursive: true });
    const real = realpathSync(nfsRoot);
    const mounts = [
      { point: "/", type: "apfs" },
      { point: real, type: "nfs" },
    ];
    const blocked = assessRoot(
      nfsRoot,
      { allowRoots: [], maxNestedRepos: 3, allowNetworkFs: false },
      mounts,
    );
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason ?? "", /network filesystem/i);
    assert.match(blocked.reason ?? "", /allowNetworkFs/);
    const allowed = assessRoot(
      nfsRoot,
      { allowRoots: [], maxNestedRepos: 3, allowNetworkFs: true },
      mounts,
    );
    assert.equal(allowed.allowed, true);
    const viaAllowRoots = assessRoot(
      nfsRoot,
      { allowRoots: [nfsRoot], maxNestedRepos: 3, allowNetworkFs: false },
      mounts,
    );
    assert.equal(viaAllowRoots.allowed, true);
  });

  test("loadRootPolicy reads allowNetworkFs from the user-layer config", () => {
    setRootPolicy({ allowRoots: [], maxNestedRepos: 3, allowNetworkFs: false });
    assert.equal(loadRootPolicy().allowNetworkFs, false, "absent key -> default off");
    writeFileSync(
      join(ZVEC_CONFIG_DIR, "config.json"),
      JSON.stringify({ rootPolicy: { allowNetworkFs: true } }),
      "utf8",
    );
    assert.equal(loadRootPolicy().allowNetworkFs, true);
    writeFileSync(
      join(ZVEC_CONFIG_DIR, "config.json"),
      JSON.stringify({ rootPolicy: { allowNetworkFs: "yes" } }),
      "utf8",
    );
    assert.equal(loadRootPolicy().allowNetworkFs, false, "invalid value -> default off");
  });
});

after(() => {
  setMountTable([{ point: "/", type: "apfs" }]);
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});
