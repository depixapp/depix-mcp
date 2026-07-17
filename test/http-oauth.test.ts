// Auth-chain behavior of handleMcpHttp under the AUTHKIT_DOMAIN feature flag.
// Real tokens (local RSA keypair) + a stubbed global fetch serving our JWKS —
// the verification path is the real one. Assertions stop at the auth boundary:
// reaching the MCP transport (any non-401 response) proves auth passed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpHttp } from "../src/http.js";
import { _resetJwksCache } from "../src/oauth.js";

const DOMAIN = "https://depix-test.authkit.app";
const RESOURCE = "https://mcp.depixapp.com/mcp";
const NOW = () => Math.floor(Date.now() / 1000);

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signToken(payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: "k1" };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

function validToken(): string {
  return signToken({ iss: DOMAIN, aud: RESOURCE, sub: "user_01X", exp: NOW() + 3600 });
}

interface FakeRes {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  ended: boolean;
}

function makeRes(): { res: ServerResponse; state: FakeRes } {
  const state: FakeRes = { ended: false };
  const headerBag: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      state.statusCode = status;
      state.headers = { ...headerBag, ...headers };
      return res;
    },
    setHeader(name: string, value: string) {
      headerBag[name] = value;
      return res;
    },
    getHeader(name: string) {
      return headerBag[name];
    },
    removeHeader() {},
    write() {
      return true;
    },
    end(body?: string) {
      state.body = body;
      state.ended = true;
      return res;
    },
    on() {
      return res;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

function makeReq(auth?: string): IncomingMessage {
  return {
    method: "POST",
    headers: {
      host: "mcp.depixapp.com",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: auth } : {}),
    },
  } as unknown as IncomingMessage;
}

// A minimal initialize body so the transport (post-auth) responds instead of hanging.
const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

beforeEach(() => {
  _resetJwksCache();
  process.env.AUTHKIT_DOMAIN = DOMAIN;
  process.env.MCP_RESOURCE_URL = RESOURCE;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] }),
    })),
  );
});

afterEach(() => {
  delete process.env.AUTHKIT_DOMAIN;
  delete process.env.MCP_RESOURCE_URL;
  vi.unstubAllGlobals();
});

describe("handleMcpHttp — OAuth flag ON", () => {
  it("401 + WWW-Authenticate challenge when no token is presented (the discovery trigger)", async () => {
    const { res, state } = makeRes();
    await handleMcpHttp(makeReq(), res, INITIALIZE_BODY);
    expect(state.statusCode).toBe(401);
    expect(state.headers?.["WWW-Authenticate"]).toContain(
      'resource_metadata="https://mcp.depixapp.com/.well-known/oauth-protected-resource"',
    );
    // Bare challenge: no error code on a no-credentials 401 (RFC 6750 §3).
    expect(state.headers?.["WWW-Authenticate"]).not.toContain('error=');
  });

  it("401 with error=invalid_token for a garbage bearer", async () => {
    const { res, state } = makeRes();
    await handleMcpHttp(makeReq("Bearer not-a-jwt"), res, INITIALIZE_BODY);
    expect(state.statusCode).toBe(401);
    expect(state.headers?.["WWW-Authenticate"]).toContain('error="invalid_token"');
  });

  it("a VALID WorkOS token passes the auth boundary (reaches the transport, no 401)", async () => {
    const { res, state } = makeRes();
    await handleMcpHttp(makeReq(`Bearer ${validToken()}`), res, INITIALIZE_BODY);
    expect(state.statusCode).not.toBe(401);
  });

  it("a Bearer sk_ key bypasses OAuth entirely (terminal clients untouched)", async () => {
    const { res, state } = makeRes();
    await handleMcpHttp(makeReq("Bearer sk_test_abc123"), res, INITIALIZE_BODY);
    expect(state.statusCode).not.toBe(401);
    // No JWKS fetch happened — the sk_ path never touches OAuth.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("handleMcpHttp — OAuth flag OFF (byte-identical legacy)", () => {
  it("no token still reaches the transport (tools fail per-call, as before)", async () => {
    delete process.env.AUTHKIT_DOMAIN;
    const { res, state } = makeRes();
    await handleMcpHttp(makeReq(), res, INITIALIZE_BODY);
    expect(state.statusCode).not.toBe(401);
    expect(state.headers?.["WWW-Authenticate"]).toBeUndefined();
  });
});
