// Register the local MCP server with the operator's AI host — no JSON pasted
// by hand (spec §3.7 #6).
//
// Two shapes of host:
//   - a CLI host (Claude Code) → we run `claude mcp add …` for the operator;
//   - a config-file host (Claude Desktop, Cursor) → we merge one `mcpServers`
//     entry into the host's own JSON, preserving every other server it holds.
// Detection and the exact command / merged JSON are PURE (unit-tested); the
// spawning and file writes live behind injected effects so `init` can offer
// them with the operator's confirmation and fall back to printing the block.
//
// The env we register carries NO wallet passphrase and NO API key (§3.7 #3/#8):
// only the wallet dir, the guardrail limits, and — if the operator connected —
// the op_ operator token (which §9.4 permits in config).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** One `mcpServers` entry to install: the command, its args, and its env. */
export interface McpServerSpec {
  serverKey: string;
  packageName: string;
  /** Non-secret env only (DEPIX_WALLET_DIR, DEPIX_GUARDRAIL_*, DEPIX_OPERATOR_TOKEN?). */
  env: Record<string, string>;
}

export type HostKind = "cli" | "config-file";

export interface HostTarget {
  id: "claude-code" | "claude-desktop" | "cursor";
  label: string;
  kind: HostKind;
  /** Config-file hosts only: the JSON file a merge writes into. */
  configPath?: string;
}

export interface HostDetectDeps {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** Reports whether a file OR directory exists at `path`. */
  exists(path: string): boolean;
  /** Reports whether `command` resolves on PATH. */
  hasCommand(command: string): boolean;
}

/** The config path a config-file host reads, or undefined when unknown for the platform. */
export function claudeDesktopConfigPath(platform: NodeJS.Platform, home: string, env: Record<string, string | undefined>): string | undefined {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData ? join(appData, "Claude", "claude_desktop_config.json") : undefined;
  }
  if (platform === "linux") return join(home, ".config", "Claude", "claude_desktop_config.json");
  return undefined;
}

/** Cursor's global MCP config (`~/.cursor/mcp.json`). */
export function cursorConfigPath(home: string): string {
  return join(home, ".cursor", "mcp.json");
}

/** The directory of a path (for "does the host's config folder exist?" checks). */
function parentDir(path: string): string {
  return join(path, "..");
}

/**
 * The AI hosts installed on this machine that we can auto-register with. A
 * config-file host counts as present when its config file OR its parent folder
 * exists (the folder means the app is installed even before it has written a
 * config).
 */
export function detectHosts(deps: HostDetectDeps): HostTarget[] {
  const hosts: HostTarget[] = [];

  if (deps.hasCommand("claude")) {
    hosts.push({ id: "claude-code", label: "Claude Code (CLI)", kind: "cli" });
  }

  const desktop = claudeDesktopConfigPath(deps.platform, deps.home, deps.env);
  if (desktop && (deps.exists(desktop) || deps.exists(parentDir(desktop)))) {
    hosts.push({ id: "claude-desktop", label: "Claude Desktop", kind: "config-file", configPath: desktop });
  }

  const cursor = cursorConfigPath(deps.home);
  if (deps.exists(cursor) || deps.exists(parentDir(cursor))) {
    hosts.push({ id: "cursor", label: "Cursor", kind: "config-file", configPath: cursor });
  }

  return hosts;
}

