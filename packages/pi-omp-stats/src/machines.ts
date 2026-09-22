/**
 * @fileoverview Remote machine sources: mirror session JSONLs from other
 * machines over SSH into a local cache so the aggregator can index them like
 * local profiles.
 *
 * Design constraints (learned from the devbox ssh config):
 *  - **Never wake a machine to probe it.** Devbox ssh ProxyCommands auto-start
 *    a stopped instance on connect, so plain `ssh host true` as an
 *    availability check would spin up (and bill) an idle box. AWS machines are
 *    therefore probed read-only via the EC2/SSM APIs (`state` + SSM ping),
 *    and ssh is only ever opened after the probe says the machine is up.
 *  - **Devbox connections must not collide.** A devbox host may carry
 *    `LocalForward` lines (a second connection fails to bind if one is
 *    already open) and `Match` LocalCommand hooks. Sync connections therefore
 *    pass
 *    `-o ClearAllForwardings=yes -o PermitLocalCommand=no`.
 *  - **The mirror is pull-only and opportunistic.** rsync runs only when the
 *    probe says the machine is up and the last successful sync is older than
 *    `syncTtlMinutes` (default 30). Machines come and go; unavailability is a
 *    skip, never an error.
 *
 * Machine registry: hosts in `~/.ssh/config` whose `HostName` is an EC2
 * instance id (kind "aws", region parsed from the ProxyCommand) are
 * discovered automatically; `<statsDir>/machines.json` can add ssh-only hosts
 * (kind "ssh") and override per-host settings (e.g. `includeInAll`).
 *
 * The local mirror lives at `<statsDir>/stats-machines/<host>/profiles/<p>/sessions`
 * and only ever contains `sessions/` trees (rsync include filter); the remote
 * machine needs nothing installed except sshd (and, for aws machines, the
 * SSM agent it already runs).
 */

import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveStatsDir } from "./parser.js";
import { sanitizeProfileId } from "./db.js";
import type { SessionsSource } from "./parser.js";

export interface MachineConfig {
  host: string;
  kind: "aws" | "ssh";
  instanceId?: string;
  region?: string;
  remoteProfilesPath?: string;
  includeInAll?: boolean;
  enabled?: boolean;
}

export interface ProbeResult {
  state: string;
  ssmOnline: boolean | null;
  /** Why the probe failed, when it did (aws CLI missing/expired creds…) —
   *  surfaced in the Machines tab so "unknown" is diagnosable. */
  error?: string;
}

export interface SyncState {
  lastSyncAt: number | null;
  /** Persisted on disk: only real sync outcomes (ok/error). "skipped" is a
   * transient, return-only status (down machine / TTL guard / busy) — the
   * record on disk keeps the last real sync intact. */
  lastStatus: "ok" | "error" | "skipped";
  lastError?: string;
  files?: number;
  bytes?: number;
  durationMs?: number;
}

export interface MachineSummary {
  sessions: number;
  requests: number;
  tokens: number;
  cost: number;
  lastActivityMs: number | null;
}

export interface MachineSource extends SessionsSource {
  machine: string;
  includeInAll: boolean;
}

export interface MachineOverview extends SyncState {
  host: string;
  kind: "aws" | "ssh";
  state: string;
  ssmOnline: boolean | null;
  /** Probe failure reason when state is "unknown". */
  probeError?: string;
  views: string[];
  syncing: boolean;
  includeInAll: boolean;
  summary: MachineSummary | null;
}

interface MachinesFile {
  syncTtlMinutes?: number;
  probeTtlMinutes?: number;
  machines?: MachineConfig[];
}

const DEFAULT_SYNC_TTL_MIN = 30;
const DEFAULT_PROBE_TTL_MIN = 5;
const RSYNC_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
/** Machine hosts must be plain identifiers (ssh-alias style). Enforced once
 * in {@link listMachines}: hosts flow into path.join for the mirror and
 * sync-state paths and into ssh/rsync command lines. */
const SAFE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** ssh options that make sync connections safe next to open devbox sessions. */
const SSH_SYNC_OPTS =
  "-o ClearAllForwardings=yes -o PermitLocalCommand=no -o BatchMode=yes -o ConnectTimeout=20";

/* In-process state: one sync per host at a time, and short-lived probe cache
 * so a dashboard poll never re-runs the aws CLI for every request. */
const syncingHosts = new Set<string>();
const probeCache = new Map<string, { result: ProbeResult; at: number }>();

