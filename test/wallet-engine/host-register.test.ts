// Auto-registering the local MCP server with the operator's AI host (§3.7 #6):
// detection, the `claude mcp add` argv, the config-file merge, and the injected
// side effects. No JSON is pasted by hand.

import { describe, expect, it } from "vitest";
import {
  buildClaudeMcpAddArgs,
  claudeDesktopConfigPath,
  cursorConfigPath,
  detectHosts,
  registerWithHost,
  upsertMcpServerConfig,
  type HostDetectDeps,
  type HostRegisterEffects,
  type HostTarget,
  type McpServerSpec,
} from "../../src/wallet-engine/mcp/host-register.js";

const HOME = "/home/tester";
const SPEC: McpServerSpec = {
  serverKey: "depix",
  packageName: "@depixapp/mcp",
  env: {
    DEPIX_WALLET_DIR: "/home/tester/.depix-wallet",
    DEPIX_GUARDRAIL_PER_TX_BRL_CENTS: "10000",
    DEPIX_GUARDRAIL_DAILY_BRL_CENTS: "50000",
  },
};

function detectDeps(over: Partial<HostDetectDeps> = {}): HostDetectDeps {
  return {
    platform: "linux",
    home: HOME,
    env: {},
    exists: () => false,
    hasCommand: () => false,
    ...over,
  };
}

describe("detectHosts", () => {
  it("finds Claude Code only when the `claude` CLI is on PATH", () => {
    expect(detectHosts(detectDeps({ hasCommand: () => false }))).toEqual([]);
    const found = detectHosts(detectDeps({ hasCommand: (c) => c === "claude" }));
    expect(found).toEqual([{ id: "claude-code", label: "Claude Code (CLI)", kind: "cli" }]);
  });

  it("finds Claude Desktop when its config folder OR file exists", () => {
    const cfg = claudeDesktopConfigPath("darwin", HOME, {})!;
    const found = detectHosts(detectDeps({ platform: "darwin", exists: (p) => p === cfg }));
    expect(found.map((h) => h.id)).toContain("claude-desktop");
    expect(found.find((h) => h.id === "claude-desktop")?.configPath).toBe(cfg);
  });

  it("finds Cursor when ~/.cursor exists", () => {
    const dir = cursorConfigPath(HOME).replace(/\/mcp\.json$/, "");
    const found = detectHosts(detectDeps({ exists: (p) => p === dir }));
    expect(found.map((h) => h.id)).toEqual(["cursor"]);
  });

  it("uses APPDATA for the Claude Desktop path on Windows", () => {
    const p = claudeDesktopConfigPath("win32", HOME, { APPDATA: "C:\\Users\\t\\AppData\\Roaming" });
    expect(p).toContain("Roaming");
    expect(p).toContain("claude_desktop_config.json");
  });
});

describe("buildClaudeMcpAddArgs", () => {
  it("registers at user scope, one -e per env (sorted), launch command after --", () => {
    const args = buildClaudeMcpAddArgs(SPEC);
    expect(args.slice(0, 5)).toEqual(["mcp", "add", "--scope", "user", "depix"]);
    const dd = args.indexOf("--");
    expect(args.slice(dd)).toEqual(["--", "npx", "-y", "@depixapp/mcp"]);
    // Env pairs are sorted for a deterministic command.
    const pairs = args.filter((_, i) => args[i - 1] === "-e");
    expect(pairs).toEqual([...pairs].sort());
    expect(pairs).toContain("DEPIX_WALLET_DIR=/home/tester/.depix-wallet");
  });
});

describe("upsertMcpServerConfig", () => {
  it("creates the block from an empty/whitespace file", () => {
    const out = JSON.parse(upsertMcpServerConfig("   ", SPEC)) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(out.mcpServers.depix!.command).toBe("npx");
    expect(out.mcpServers.depix!.args).toEqual(["-y", "@depixapp/mcp"]);
    expect(out.mcpServers.depix!.env.DEPIX_WALLET_DIR).toBe("/home/tester/.depix-wallet");
  });

  it("preserves other servers and top-level keys", () => {
    const existing = JSON.stringify({
      theme: "dark",
      mcpServers: { other: { command: "node", args: ["x.js"] } },
    });
    const out = JSON.parse(upsertMcpServerConfig(existing, SPEC)) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(out.theme).toBe("dark");
    expect(out.mcpServers.other).toEqual({ command: "node", args: ["x.js"] });
    expect(out.mcpServers.depix).toBeDefined();
  });

  it("THROWS on a non-empty file that is not valid JSON (never clobbers it)", () => {
    expect(() => upsertMcpServerConfig("{ not json", SPEC)).toThrow(/not valid JSON/);
  });

  it("THROWS when the existing config is a JSON array, not an object", () => {
    expect(() => upsertMcpServerConfig("[]", SPEC)).toThrow(/not a JSON object/);
  });
});

describe("registerWithHost", () => {
  it("runs `claude mcp add` for a CLI host and reports success on exit 0", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const effects: HostRegisterEffects = {
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stderr: "" };
      },
      readFile: async () => undefined,
      writeFile: async () => undefined,
    };
    const target: HostTarget = { id: "claude-code", label: "Claude Code (CLI)", kind: "cli" };
    const out = await registerWithHost(target, SPEC, effects);
    expect(out.ok).toBe(true);
    expect(calls[0]?.command).toBe("claude");
    expect(calls[0]?.args.slice(0, 2)).toEqual(["mcp", "add"]);
  });

  it("reports a CLI host failure without throwing", async () => {
    const effects: HostRegisterEffects = {
      runCommand: async () => ({ code: 2, stderr: "boom" }),
      readFile: async () => undefined,
      writeFile: async () => undefined,
    };
    const out = await registerWithHost({ id: "claude-code", label: "Claude Code (CLI)", kind: "cli" }, SPEC, effects);
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/exited with code 2/);
  });

  it("merges into a config-file host and writes it back", async () => {
    let written: { path: string; contents: string } | undefined;
    const effects: HostRegisterEffects = {
      runCommand: async () => ({ code: 0, stderr: "" }),
      readFile: async () => JSON.stringify({ mcpServers: { keep: { command: "x" } } }),
      writeFile: async (path, contents) => void (written = { path, contents }),
    };
    const target: HostTarget = {
      id: "cursor",
      label: "Cursor",
      kind: "config-file",
      configPath: "/home/tester/.cursor/mcp.json",
    };
    const out = await registerWithHost(target, SPEC, effects);
    expect(out.ok).toBe(true);
    expect(written?.path).toBe("/home/tester/.cursor/mcp.json");
    const parsed = JSON.parse(written!.contents) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.keep).toBeDefined();
    expect(parsed.mcpServers.depix).toBeDefined();
  });

  it("leaves a corrupt config-file untouched (ok:false, no write)", async () => {
    let wrote = false;
    const effects: HostRegisterEffects = {
      runCommand: async () => ({ code: 0, stderr: "" }),
      readFile: async () => "{ corrupt",
      writeFile: async () => void (wrote = true),
    };
    const out = await registerWithHost(
      { id: "cursor", label: "Cursor", kind: "config-file", configPath: "/x/mcp.json" },
      SPEC,
      effects,
    );
    expect(out.ok).toBe(false);
    expect(wrote).toBe(false);
  });
});
