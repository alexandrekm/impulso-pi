#!/usr/bin/env node
// measure-context: record what each pi profile's first model request is
// made of, via the context-measure recording provider — no HTTP, no
// synthetic server, no network.
//
// For each target it boots the real pi CLI headless (RPC mode, no session)
// against the real agent dir (extensions, skills, packages, settings load
// exactly as in a live session), sends one prompt to
// `measure/measure-model`, and reads the JSONL record the provider wrote.
// The first request is the measurement: its systemPromptChars is the
// "instructions" segment, its toolSchemaChars the tool-schema segment,
// their sum the context the profile pays before any work happens.
//
// Targets:
//   stock     — a disposable empty agent dir (recorder copied in), the
//               baseline. The recorder registers no tools and adds no
//               prompt text, so stock+recorder === stock.
//   work      — ~/.pi/profiles/work
//   personal  — ~/.pi/profiles/personal
//   base      — ~/.pi/agent
//
// Usage:
//   npm run measure:context                      # measure all targets, print
//   npm run measure:context -- --json            # machine-readable output
//   npm run measure:context -- --record          # also write the committed
//                                                # record under investigation/
//   npm run measure:context -- --targets=stock,personal
//
// Method notes (kept next to the data): counts are characters of pi's
// intermediate request representation (JSON.stringify of the composed
// system prompt, tool array, and messages), not a wire format — so they
// are NOT comparable to wire-format measurements (e.g. SpecPi's chart)
// but ARE comparable across profiles and across time. Paths/dates inside
// prompts make counts vary slightly per machine; the committed record is
// per-machine by nature. Characters are not tokens, cost, or quality.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD_PATH = path.join(REPO, "investigation/context-measurement.json");
const RECORDER = path.join(REPO, "extensions/context-measure/context-measure.ts");
const FEATURE_FLAG = path.join(REPO, "extensions/impulso-settings/feature-flag.ts");

const ALL_TARGETS = ["stock", "work", "personal", "base"];
const PROMPT = "Reply with ok.";
const PER_TARGET_TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const doRecord = args.includes("--record");
const targetsArg = args.find((a) => a.startsWith("--targets="));
const piBin = (args.find((a) => a.startsWith("--pi=")) ?? "").slice("--pi=".length) || "pi";

const targets = targetsArg
  ? targetsArg
      .slice("--targets=".length)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  : [...ALL_TARGETS];

for (const target of targets) {
  if (!ALL_TARGETS.includes(target)) {
    console.error(`Unknown target '${target}'. Valid: ${ALL_TARGETS.join(", ")}`);
    process.exit(2);
  }
}

function fail(message) {
  console.error(String(message));
  process.exit(1);
}

/** A disposable empty agent dir with just the recorder (stock baseline). */
function stockAgentDir() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(homedir()), ".pi-measure-stock-"));
  fs.mkdirSync(path.join(dir, "extensions/impulso-settings"), { recursive: true });
  // The recorder imports ../impulso-settings/feature-flag.ts (isFeatureEnabled
  // guard, same convention as every local extension) — copy both so the
  // relative import resolves in the temp dir.
  fs.copyFileSync(RECORDER, path.join(dir, "extensions/context-measure.ts"));
  fs.copyFileSync(FEATURE_FLAG, path.join(dir, "extensions/impulso-settings/feature-flag.ts"));
  return dir;
}

function agentDirFor(target) {
  if (target === "stock") return stockAgentDir();
  if (target === "base") return path.join(homedir(), ".pi/agent");
  return path.join(homedir(), ".pi/profiles", target);
}

function piVersion() {
  const result = spawnSync(piBin, ["--version"], { encoding: "utf8" });
  return (result.stdout || result.stderr || "").trim();
}