let machinesConfig: { file: MachinesFile; at: number } | null = null;

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/** Root of the local machine mirror (never scanned as a local profile). */
export function machinesDir(): string {
  return path.join(resolveStatsDir(), "stats-machines");
}

/** Read `<statsDir>/machines.json` (tolerant: absent/invalid → defaults). */
async function readMachinesFile(): Promise<MachinesFile> {
  const file = path.join(resolveStatsDir(), "machines.json");
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as MachinesFile;
  } catch {
    /* absent or invalid — fall through to defaults */
  }
  return {};
}

async function getMachinesFile(): Promise<MachinesFile> {
  if (!machinesConfig || Date.now() - machinesConfig.at > 30_000) {
    machinesConfig = { file: await readMachinesFile(), at: Date.now() };
  }
  return machinesConfig.file;
}

/** Parse `~/.ssh/config` for hosts whose HostName is an EC2 instance id. */
function parseSshConfig(text: string): MachineConfig[] {
  const out: MachineConfig[] = [];
  let aliases: string[] = [];
  let instanceId: string | null = null;
  let region: string | null = null;
  const flush = (): void => {
    if (instanceId) {
      for (const host of aliases) {
        out.push({ host, kind: "aws", instanceId, region: region ?? undefined });
      }
    }
    aliases = [];
    instanceId = null;
    region = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (/^Host\s+/i.test(line)) {
      flush();
      aliases = line
        .replace(/^Host\s+/i, "")
        .trim()
        .split(/\s+/)
        .filter((a) => a && !a.includes("*") && !a.includes("?"));
    } else if (/^HostName\s+/i.test(line)) {
      const value = line.split(/\s+/)[1] ?? "";
      if (/^i-[0-9a-f]+$/i.test(value)) instanceId = value;
    } else if (/ProxyCommand/i.test(line)) {
      const match = line.match(/R=([a-z0-9-]+)/i);
      if (match) region = match[1];
    }
  }
  flush();
  return out;
}

/** All known machines: ssh-config discovery merged with machines.json. */
export async function listMachines(): Promise<MachineConfig[]> {
  const file = await getMachinesFile();
  const discovered = new Map<string, MachineConfig>();
  try {
    const sshConfig = await fsp.readFile(path.join(os.homedir(), ".ssh", "config"), "utf8");
    for (const m of parseSshConfig(sshConfig)) discovered.set(m.host, m);
  } catch {
    /* no ssh config — machines.json entries still apply */
  }
  for (const extra of file.machines ?? []) {
    if (!extra?.host) continue;
    if (!SAFE_HOST_RE.test(extra.host)) continue;
    const base = discovered.get(extra.host) ?? { host: extra.host, kind: extra.kind ?? "ssh" };
    discovered.set(extra.host, { ...base, ...extra, host: extra.host });
  }
  return [...discovered.values()].filter(
    // A host that fails the identifier check is dropped entirely: it flows
    // into path.join (mirror + sync-state) and ssh invocations, so anything
    // containing a path separator or traversal component is rejected here
    // rather than validated at each use site.
    (m) => m.enabled !== false && SAFE_HOST_RE.test(m.host),
  );
}

/* -------------------------------------------------------------------------- */
/* Probing (wake-safe)                                                          */
/* -------------------------------------------------------------------------- */

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

/** Probe an aws machine via the read-only EC2/SSM APIs (never wakes it). */
/** Common install locations for the aws CLI: launchd user agents run with
 * launchd's minimal PATH (/usr/bin:/bin:…), which misses Homebrew — a bare
 * execFile("aws") there fails ENOENT and every machine would read "unknown". */
function awsBin(): string {
  if (cachedAwsBin !== undefined) return cachedAwsBin;
  const candidates = [
    "aws",
    "/opt/homebrew/bin/aws",
    "/usr/local/bin/aws",
    "/usr/local/aws-cli/bin/aws",
    path.join(os.homedir(), ".local/bin/aws"),
    "/usr/bin/aws",
  ];
  cachedAwsBin =
    candidates.find((candidate) => candidate !== "aws" && fs.existsSync(candidate)) ?? "aws";
  return cachedAwsBin;
}
let cachedAwsBin: string | undefined;

