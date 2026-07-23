import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WAIT_SECONDS,
  MAX_WAIT_CEILING_SECONDS,
  SERVER_NAME,
  resolveAllowedHosts,
  resolveApiBase,
  resolveMaxWaitSeconds,
  resolveServerVersion,
} from "../src/config.js";
import pkg from "../package.json" with { type: "json" };

// Release-drift tripwire: the handshake/well-known identity must stay pinned to
// package.json (the release source of truth). A version bump or a namespace change
// in package.json without updating config.ts fails HERE — that is exactly the drift
// that left /.well-known/mcp.json serving the old name + version 1.1.0.
describe("server identity ↔ package.json (release-drift tripwire)", () => {
  it("SERVER_NAME equals package.json mcpName (canonical registry namespace)", () => {
    expect(SERVER_NAME).toBe(pkg.mcpName);
    expect(SERVER_NAME).toBe("io.github.depixapp/depix-mcp");
  });

  it("resolveServerVersion default equals package.json version — bump both on release", () => {
    expect(resolveServerVersion({} as NodeJS.ProcessEnv)).toBe(pkg.version);
  });

  it("honors the MCP_SERVER_VERSION override", () => {
    expect(resolveServerVersion({ MCP_SERVER_VERSION: "9.9.9" } as NodeJS.ProcessEnv)).toBe("9.9.9");
  });
});

describe("resolveMaxWaitSeconds (platform-cap safety, spec §2.5)", () => {
  it("falls back to the Hobby-safe default when unset/invalid", () => {
    expect(resolveMaxWaitSeconds({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_WAIT_SECONDS);
    expect(resolveMaxWaitSeconds({ MCP_MAX_WAIT_SECONDS: "nope" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MAX_WAIT_SECONDS,
    );
  });

  it("honors a valid Pro budget", () => {
    expect(resolveMaxWaitSeconds({ MCP_MAX_WAIT_SECONDS: "780" } as NodeJS.ProcessEnv)).toBe(780);
  });

  it("clamps an over-large env below the platform ceiling (never killed mid-stream)", () => {
    expect(resolveMaxWaitSeconds({ MCP_MAX_WAIT_SECONDS: "5000" } as NodeJS.ProcessEnv)).toBe(
      MAX_WAIT_CEILING_SECONDS,
    );
    expect(MAX_WAIT_CEILING_SECONDS).toBeLessThan(800);
  });
});

describe("resolveApiBase", () => {
  it("defaults to the canonical API and trims trailing slashes", () => {
    expect(resolveApiBase({} as NodeJS.ProcessEnv)).toBe("https://api.depixapp.com");
    expect(resolveApiBase({ DEPIX_API_BASE: "https://x.example/" } as NodeJS.ProcessEnv)).toBe(
      "https://x.example",
    );
  });
});

describe("resolveAllowedHosts (DNS-rebinding protection)", () => {
  it("defaults to the production host", () => {
    expect(resolveAllowedHosts({} as NodeJS.ProcessEnv)).toEqual(["mcp.depixapp.com"]);
  });
  it("parses a comma-separated env override (for previews)", () => {
    expect(
      resolveAllowedHosts({
        MCP_ALLOWED_HOSTS: "mcp.depixapp.com, depix-mcp-abc.vercel.app",
      } as NodeJS.ProcessEnv),
    ).toEqual(["mcp.depixapp.com", "depix-mcp-abc.vercel.app"]);
  });
  it("falls back to the default on an empty/blank env", () => {
    expect(resolveAllowedHosts({ MCP_ALLOWED_HOSTS: " , " } as NodeJS.ProcessEnv)).toEqual([
      "mcp.depixapp.com",
    ]);
  });
});
