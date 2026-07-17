// The two OAuth discovery endpoints: RFC 9728 PRM + the AS-metadata proxy shim.
// Both are 404 with the feature flag off, public-CORS with it on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import prmHandler from "../api/well-known-oauth-protected-resource.js";
import asHandler, { _resetAsMetadataCache } from "../api/well-known-oauth-authorization-server.js";

const DOMAIN = "https://depix-test.authkit.app";

interface FakeRes {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
}

function makeRes(): { res: VercelResponse; state: FakeRes } {
  const state: FakeRes = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as VercelResponse;
  return { res, state };
}

const req = (method = "GET") => ({ method }) as unknown as VercelRequest;

beforeEach(() => {
  _resetAsMetadataCache();
  process.env.AUTHKIT_DOMAIN = DOMAIN;
  process.env.MCP_RESOURCE_URL = "https://mcp.depixapp.com/mcp";
});

afterEach(() => {
  delete process.env.AUTHKIT_DOMAIN;
  delete process.env.MCP_RESOURCE_URL;
  vi.unstubAllGlobals();
});

describe("/.well-known/oauth-protected-resource", () => {
  it("serves the RFC 9728 document with public CORS", () => {
    const { res, state } = makeRes();
    prmHandler(req(), res);
    expect(state.statusCode).toBe(200);
    expect(state.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(state.body).toEqual({
      resource: "https://mcp.depixapp.com/mcp",
      authorization_servers: [DOMAIN],
      bearer_methods_supported: ["header"],
    });
  });

  it("404s when the feature flag is off", () => {
    delete process.env.AUTHKIT_DOMAIN;
    const { res, state } = makeRes();
    prmHandler(req(), res);
    expect(state.statusCode).toBe(404);
  });

  it("204 on OPTIONS, 405 on POST", () => {
    const a = makeRes();
    prmHandler(req("OPTIONS"), a.res);
    expect(a.state.statusCode).toBe(204);
    const b = makeRes();
    prmHandler(req("POST"), b.res);
    expect(b.state.statusCode).toBe(405);
  });
});

describe("/.well-known/oauth-authorization-server (proxy shim)", () => {
  it("proxies AuthKit's AS metadata and caches it", async () => {
    const upstream = { issuer: DOMAIN, token_endpoint: `${DOMAIN}/oauth2/token` };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => upstream }));
    vi.stubGlobal("fetch", fetchMock);

    const a = makeRes();
    await asHandler(req(), a.res);
    expect(a.state.statusCode).toBe(200);
    expect(a.state.body).toEqual(upstream);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DOMAIN}/.well-known/oauth-authorization-server`,
      expect.anything(),
    );

    const b = makeRes();
    await asHandler(req(), b.res);
    expect(b.state.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1); // warm cache
  });

  it("502 when AuthKit is unreachable (never invents metadata)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const { res, state } = makeRes();
    await asHandler(req(), res);
    expect(state.statusCode).toBe(502);
  });

  it("404s when the feature flag is off", async () => {
    delete process.env.AUTHKIT_DOMAIN;
    const { res, state } = makeRes();
    await asHandler(req(), res);
    expect(state.statusCode).toBe(404);
  });
});