async function probeAws(m: MachineConfig): Promise<ProbeResult> {
  const region = m.region ?? "us-east-1";
  if (!m.instanceId) return { state: "unknown", ssmOnline: null, error: "no instance id" };
  const state = await runCommand(
    awsBin(),
    [
      "ec2",
      "describe-instances",
      "--instance-ids",
      m.instanceId,
      "--query",
      "Reservations[].Instances[].State.Name",
      "--output",
      "text",
      "--region",
      region,
    ],
    PROBE_TIMEOUT_MS,
  );
  if (state !== "running") return { state, ssmOnline: false };
  const ping = await runCommand(
    awsBin(),
    [
      "ssm",
      "describe-instance-information",
      "--filters",
      `Key=InstanceIds,Values=${m.instanceId}`,
      "--query",
      "InstanceInformationList[].PingStatus",
      "--output",
      "text",
      "--region",
      region,
    ],
    PROBE_TIMEOUT_MS,
  );
  return { state, ssmOnline: ping === "Online" };
}

/**
 * Probe a machine. aws kind: read-only EC2 state + SSM ping (no ssh, so a
 * stopped instance is never woken). ssh kind: a batch-mode `ssh true` is safe
 * because non-aws hosts have no auto-start ProxyCommand.
 */
export async function probeMachine(m: MachineConfig): Promise<ProbeResult> {
  if (m.kind === "ssh") {
    try {
      // ssh options are first-match-wins, so the shorter probe timeout must
      // come BEFORE SSH_SYNC_OPTS (which pins ConnectTimeout=20 for syncs).
      await runCommand(
        "ssh",
        ["-o", "ConnectTimeout=5", ...SSH_SYNC_OPTS.split(" "), m.host, "true"],
        PROBE_TIMEOUT_MS,
      );
      return { state: "running", ssmOnline: null };
    } catch {
      return { state: "unreachable", ssmOnline: null };
    }
  }
  try {
    return await probeAws(m);
  } catch (error) {
    // ENOENT → aws missing entirely; anything else is usually expired/absent
    // credentials. Either way the reason must reach the Machines tab.
    const message =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "aws CLI not found"
        : error instanceof Error
          ? error.message.split("\n")[0].slice(0, 200)
          : String(error);
    return { state: "unknown", ssmOnline: null, error: message };
  }
}

async function probeCached(m: MachineConfig): Promise<ProbeResult> {
  const file = await getMachinesFile();
  const ttl = (file.probeTtlMinutes ?? DEFAULT_PROBE_TTL_MIN) * 60_000;
  const hit = probeCache.get(m.host);
  if (hit && Date.now() - hit.at < ttl) return hit.result;
  const result = await probeMachine(m);
  probeCache.set(m.host, { result, at: Date.now() });
  return result;
}

/** A machine is syncable only when the wake-safe probe says it is up. */
function isSyncable(m: MachineConfig, probe: ProbeResult): boolean {
  if (probe.state !== "running") return false;
  return m.kind === "ssh" || probe.ssmOnline === true;
}

/* -------------------------------------------------------------------------- */
/* Sync state + mirror                                                         */
/* -------------------------------------------------------------------------- */

function machineMirror(m: MachineConfig): string {
  return path.join(machinesDir(), m.host, "profiles");
}

function syncStatePath(host: string): string {
  return path.join(machinesDir(), host, "sync-state.json");
}

async function readSyncState(host: string): Promise<SyncState> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(syncStatePath(host), "utf8"));
    if (parsed && typeof parsed === "object") {
      const s = parsed as SyncState;
      // Preserve the full record (files/bytes/durationMs/lastError too) —
      // the Machines tab reads them, and skip paths must not erase history.
      return { ...s, lastSyncAt: s.lastSyncAt ?? null, lastStatus: s.lastStatus ?? "skipped" };
    }
  } catch {
    /* absent or invalid */
  }
  return { lastSyncAt: null, lastStatus: "skipped" };
}

async function writeSyncState(host: string, state: SyncState): Promise<void> {
  const dir = path.join(machinesDir(), host);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(syncStatePath(host), JSON.stringify(state, null, 2));
}

/** Total session-file count and bytes in one machine's mirror. */
async function measureMirror(mirror: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files += 1;
        try {
          bytes += (await fsp.stat(full)).size;
        } catch {
          /* file vanished mid-walk */
        }
      }
    }
  };
  await walk(mirror);
  return { files, bytes };
}