/** Read /proc-style JSONL from the recorder's output file. */
function readRecords(outPath) {
  try {
    return fs
      .readFileSync(outPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Measure one agent dir: boot pi headless, one prompt, return the first
 * request record. The recorder provider is installed in every target
 * (core resource; for `stock` the script copies it in).
 */
async function measureTarget(target) {
  const agentDir = agentDirFor(target);
  if (!fs.existsSync(agentDir)) {
    fail(`Agent dir for '${target}' does not exist: ${agentDir}`);
  }

  const workDir = fs.mkdtempSync(path.join(fs.realpathSync(homedir()), ".pi-measure-ws-"));
  const outPath = path.join(workDir, "records.jsonl");
  const child = spawn(
    piBin,
    ["--mode", "rpc", "--no-session", "--provider", "measure", "--model", "measure-model"],
    {
      cwd: workDir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CONTEXT_MEASURE_OUT: outPath,
        PI_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  let buffer = "";
  const events = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr += text;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    // RPC framing: LF only (readline would also split on U+2028/2029).
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Startup diagnostics are not JSON — ignore.
      }
    }
  });

  const closed = new Promise((resolve) => child.once("close", resolve));
  const command = (payload) => child.stdin.write(JSON.stringify(payload) + "\n");

  try {
    const deadline = Date.now() + PER_TARGET_TIMEOUT_MS;
    const waitFor = async (predicate, what) => {
      while (!predicate()) {
        if (child.exitCode !== null) {
          fail(`pi exited during '${target}' while waiting for ${what}.\n${stderr}`);
        }
        if (Date.now() > deadline) {
          fail(`Timed out on '${target}' waiting for ${what}.\n${stderr.slice(-2000)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    command({ id: "ready", type: "get_state" });
    await waitFor(
      () => events.some((e) => e.type === "response" && e.id === "ready"),
      "the RPC session to start",
    );
    const failure = events.find((e) => e.type === "extension_error");
    if (failure) {
      fail(`An extension failed to load in '${target}': ${JSON.stringify(failure)}`);
    }

    command({ id: "measure", type: "prompt", message: PROMPT });
    await waitFor(() => events.some((e) => e.type === "agent_end"), "the agent turn to finish");

    const records = readRecords(outPath);
    if (records.length === 0) {
      fail(
        `No request was recorded for '${target}'. Is the context-measure feature ` +
          `disabled in that profile's settings (impulso-settings.json)? ` +
          `Re-enable it in /settings → Observability, or run ./install.sh.\n${stderr.slice(-2000)}`,
      );
    }
    if (records.length > 1) {
      console.error(
        `note: ${records.length} requests recorded for '${target}'; using the first ` +
          `(a retry or compaction fired mid-turn)`,
      );
    }
    return { target, record: records[0] };
  } finally {
    child.stdin.end();
    child.kill();
    await closed;
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (target === "stock") {
      fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

/** Load the previously committed record, for delta reporting. */
function previousRecord() {
  try {
    return JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

async function main() {
  if (!fs.existsSync(RECORDER)) fail(`Recorder extension missing: ${RECORDER}`);
  const version = piVersion();
  const previous = previousRecord();
  const rows = [];
  for (const target of targets) {
    process.stderr.write(`Measuring ${target}...\n`);
    rows.push(await measureTarget(target));
  }
  const report = {
    schema: 1,
    measuredAt: new Date().toISOString(),
    piVersion: version,
    nodeVersion: process.version,
    platform: process.platform,
    method:
      "First composed request captured by the context-measure recording provider " +
      "(extensions/context-measure): pi booted headless (RPC, --no-session) against the " +
      "real agent dir, one prompt to measure/measure-model. Counts are characters of " +
      "pi's intermediate request representation (JSON.stringify of the composed system " +
      "prompt, tool-definition array, and messages) — not a wire format, so not " +
      "comparable to wire-format measurements, but comparable across profiles and time. " +
      "contextChars = systemPromptChars + toolSchemaChars. Paths/dates inside prompts " +
      "make counts vary slightly per machine. Not tokens, cost, or quality.",
    targets: rows,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const header = `target      tools  system  toolsSchema  contextChars${previous ? "  vs committed" : ""}`;
    console.log(`pi ${version}`);
    console.log(header);
    for (const { target, record } of rows) {
      const oldRow = previous?.targets?.find((row) => row.target === target);
      let delta = "";
      if (oldRow) {
        const diff = record.contextChars - oldRow.record.contextChars;
        delta = `  ${diff >= 0 ? "+" : ""}${diff}`;
      }
      console.log(
        `${target.padEnd(11)} ${String(record.toolCount).padStart(5)}  ${String(record.systemPromptChars).padStart(6)}  ` +
          `${String(record.toolSchemaChars).padEnd(11)}  ${String(record.contextChars).padStart(11)}${delta}`,
      );
    }
  }

  if (doRecord) {
    // The committed record is the full picture; a partial --targets run
    // must never clobber it (measure the subset, print it, just don't record).
    const measured = targets.slice().sort().join(",");
    const full = [...ALL_TARGETS].sort().join(",");
    if (measured !== full) {
      fail(`--record requires all targets (${ALL_TARGETS.join(",")}); got: ${targets.join(",")}`);
    }
    fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
    fs.writeFileSync(RECORD_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.error(`Record written: ${path.relative(process.cwd(), RECORD_PATH)}`);
    // Machine-local copy for the pi-omp-stats dashboard: the service runs
    // from the stats dir (~/.pi/agent) and can't assume this repo's path,
    // so --record drops the same JSON next to its DB, where
    // /api/stats/context reads it.
    const statsDir = process.env.PI_STATS_DIR?.trim() || path.join(homedir(), ".pi", "agent");
    const statsPath = path.join(statsDir, "context-measurement.json");
    fs.mkdirSync(statsDir, { recursive: true });
    fs.copyFileSync(RECORD_PATH, statsPath);
    console.error(`Dashboard copy: ${statsPath}`);
  }
}

main().catch((error) => fail(error?.stack ?? error));
