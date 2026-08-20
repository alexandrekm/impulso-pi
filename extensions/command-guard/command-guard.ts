/**
 * Bash command guard for pi.
 *
 * Default-allow glob policy (ask/deny lists in command-guard.json), ported
 * from the Go hook in KeepTruckin/motive-agent-skills#207. Wrappers such as
 * timeout/xargs/env/bash -c are peeled so the inner command is gated — they
 * do not themselves force a prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { decideProgram, flagStripped, matchesPattern, type GuardConfig } from "./engine.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_NAME = "command-guard.json";
const SENSITIVE_PATH = /(^|[\\/])\.env(\..+)?$/i;

type GuardFile = {
  include?: string;
  allow?: string[];
  ask?: string[];
  deny?: string[];
  rules?: { allow?: string[]; ask?: string[]; deny?: string[] };
};

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function resolveInclude(includePath: string, declaringFile: string): string {
  const p = expandHome(includePath);
  return isAbsolute(p) ? p : join(dirname(declaringFile), p);
}

function loadJson(path: string): GuardFile {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as GuardFile;
}

function collectRules(path: string, depth: number): GuardConfig {
  const empty: GuardConfig = { ask: [], deny: [] };
  if (depth > 10) return empty;
  let file: GuardFile;
  try {
    file = loadJson(path);
  } catch {
    return empty;
  }
  const allow = [...(file.allow ?? []), ...(file.rules?.allow ?? [])];
  const ask = [...(file.ask ?? []), ...(file.rules?.ask ?? [])];
  const deny = [...(file.deny ?? []), ...(file.rules?.deny ?? [])];
  if (file.include) {
    const nested = collectRules(resolveInclude(file.include, path), depth + 1);
    allow.push(...(nested.allow ?? []));
    ask.push(...nested.ask);
    deny.push(...nested.deny);
  }
  return { allow, ask, deny };
}

function loadConfig(): GuardConfig {
  const candidates = [
    join(EXT_DIR, CONFIG_NAME),
    join(process.env.PI_CODING_AGENT_DIR || dirname(EXT_DIR), "extensions", CONFIG_NAME),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    return collectRules(path, 0);
  }
  return { allow: ["rm -f*", "rm -rf*", "rm --force*"], ask: ["rm *", "sudo *"], deny: [] };
}

function bashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

export function isSensitiveDotenv(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  if (base === ".env.example") return false;
  return SENSITIVE_PATH.test(path);
}

import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";

export default function (pi: any): void {
  if (!isFeatureEnabled("command-guard")) return;
  const cfg = loadConfig();
  const sessionAllows: string[] = [];

  pi.on("tool_call", async (event: any, ctx: any) => {
    const path = toolPath(event.input);
    if (path && isSensitiveDotenv(path)) {
      return {
        block: true,
        reason: `[command-guard] blocked access to '${path}' (.env files are denied).`,
      };
    }

    if (event.toolName !== "bash") return undefined;
    const command = bashCommand(event.input);
    if (!command) return undefined;

    const result = decideProgram(command, cfg);
    if (result.decision === "allow") return undefined;

    if (
      result.decision === "ask" &&
      result.pattern &&
      sessionAllows.some((p) => matchesPattern(p, result.command, flagStripped(result.command)))
    ) {
      return undefined;
    }

    if (result.decision === "deny") {
      return {
        block: true,
        reason: `[command-guard] denied '${result.command}' (matched '${result.pattern}').`,
      };
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `[command-guard] '${result.command}' requires approval (matched '${result.pattern}'); no UI.`,
      };
    }

    const choice = await ctx.ui.select(
      `command-guard: allow '${result.command}'?\nmatched '${result.pattern}'`,
      ["Yes", "Yes, for this session", "No"],
    );

    if (choice === "Yes") return undefined;
    if (choice === "Yes, for this session") {
      if (result.pattern) sessionAllows.push(result.pattern);
      return undefined;
    }
    return {
      block: true,
      reason: `[command-guard] blocked by user ('${result.command}', matched '${result.pattern}').`,
    };
  });
}