/**
 * Pull one machine's session JSONLs into the local mirror. Never opens ssh
 * unless the probe says the machine is up; skips (no error) otherwise.
 * `force` bypasses the sync TTL, not the probe.
 */
export async function syncMachine(
  m: MachineConfig,
  opts?: { force?: boolean; probe?: ProbeResult },
): Promise<SyncState> {
  // Reserve the host SYNCHRONOUSLY, before any await: /api/sync and
  // /api/machines both trigger pulls on dashboard load, so a lock taken
  // only after the probe/state reads would let two callers race into two
  // concurrent rsyncs writing the same mirror.
  if (syncingHosts.has(m.host)) {
    return { ...(await readSyncState(m.host)), lastStatus: "skipped" };
  }
  syncingHosts.add(m.host);
  try {
    return await syncMachineLocked(m, opts);
  } finally {
    syncingHosts.delete(m.host);
  }
}

async function syncMachineLocked(
  m: MachineConfig,
  opts?: { force?: boolean; probe?: ProbeResult },
): Promise<SyncState> {
  const probe = opts?.probe ?? (await probeCached(m));
  if (!isSyncable(m, probe)) {
    // Transient skip — NOT persisted. The disk record keeps only real sync
    // outcomes (ok/error) with their lastSyncAt/files/bytes, so a down
    // machine never erases its last successful sync's history (the probe
    // state already tells the dashboard why nothing ran).
    return {
      ...(await readSyncState(m.host)),
      lastStatus: "skipped",
      lastError: `machine ${probe.state}`,
    };
  }
  const file = await getMachinesFile();
  const ttl = (file.syncTtlMinutes ?? DEFAULT_SYNC_TTL_MIN) * 60_000;
  const previous = await readSyncState(m.host);
  if (!opts?.force && previous.lastSyncAt && Date.now() - previous.lastSyncAt < ttl) {
    // Fresh enough: report a transient skip so callers count "not
    // transferred" instead of "synced" — returning `previous` here would
    // make every dashboard poll queue a redundant re-aggregation.
    return { ...previous, lastStatus: "skipped" };
  }
  const startedAt = Date.now();
  try {
    // Trailing slash normalized so a misconfigured remoteProfilesPath
    // can't nest `profiles/` inside `profiles/`.
    const remotePath = (m.remoteProfilesPath ?? ".pi/profiles/").replace(/\/?$/, "/");
    const remote = `${m.host}:${remotePath}`;
    await fsp.mkdir(machineMirror(m), { recursive: true });
    // Only `<profile>/sessions/**` is mirrored (anchored at depth 1 — a bare
    // `sessions/**` would also match e.g. `git/<pkg>/node_modules/**/sessions/`
    // on the remote profile). `-m` prunes profile skeletons without sessions.
    // The dir + contents split (`sessions/` then `**`) keeps the filter
    // compatible with rsync 2.6.9 — `***` is 3.x-only and would match nothing,
    // silently mirroring zero files. The per-profile pin-state file rides
    // along (depth-2 file, exact match) so the Session Pins panel can join
    // machine sessions to their pinned backend in the aggregate view.
    await runCommand(
      "rsync",
      [
        "-a",
        "-m",
        "--include",
        "/*/",
        "--include",
        "/*/sessions/",
        "--include",
        "/*/sessions/**",
        "--include",
        "/*/openrouter-session-pin-state.json",
        "--exclude",
        "*",
        "-e",
        `ssh ${SSH_SYNC_OPTS}`,
        remote,
        machineMirror(m),
      ],
      RSYNC_TIMEOUT_MS,
    );
    const { files, bytes } = await measureMirror(machineMirror(m));
    const state: SyncState = {
      lastSyncAt: Date.now(),
      lastStatus: "ok",
      files,
      bytes,
      durationMs: Date.now() - startedAt,
    };
    await writeSyncState(m.host, state);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state: SyncState = {
      ...previous,
      lastStatus: "error",
      lastError: message.split("\n").slice(-2).join(" ").slice(0, 300),
    };
    await writeSyncState(m.host, state);
    return state;
  }
}

/** Sync every machine that is up and stale. Returns how many transferred. */
export async function syncStaleMachines(
  host?: string,
): Promise<{ synced: number; skipped: number }> {
  const machines = (await listMachines()).filter((m) => !host || m.host === host);
  let synced = 0;
  let skipped = 0;
  const results = await Promise.allSettled(
    machines.map(async (m) => {
      const state = await syncMachine(m);
      return state.lastStatus === "ok" ? "synced" : "skipped";
    }),
  );
  for (const result of results) {
    if (result.status === "fulfilled" && result.value === "synced") synced += 1;
    else skipped += 1;
  }
  return { synced, skipped };
}

