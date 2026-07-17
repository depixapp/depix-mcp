// Real-crypto tests for the OAuth Resource Server core: a local RSA keypair
// signs genuine RS256 JWTs, a fake fetch serves our own JWKS, and every claim
// path is exercised — signature, issuer, audience (string AND array), expiry,
// nbf, kid rotation, algorithm confusion, malformed input. No mocks of the
// verification logic itself.

import { beforeEach, describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  OAuthTokenError,
  _ageJwksCache,
  _resetJwksCache,
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  resourceOrigin,
  verifyWorkosAccessToken,
} from "../src/oauth.js";

const DOMAIN = "https://depix-test.authkit.app";
const RESOURCE = "https://mcp.depixapp.com/mcp";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { publicKey: roguePub, privateKey: roguePriv } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function toJwk(key: KeyObject, kid: string): Record<string, unknown> {
  return { ...key.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function signToken(
  payload: Record<string, unknown>,
  { kid = "k1", alg = "RS256", key = privateKey }: { kid?: string; alg?: string; key?: KeyObject } = {},
): string {
  const header = { alg, typ: "JWT", kid };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const sig = signer.sign(key).toString("base64url");
  return `${signingInput}.${sig}`;
}

const NOW = 1_800_000_000;

function goodPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: DOMAIN,
    aud: RESOURCE,
    sub: "user_01HWORKOS",
    exp: NOW + 3600,
    iat: NOW,
    ...overrides,
  };
}

/** fetch double serving our JWKS; records calls for rotation assertions. */
function jwksFetch(keys: Record<string, unknown>[]): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: unknown) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ keys }),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OPTS = (fetchImpl: typeof fetch) => ({
  authkitDomain: DOMAIN,
  resourceUrl: RESOURCE,
  nowSec: NOW,
  fetchImpl,
});

beforeEach(() => {
  _resetJwksCache();
});

