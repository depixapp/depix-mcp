// Credential-forwarding provenance for the OAuth path (PR-B, F4 §2.9).
//
// The point of PR-B is that a verified WorkOS session now FORWARDS the JWT to
// the DePix API as the bearer, instead of discarding it (apiKey=undefined). The
// existing http-oauth suite only asserts "a valid token reaches the transport
// (no 401)" — which would STILL pass if the token were discarded, so it does
// NOT guard the forwarding. These tests capture the exact opts handleMcpHttp
// hands to createServer, proving:
//   (a) the forwarded apiKey is byte-identical to the VERIFIED bearer, and
//       authMode="oauth" is set ONLY after a successful verification (§2);
//   (b) an unverified/garbage bearer never reaches createServer at all (§2);
//   (c) with the flag OFF a JWT bearer is passed through as a plain apiKey with
//       authMode=undefined, so the sk_ guard rejects it downstream (§4).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// Wrap createServer so it still builds the real server (the transport runs
// normally), while recording the opts it was called with.
vi.mock("../src/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server.js")>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

import { handleMcpHttp } from "../src/http.js";
import { createServer } from "../src/server.js";
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

function makeRes(): ServerResponse {
  const headerBag: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead() {
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
    end() {
      return res;
    },
    on() {
      return res;
    },
  } as unknown as ServerResponse;
  return res;
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

const mockedCreateServer = vi.mocked(createServer);

beforeEach(() => {
  _resetJwksCache();
  mockedCreateServer.mockClear();
  process.env.MCP_RESOURCE_URL = RESOURCE;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }],
      }),
    })),
  );
});

afterEach(() => {
  delete process.env.AUTHKIT_DOMAIN;
  delete process.env.MCP_RESOURCE_URL;
  vi.unstubAllGlobals();
});

describe("OAuth credential forwarding provenance (PR-B §2/§4)", () => {
  it("forwards the VERIFIED bearer verbatim with authMode=oauth (flag ON)", async () => {
    process.env.AUTHKIT_DOMAIN = DOMAIN;
    const token = validToken();
    await handleMcpHttp(makeReq(`Bearer ${token}`), makeRes(), INITIALIZE_BODY);

    expect(mockedCreateServer).toHaveBeenCalledTimes(1);
    const opts = mockedCreateServer.mock.calls[0][0];
    // The forwarded credential is byte-identical to the token we verified — no
    // substitution, and NOT discarded to undefined (the pre-PR-B dead-end).
    expect(opts.apiKey).toBe(token);
    expect(opts.authMode).toBe("oauth");
  });

  it("never constructs the server for a garbage bearer (unverified ⇒ no forward, flag ON)", async () => {
    process.env.AUTHKIT_DOMAIN = DOMAIN;
    await handleMcpHttp(makeReq("Bearer eyJ-not.a-real.jwt"), makeRes(), INITIALIZE_BODY);
    // 401 challenge happens before createServer: an unverified token can never
    // reach the API layer as an authMode=oauth bearer.
    expect(mockedCreateServer).not.toHaveBeenCalled();
  });

  it("with the flag OFF a JWT bearer is passed through as a plain apiKey, authMode undefined (§4)", async () => {
    delete process.env.AUTHKIT_DOMAIN;
    const token = validToken();
    await handleMcpHttp(makeReq(`Bearer ${token}`), makeRes(), INITIALIZE_BODY);

    expect(mockedCreateServer).toHaveBeenCalledTimes(1);
    const opts = mockedCreateServer.mock.calls[0][0];
    // Flag off ⇒ no OAuth branch: the JWT flows as a legacy apiKey with no oauth
    // mode, so the sk_ guard in ApiClient rejects it (see apiClient.test.ts).
    expect(opts.apiKey).toBe(token);
    expect(opts.authMode).toBeUndefined();
  });
});