/* -------------------------------------------------------------------------- */
/* Machine sources + overview                                                  */
/* -------------------------------------------------------------------------- */

/** Machine-mirrored sessions dirs as aggregator sources, id `<host>/<profile>`. */
export async function listMachineSources(): Promise<MachineSource[]> {
  const byHost = new Map((await listMachines()).map((m) => [m.host, m]));
  const root = machinesDir();
  const sources: MachineSource[] = [];
  let hosts;
  try {
    hosts = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return sources;
  }
  for (const hostEntry of hosts) {
    // Only mirrors of registered, enabled machines are aggregated — disabling a
    // machine (or removing its ssh config entry) retires its existing mirror.
    if (!hostEntry.isDirectory() || !byHost.has(hostEntry.name)) continue;
    const profilesDir = path.join(root, hostEntry.name, "profiles");
    let profiles;
    try {
      profiles = await fsp.readdir(profilesDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const profileEntry of profiles) {
      if (!profileEntry.isDirectory()) continue;
      const sessions = path.join(profilesDir, profileEntry.name, "sessions");
      if (!fs.existsSync(sessions)) continue;
      sources.push({
        id: `${hostEntry.name}/${profileEntry.name}`,
        dir: sessions,
        machine: hostEntry.name,
        // Machine sessions join the aggregate "All profiles" view by default,
        // like local profiles; a machine opts out with includeInAll: false.
        includeInAll: byHost.get(hostEntry.name)?.includeInAll !== false,
      });
    }
  }
  return sources;
}

/** Cheap totals from one machine view's DB, read via its own connection. */
function readMachineSummary(viewId: string): MachineSummary | null {
  const dbPath = path.join(resolveStatsDir(), `pi-omp-stats-${sanitizeProfileId(viewId)}.db`);
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        "SELECT COUNT(DISTINCT session_file) AS sessions, COUNT(*) AS requests, " +
          "COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_total), 0) AS cost, " +
          "MAX(timestamp) AS last FROM messages",
      )
      .get() as Record<string, number | null>;
    return {
      sessions: row.sessions ?? 0,
      requests: row.requests ?? 0,
      tokens: row.tokens ?? 0,
      cost: row.cost ?? 0,
      lastActivityMs: row.last ?? null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Totals summed across every view DB of one machine (multi-profile hosts). */
function readMachineSummaries(viewIds: string[]): MachineSummary | null {
  const totals: MachineSummary = {
    sessions: 0,
    requests: 0,
    tokens: 0,
    cost: 0,
    lastActivityMs: null,
  };
  let any = false;
  for (const viewId of viewIds) {
    const s = readMachineSummary(viewId);
    if (!s) continue;
    any = true;
    totals.sessions += s.sessions;
    totals.requests += s.requests;
    totals.tokens += s.tokens;
    totals.cost += s.cost;
    if (
      s.lastActivityMs != null &&
      (totals.lastActivityMs == null || s.lastActivityMs > totals.lastActivityMs)
    ) {
      totals.lastActivityMs = s.lastActivityMs;
    }
  }
  return any ? totals : null;
}

/** Everything the Machines tab needs, with wake-safe probes. */
export async function getMachinesOverview(): Promise<MachineOverview[]> {
  const machines = await listMachines();
  const viewsByHost = new Map<string, string[]>();
  for (const source of await listMachineSources()) {
    const list = viewsByHost.get(source.machine) ?? [];
    list.push(source.id);
    viewsByHost.set(source.machine, list);
  }
  const overviews = await Promise.all(
    machines.map(async (m): Promise<MachineOverview> => {
      const probe = await probeCached(m);
      const state = await readSyncState(m.host);
      return {
        host: m.host,
        kind: m.kind,
        state: probe.state,
        ssmOnline: probe.ssmOnline,
        probeError: probe.error,
        views: viewsByHost.get(m.host) ?? [],
        syncing: syncingHosts.has(m.host),
        includeInAll: m.includeInAll === true,
        summary: null,
        ...state,
      };
    }),
  );
  for (const overview of overviews) {
    overview.summary = readMachineSummaries(overview.views);
  }
  return overviews;
}