describe("verifyWorkosAccessToken — happy paths", () => {
  it("accepts a valid RS256 token and returns the identity", async () => {
    const { impl } = jwksFetch([toJwk(publicKey, "k1")]);
    const id = await verifyWorkosAccessToken(signToken(goodPayload({ org_id: "org_1" })), OPTS(impl));
    expect(id).toEqual({ sub: "user_01HWORKOS", orgId: "org_1" });
  });

  it("accepts aud as an ARRAY containing the resource (RFC 7519)", async () => {
    const { impl } = jwksFetch([toJwk(publicKey, "k1")]);
    const id = await verifyWorkosAccessToken(
      signToken(goodPayload({ aud: ["https://other.example", RESOURCE] })),
      OPTS(impl),
    );
    expect(id.sub).toBe("user_01HWORKOS");
  });

  it("fetches the JWKS once and reuses the warm cache", async () => {
    const { impl, calls } = jwksFetch([toJwk(publicKey, "k1")]);
    await verifyWorkosAccessToken(signToken(goodPayload()), OPTS(impl));
    await verifyWorkosAccessToken(signToken(goodPayload()), OPTS(impl));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${DOMAIN}/oauth2/jwks`);
  });

  it("random-kid flood does NOT refetch inside the cooldown (unauthenticated JWKS-DoS guard)", async () => {
    const { impl, calls } = jwksFetch([toJwk(publicKey, "k1")]);
    await verifyWorkosAccessToken(signToken(goodPayload()), OPTS(impl)); // warms the cache
    // Three unauthenticated tokens with random kids: all rejected WITHOUT a fetch.
    for (const kid of ["evil1", "evil2", "evil3"]) {
      await expect(
        verifyWorkosAccessToken(signToken(goodPayload(), { kid }), OPTS(impl)),
      ).rejects.toThrow(/no JWKS key/);
    }
    expect(calls).toHaveLength(1); // only the warm-up fetch
  });

  it("re-fetches ONCE on an unknown kid past the cooldown (key rotation)", async () => {
    // First call caches k1; the rotated token carries k2 → one refetch serving both.
    const first = jwksFetch([toJwk(publicKey, "k1")]);
    await verifyWorkosAccessToken(signToken(goodPayload()), OPTS(first.impl));
    _ageJwksCache(31_000); // rotation happens PAST the anti-DoS cooldown
    const rotated = jwksFetch([toJwk(publicKey, "k1"), toJwk(roguePub, "k2")]);
    const id = await verifyWorkosAccessToken(
      signToken(goodPayload(), { kid: "k2", key: roguePriv }),
      OPTS(rotated.impl),
    );
    expect(id.sub).toBe("user_01HWORKOS");
    expect(rotated.calls).toHaveLength(1);
  });
});

describe("verifyWorkosAccessToken — rejections (fail-closed)", () => {
  async function expectReject(token: string, fetchImpl?: typeof fetch): Promise<OAuthTokenError> {
    const { impl } = jwksFetch([toJwk(publicKey, "k1")]);
    try {
      await verifyWorkosAccessToken(token, OPTS(fetchImpl ?? impl));
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthTokenError);
      return err as OAuthTokenError;
    }
    throw new Error("expected rejection");
  }

  it("rejects a tampered signature", async () => {
    const token = signToken(goodPayload());
    const err = await expectReject(token.slice(0, -4) + "AAAA");
    expect(err.message).toContain("signature");
  });

  it("rejects a token signed by a key NOT in the JWKS (same kid, different key)", async () => {
    await expectReject(signToken(goodPayload(), { key: roguePriv }));
  });

  it("rejects alg=none and HS256 (allowlist, not header trust)", async () => {
    const none = `${b64url({ alg: "none", kid: "k1" })}.${b64url(goodPayload())}.`;
    const errNone = await expectReject(none);
    expect(errNone.message).toContain("alg");
    const hs = `${b64url({ alg: "HS256", kid: "k1" })}.${b64url(goodPayload())}.c2ln`;
    await expectReject(hs);
  });

  it("rejects a wrong issuer", async () => {
    const err = await expectReject(signToken(goodPayload({ iss: "https://evil.authkit.app" })));
    expect(err.message).toContain("issuer");
  });

  it("rejects a missing/foreign audience — string and array forms", async () => {
    await expectReject(signToken(goodPayload({ aud: "https://not-us.example" })));
    await expectReject(signToken(goodPayload({ aud: ["https://not-us.example"] })));
    const err = await expectReject(signToken(goodPayload({ aud: undefined })));
    expect(err.message).toContain("audience");
  });

  it("rejects an expired token (past the 60s skew)", async () => {
    const err = await expectReject(signToken(goodPayload({ exp: NOW - 120 })));
    expect(err.message).toContain("expired");
  });

  it("accepts exp within the clock skew", async () => {
    const { impl } = jwksFetch([toJwk(publicKey, "k1")]);
    const id = await verifyWorkosAccessToken(signToken(goodPayload({ exp: NOW - 30 })), OPTS(impl));
    expect(id.sub).toBe("user_01HWORKOS");
  });

  it("rejects a future nbf", async () => {
    const err = await expectReject(signToken(goodPayload({ nbf: NOW + 3600 })));
    expect(err.message).toContain("nbf");
  });

  it("rejects a present-but-non-numeric nbf (fail closed, mirrors exp)", async () => {
    const err = await expectReject(signToken(goodPayload({ nbf: "9999999999" })));
    expect(err.message).toContain("nbf");
  });

  it("rejects a missing sub", async () => {
    const err = await expectReject(signToken(goodPayload({ sub: undefined })));
    expect(err.message).toContain("sub");
  });

  it("rejects malformed compact serializations", async () => {
    await expectReject("not-a-jwt");
    await expectReject("a.b");
    await expectReject(`${b64url({ alg: "RS256" })}.%%%.sig`);
  });

  it("rejects when the JWKS endpoint fails", async () => {
    const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const err = await expectReject(signToken(goodPayload()), failing);
    expect(err.message).toContain("JWKS");
  });
});

describe("discovery documents + challenge", () => {
  it("builds the RFC 9728 metadata", () => {
    expect(buildProtectedResourceMetadata({ resourceUrl: RESOURCE, authkitDomain: DOMAIN })).toEqual({
      resource: RESOURCE,
      authorization_servers: [DOMAIN],
      bearer_methods_supported: ["header"],
    });
  });

  it("builds the WWW-Authenticate challenge with the metadata URL on the resource ORIGIN", () => {
    expect(resourceOrigin(RESOURCE)).toBe("https://mcp.depixapp.com");
    // No credentials → BARE challenge (RFC 6750 §3: no error code) — exactly
    // claude.ai's documented minimal accepted shape.
    expect(buildWwwAuthenticate(RESOURCE)).toBe(
      'Bearer resource_metadata="https://mcp.depixapp.com/.well-known/oauth-protected-resource"',
    );
    const invalid = buildWwwAuthenticate(RESOURCE, "invalid_token");
    expect(invalid).toContain('error="invalid_token"');
    expect(invalid).toContain('resource_metadata="https://mcp.depixapp.com/.well-known/oauth-protected-resource"');
  });
});
