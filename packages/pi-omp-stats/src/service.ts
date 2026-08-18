/**
 * @fileoverview `pi-omp-stats service` — register/unregister the dashboard as
 * a user-level background service so it always runs and survives reboots.
 *
 * Auto-detects the platform's service manager:
 *   - macOS  → launchd user agent  (~/Library/LaunchAgents/dev.pi.omp-stats.plist)
 *   - Linux  → systemd user unit   (~/.config/systemd/user/pi-omp-stats.service)
 *
 * Both are *user* services (no root). The daemon runs `node <dist/index.js>
 * --port <P> --host <H>` with KeepAlive/Restart=always, and inherits the
 * PI_STATS_* / PI_CODING_AGENT_* env vars that are set at install time so it
 * reads the same sessions dir the installer does. Unlike the ad-hoc foreground
 * CLI (loopback-only by default), the service defaults to `--host 0.0.0.0`
 * (see index.ts) since it's meant to run unattended and be reachable from
 * other machines; pass `--host 127.0.0.1` at install time to keep it
 * loopback-only.
 *
 * MIT, © impulso-pi port authors.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const LAUNCHD_LABEL = "dev.pi.omp-stats";
const SYSTEMD_UNIT = "pi-omp-stats.service";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_JS = path.resolve(MODULE_DIR, "index.js");
const NODE_BIN = process.execPath;

const ENV_VARS_TO_FORWARD = [
  "PI_STATS_DIR",
  "PI_STATS_SESSIONS_DIR",
  "PI_STATS_PROFILES_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_CODING_AGENT_DIR",
] as const;

export type ServiceAction =
  "install" | "uninstall" | "status" | "start" | "stop" | "restart" | "reload";

export interface ServiceOptions {
  port: number;
  host: string;
}

/* -------------------------------------------------------------------------- */
/* Platform detection                                                         */
/* -------------------------------------------------------------------------- */

type Manager = "launchd" | "systemd";

function detectManager(): Manager {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") {
    // Honor systemd-or-not; fall back to a clear error if unavailable.
    try {
      execFileSync("systemctl", ["--user", "--version"], { stdio: "ignore" });
    } catch {
      throw new Error(
        "systemctl --user is not available on this Linux box; cannot manage a service.",
      );
    }
    return "systemd";
  }
  throw new Error(
    `Service management is not supported on platform "${process.platform}". ` +
      "Supported: macOS (launchd) and Linux (systemd --user).",
  );
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

function statsDir(): string {
  const env = process.env.PI_STATS_DIR;
  return env && env.trim() ? expandHome(env) : path.join(os.homedir(), ".pi", "agent");
}

function logFile(): string {
  return path.join(statsDir(), "pi-omp-stats.log");
}

function launchdPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Resolve the absolute node + bin path to execute. Verifies the bin exists. */
function execStartArgs(opts: ServiceOptions): string[] {
  if (!existsSync(INDEX_JS)) {
    throw new Error(
      `CLI entry not found at ${INDEX_JS}. Run \`npm run build\` before installing the service.`,
    );
  }
  return [NODE_BIN, INDEX_JS, "--port", String(opts.port), "--host", opts.host];
}

function forwardedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_VARS_TO_FORWARD) {
    const v = process.env[key];
    if (v && v.trim()) env[key] = expandHome(v);
  }
  // Always anchor the stats dir so logs + db land deterministically.
  if (!env.PI_STATS_DIR) env.PI_STATS_DIR = statsDir();
  return env;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function run(cmd: string, args: string[]): Buffer {
  // execFileSync returns stdout directly as a Buffer (unlike spawnSync, which
  // wraps it in { stdout, stderr, status }). Callers use the return value as
  // the buffer itself.
  return execFileSync(cmd, args, { stdio: "pipe", maxBuffer: 1 << 20 }) as Buffer;
}

function runOrThrow(cmd: string, args: string[], label: string): void {
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`\`${label}\` failed: ${msg}`);
  }
}

function ensureLogDir(): void {
  const dir = statsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* -------------------------------------------------------------------------- */
/* launchd (macOS)                                                            */
/* -------------------------------------------------------------------------- */

function launchdPlist(opts: ServiceOptions): string {
  const [node, indexJs, ...rest] = execStartArgs(opts);
  const env = forwardedEnv();
  const envEntries = Object.keys(env)
    .sort()
    .map((k) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(env[k])}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(indexJs)}</string>
${rest.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile())}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile())}</string>${envEntries ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>` : ""}
</dict>
</plist>
`;
}