/** The env entries as sorted `KEY=VALUE` strings — deterministic for the CLI and tests. */
function envPairs(env: Record<string, string>): string[] {
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]!}`);
}

/**
 * argv for `claude mcp add` (the command itself is "claude"). Registers at user
 * scope so the server is available in every project, passes each env var with
 * `-e`, and puts the launch command after `--` so npx flags are never parsed as
 * `claude` flags.
 */
export function buildClaudeMcpAddArgs(spec: McpServerSpec): string[] {
  const args = ["mcp", "add", "--scope", "user", spec.serverKey];
  for (const pair of envPairs(spec.env)) args.push("-e", pair);
  args.push("--", "npx", "-y", spec.packageName);
  return args;
}

/**
 * The host's JSON with our one server merged in. Every other server and
 * top-level key is preserved. An EMPTY/whitespace file starts from `{}`; a
 * non-empty file that is not valid JSON THROWS rather than clobbering the
 * operator's config — the caller then prints the block for a manual edit.
 */
export function upsertMcpServerConfig(existing: string | undefined, spec: McpServerSpec): string {
  let root: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error("existing config is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("existing config is not a JSON object");
    }
    root = parsed as Record<string, unknown>;
  }
  const servers =
    typeof root.mcpServers === "object" && root.mcpServers !== null && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  servers[spec.serverKey] = {
    command: "npx",
    args: ["-y", spec.packageName],
    env: sortedEnv(spec.env),
  };
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** env with keys in a stable order (so a re-run produces a byte-identical file). */
function sortedEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) out[k] = env[k]!;
  return out;
}

// ── side effects (injected) ──────────────────────────────────────────────────

export interface HostRegisterEffects {
  runCommand(command: string, args: readonly string[]): Promise<{ code: number | null; stderr: string }>;
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface HostRegisterOutcome {
  ok: boolean;
  /** A short, secret-free note for the operator (what happened, or why it didn't). */
  detail: string;
}

/**
 * Perform the registration the operator confirmed. Returns ok:false with a
 * reason (never throws) so `init` can fall back to printing the block. The
 * op_ token may be in `spec.env`; it is never echoed into `detail`.
 */
export async function registerWithHost(
  target: HostTarget,
  spec: McpServerSpec,
  effects: HostRegisterEffects,
): Promise<HostRegisterOutcome> {
  if (target.kind === "cli") {
    const res = await effects.runCommand("claude", buildClaudeMcpAddArgs(spec));
    if (res.code === 0) return { ok: true, detail: "registered with Claude Code via `claude mcp add`" };
    if (res.code === null) return { ok: false, detail: "the `claude` command could not be run" };
    return { ok: false, detail: `\`claude mcp add\` exited with code ${res.code}` };
  }
  if (!target.configPath) return { ok: false, detail: "no config path for this host" };
  let merged: string;
  try {
    const existing = await effects.readFile(target.configPath);
    merged = upsertMcpServerConfig(existing, spec);
  } catch (err) {
    return { ok: false, detail: `${target.label} config left untouched (${(err as Error).message})` };
  }
  try {
    await effects.writeFile(target.configPath, merged);
  } catch {
    return { ok: false, detail: `could not write ${target.label} config` };
  }
  return { ok: true, detail: `added the server to ${target.label} config (restart the app to load it)` };
}

// ── default wiring ───────────────────────────────────────────────────────────

/** Real detection: PATH scan for `claude`, fs existence for the config hosts. */
export function defaultHostDetectDeps(): HostDetectDeps {
  const hasCommand = (command: string): boolean => {
    const path = process.env.PATH ?? "";
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    return path.split(delimiter).some((dir) => dir !== "" && exts.some((ext) => existsSync(join(dir, command + ext))));
  };
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists: (p: string) => existsSync(p),
    hasCommand,
  };
}

/** Real effects: spawn `claude`, read/write config files atomically at 0600. */
export const defaultHostRegisterEffects: HostRegisterEffects = {
  async runCommand(command, args) {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", () => resolve({ code: null, stderr }));
      child.on("close", (code) => resolve({ code, stderr }));
    });
  },
  async readFile(path) {
    const { readFile } = await import("node:fs/promises");
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
  async writeFile(path, contents) {
    const { ensureDir, writeFileAtomic } = await import("../store/fs-util.js");
    await ensureDir(join(path, ".."));
    await writeFileAtomic(path, contents);
  },
};
