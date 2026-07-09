import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WAIT_SECONDS,
  MAX_WAIT_CEILING_SECONDS,
  resolveAllowedHosts,
  resolveApiBase,
  resolveMaxWaitSeconds,
} from "../src/config.js";

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
