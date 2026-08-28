// argv dispatch of the single bin (unified-MCP spec §1.5).
//
// The ceremonies themselves are NEVER run here: `init` and `backup` are mocked.
// What is verified is the contract around them — that each is reachable only as an
// explicit subcommand, that a typo does not silently start a server, and that no
// path can invoke a ceremony by accident.

import { describe, expect, it } from "vitest";
import { USAGE, runCli, type CliDeps } from "../src/cli.js";

function harness(overrides: Partial<CliDeps> = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const deps: CliDeps = {
    init: async (opts) => {
      calls.push(`init:${opts.restore ? "restore" : "create"}`);
    },
    backup: async () => {
      calls.push("backup");
    },
    login: async (opts) => {
      calls.push(`login:${opts.provider ?? "ask"}`);
      return 0;
    },
    logout: async () => {
      calls.push("logout");
      return 0;
    },
    account: async (argv) => {
      calls.push(`account:${argv.join(" ")}`);
      return 0;
    },
    serve: async () => {
      calls.push("serve");
    },
    write: (text) => out.push(text),
    version: "9.9.9",
    ...overrides,
  };
  return { calls, out, deps };
}

describe("runCli", () => {
  it("no arguments -> serve", async () => {
    const { calls, deps } = harness();
    expect(await runCli([], deps)).toBe(0);
    expect(calls).toEqual(["serve"]);
  });

  it("`init` -> the create ceremony, and NOT the server", async () => {
    const { calls, deps } = harness();
    expect(await runCli(["init"], deps)).toBe(0);
    expect(calls).toEqual(["init:create"]);
  });

  it("`init --restore` -> the restore ceremony", async () => {
    const { calls, deps } = harness();
    expect(await runCli(["init", "--restore"], deps)).toBe(0);
    expect(calls).toEqual(["init:restore"]);
  });

  it("rejects unknown options on `init` instead of silently creating a wallet", async () => {
    const { calls, out, deps } = harness();
    expect(await runCli(["init", "--force"], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("--force");
  });

  it("`backup` -> the re-view ceremony, and NOT the server", async () => {
    const { calls, deps } = harness();
    expect(await runCli(["backup"], deps)).toBe(0);
    expect(calls).toEqual(["backup"]);
  });

  it("rejects options on `backup` instead of guessing what was meant", async () => {
    const { calls, out, deps } = harness();
    expect(await runCli(["backup", "--restore"], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("--restore");
  });

  it("a typo does NOT fall through to serving", async () => {
    const { calls, out, deps } = harness();
    expect(await runCli(["ini"], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("unknown command");
  });

  it("--help prints usage and serves nothing", async () => {
    const { calls, out, deps } = harness();
    expect(await runCli(["--help"], deps)).toBe(0);
    expect(calls).toEqual([]);
    expect(out.join("")).toBe(USAGE);
  });

  it("--version prints the version", async () => {
    const { out, deps } = harness();
    expect(await runCli(["--version"], deps)).toBe(0);
    expect(out.join("").trim()).toBe("9.9.9");
  });

  it("propagates a failing ceremony instead of swallowing it", async () => {
    const { deps } = harness({
      init: () => Promise.reject(new Error("INIT_REQUIRES_TTY")),
    });
    await expect(runCli(["init"], deps)).rejects.toThrow("INIT_REQUIRES_TTY");
  });

  it("propagates a failing backup ceremony instead of swallowing it", async () => {
    const { deps } = harness({
      backup: () => Promise.reject(new Error("BACKUP_REQUIRES_TTY")),
    });
    await expect(runCli(["backup"], deps)).rejects.toThrow("BACKUP_REQUIRES_TTY");
  });

  it("the usage text names both ceremonies, the env vars and the seedless behaviour", () => {
    expect(USAGE).toContain("npx -y @depixapp/mcp init");
    expect(USAGE).toContain("npx -y @depixapp/mcp backup");
    expect(USAGE).toContain("show this wallet's 12 words again");
    expect(USAGE).toContain("human ceremony at a real terminal");
    expect(USAGE).toContain("DEPIX_WALLET_PASSPHRASE");
    expect(USAGE).toContain("DEPIX_WALLET_DIR");
    expect(USAGE).toContain("wallet_not_configured");
    // The invariant that survives every revision: the ceremony is not a tool.
    expect(USAGE).toMatch(/NOT an MCP\s*\n?\s*tool|not an MCP tool/i);
  });

  it("`login` runs the operator sign-in, not the server", async () => {
    const { calls, deps } = harness();
    expect(await runCli(["login"], deps)).toBe(0);
    expect(calls).toEqual(["login:ask"]);
  });

  it("`login --provider github` pins the provider", async () => {
    const { calls, deps } = harness();
    expect(await runCli(["login", "--provider", "github"], deps)).toBe(0);
    expect(calls).toEqual(["login:github"]);
  });

  it("rejects an unknown --provider instead of silently asking in the browser", async () => {
    const { calls, out, deps } = harness();
    expect(await runCli(["login", "--provider", "twitter"], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("--provider");
  });

  it("rejects a stray option on `login`", async () => {
    const { calls, deps } = harness();
    expect(await runCli(["login", "--force"], deps)).toBe(1);
    expect(calls).toEqual([]);
  });

  it("`logout` runs the sign-out and refuses stray options", async () => {
    const { calls, deps } = harness();
    expect(await runCli(["logout"], deps)).toBe(0);
    expect(calls).toEqual(["logout"]);
    const b = harness();
    expect(await runCli(["logout", "--all"], b.deps)).toBe(1);
    expect(b.calls).toEqual([]);
  });

  it("`account` forwards its own argv verbatim", async () => {
    const { calls, deps } = harness();
    expect(await runCli(["account", "status"], deps)).toBe(0);
    expect(await runCli(["account", "use", "owner"], deps)).toBe(0);
    expect(calls).toEqual(["account:status", "account:use owner"]);
  });

  it("propagates the exit code of a failed login", async () => {
    const { deps } = harness({ login: () => Promise.resolve(1) });
    expect(await runCli(["login"], deps)).toBe(1);
  });

  it("the usage text explains the precedence and that switching identity is not a tool", () => {
    expect(USAGE).toContain("account use agent|owner");
    expect(USAGE).toContain("account status");
    expect(USAGE).toContain("DEPIX_API_KEY");
    // The loopback address is the one fact that decides whether login can work.
    expect(USAGE).toContain("http://127.0.0.1:47617/callback");
    expect(USAGE).toMatch(/not MCP tools|are not MCP tools/i);
  });
});