function launchdInstall(opts: ServiceOptions): void {
  const plistPath = launchdPlistPath();
  ensureLogDir();
  // Unload any prior copy so we don't keep a stale daemon around the reload.
  if (existsSync(plistPath)) {
    try {
      execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    } catch {
      /* not loaded — fine */
    }
  }
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, launchdPlist(opts), "utf8");
  runOrThrow("launchctl", ["load", plistPath], `launchctl load ${plistPath}`);
  console.log(`Installed launchd agent: ${plistPath}`);
  console.log(`Logs: ${logFile()}`);
  console.log(`Dashboard: http://${opts.host}:${opts.port}`);
  console.log("Manage with: pi-omp-stats service {status|stop|start|restart|uninstall}");
}

function launchdUninstall(): void {
  const plistPath = launchdPlistPath();
  if (existsSync(plistPath)) {
    try {
      execFileSync("launchctl", ["unload", plistPath], { stdio: "inherit" });
    } catch (e) {
      console.warn(
        `warning: launchctl unload failed (${(e as Error).message}); removing plist anyway.`,
      );
    }
    rmSync(plistPath, { force: true });
    console.log(`Removed launchd agent: ${plistPath}`);
  } else {
    console.log(`No launchd agent at ${plistPath}; nothing to uninstall.`);
  }
}

function launchdStatus(): number {
  // `launchctl list <label>` prints info and exits 0 if loaded, non-zero if not.
  let loaded = false;
  let pid = "-";
  try {
    const out = run("launchctl", ["list", LAUNCHD_LABEL]).toString().trim();
    loaded = true;
    // launchctl prints old-style plist: `\t"PID" = 75781;` — no leading-anchor
    // match, just find the PID key anywhere.
    const m = out.match(/"PID"\s*=\s*(\d+)/);
    if (m) pid = m[1];
  } catch {
    loaded = false;
  }
  if (!loaded) {
    console.log(`${LAUNCHD_LABEL}: not loaded`);
    return 1;
  }
  if (pid !== "-") {
    console.log(`${LAUNCHD_LABEL}: running (PID ${pid})`);
    return 0;
  }
  console.log(`${LAUNCHD_LABEL}: loaded but not running (KeepAlive will relaunch)`);
  return 0;
}

function launchdStart(): void {
  runOrThrow("launchctl", ["start", LAUNCHD_LABEL], `launchctl start ${LAUNCHD_LABEL}`);
  console.log(`Started ${LAUNCHD_LABEL}.`);
}

function launchdStop(): void {
  // Stopping a KeepAlive agent only suspends it until the next relaunch
  // trigger; to truly halt it, unload. We stop then warn the user.
  try {
    execFileSync("launchctl", ["stop", LAUNCHD_LABEL], { stdio: "inherit" });
  } catch (e) {
    throw new Error(`launchctl stop failed: ${(e as Error).message}`);
  }
  console.log(
    `Stopped ${LAUNCHD_LABEL} (KeepAlive may relaunch it; use \`service uninstall\` to halt for good).`,
  );
}

function launchdRestart(): void {
  // `kickstart` restarts the agent in place without a full unload/load cycle.
  const target = `gui/${os.userInfo().uid}/${LAUNCHD_LABEL}`;
  runOrThrow("launchctl", ["kickstart", "-k", target], `launchctl kickstart ${target}`);
  console.log(`Restarted ${LAUNCHD_LABEL}.`);
}

/* -------------------------------------------------------------------------- */
/* systemd (Linux, user)                                                      */
/* -------------------------------------------------------------------------- */

function systemdUnit(opts: ServiceOptions): string {
  const [node, indexJs, ...rest] = execStartArgs(opts);
  const args = rest.map((a) => JSON.stringify(a)).join(" ");
  const env = forwardedEnv();
  const envLines = Object.keys(env)
    .sort()
    .map((k) => `Environment=${k}=${JSON.stringify(env[k])}`)
    .join("\n");

  return `[Unit]
Description=pi-omp-stats — AI usage statistics dashboard
After=network.target

[Service]
Type=simple
ExecStart=${node} ${indexJs} ${args}
Restart=always
RestartSec=10
${envLines}

[Install]
WantedBy=default.target
`;
}

function systemdInstall(opts: ServiceOptions): void {
  const unitPath = systemdUnitPath();
  ensureLogDir();
  mkdirSync(path.dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, systemdUnit(opts), "utf8");
  runOrThrow("systemctl", ["--user", "daemon-reload"], "systemctl --user daemon-reload");
  runOrThrow(
    "systemctl",
    ["--user", "enable", "--now", SYSTEMD_UNIT],
    `systemctl --user enable --now ${SYSTEMD_UNIT}`,
  );
  // `enable --now` leaves an already-active unit untouched. Restart so a
  // re-install reliably applies a changed executable or forwarded environment.
  runOrThrow(
    "systemctl",
    ["--user", "restart", SYSTEMD_UNIT],
    `systemctl --user restart ${SYSTEMD_UNIT}`,
  );
  console.log(`Installed systemd user unit: ${unitPath}`);
  console.log(`Logs: journalctl --user -u ${SYSTEMD_UNIT} -f`);
  console.log(`Dashboard: http://${opts.host}:${opts.port}`);
  console.log("Manage with: pi-omp-stats service {status|stop|start|restart|uninstall}");
}

function systemdUninstall(): void {
  const unitPath = systemdUnitPath();
  if (!existsSync(unitPath)) {
    console.log(`No systemd unit at ${unitPath}; nothing to uninstall.`);
    return;
  }
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "inherit" });
  } catch (e) {
    console.warn(
      `warning: systemctl disable failed (${(e as Error).message}); removing unit anyway.`,
    );
  }
  rmSync(unitPath, { force: true });
  runOrThrow("systemctl", ["--user", "daemon-reload"], "systemctl --user daemon-reload");
  console.log(`Removed systemd user unit: ${unitPath}`);
}

function systemdStatus(): number {
  try {
    execFileSync("systemctl", ["--user", "status", SYSTEMD_UNIT], { stdio: "inherit" });
    return 0;
  } catch {
    console.log(`${SYSTEMD_UNIT}: not running / not installed`);
    return 1;
  }
}

function systemdStart(): void {
  runOrThrow(
    "systemctl",
    ["--user", "start", SYSTEMD_UNIT],
    `systemctl --user start ${SYSTEMD_UNIT}`,
  );
  console.log(`Started ${SYSTEMD_UNIT}.`);
}

function systemdStop(): void {
  runOrThrow(
    "systemctl",
    ["--user", "stop", SYSTEMD_UNIT],
    `systemctl --user stop ${SYSTEMD_UNIT}`,
  );
  console.log(`Stopped ${SYSTEMD_UNIT}.`);
}

function systemdRestart(): void {
  runOrThrow(
    "systemctl",
    ["--user", "restart", SYSTEMD_UNIT],
    `systemctl --user restart ${SYSTEMD_UNIT}`,
  );
  console.log(`Restarted ${SYSTEMD_UNIT}.`);
}

/* -------------------------------------------------------------------------- */
/* Public dispatcher                                                          */
/* -------------------------------------------------------------------------- */

const VALID_ACTIONS: ReadonlySet<ServiceAction> = new Set([
  "install",
  "uninstall",
  "status",
  "start",
  "stop",
  "restart",
  "reload",
]);

export function isValidServiceAction(a: string): a is ServiceAction {
  return VALID_ACTIONS.has(a as ServiceAction);
}

/**
 * Run a `pi-omp-stats service <action>` command. Prints user-facing messages
 * to stdout/stderr and returns a process exit code.
 */
export function runServiceCommand(action: ServiceAction, opts: ServiceOptions): number {
  const manager = detectManager();

  switch (action) {
    case "install":
      manager === "launchd" ? launchdInstall(opts) : systemdInstall(opts);
      return 0;
    case "uninstall":
      manager === "launchd" ? launchdUninstall() : systemdUninstall();
      return 0;
    case "status":
      return manager === "launchd" ? launchdStatus() : systemdStatus();
    case "start":
      manager === "launchd" ? launchdStart() : systemdStart();
      return 0;
    case "stop":
      manager === "launchd" ? launchdStop() : systemdStop();
      return 0;
    case "restart":
    case "reload": // reload == restart for this simple service
      manager === "launchd" ? launchdRestart() : systemdRestart();
      return 0;
    default:
      console.error(`Unknown service action: ${action}`);
      return 2;
  }
}

/** Peek at an existing install to surface the bound port/host in `service status`. */
export function describeInstalledService(): { port?: number; host?: string } | null {
  try {
    const manager = detectManager();
    const file = manager === "launchd" ? launchdPlistPath() : systemdUnitPath();
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    let port: number | undefined;
    let host: string | undefined;
    if (manager === "launchd") {
      // Plist stores args as separate <string> nodes: --port <string>3947</string>.
      const portMatch = text.match(/<string>--port<\/string>\s*<string>(\d+)<\/string>/);
      if (portMatch) port = parseInt(portMatch[1], 10);
      const hostMatch = text.match(/<string>--host<\/string>\s*<string>([^<]+)<\/string>/);
      if (hostMatch) host = hostMatch[1];
    } else {
      // systemd unit has a single ExecStart= line with inline args.
      const portMatch = text.match(/--port\s+(\d+)/);
      if (portMatch) port = parseInt(portMatch[1], 10);
      const hostMatch = text.match(/--host\s+(\S+)/);
      if (hostMatch) host = hostMatch[1].replace(/["']/g, "");
    }
    return { port, host };
  } catch {
    return null;
  }
}
