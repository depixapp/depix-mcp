// OAuth 2.1 Resource Server support (F4 §2.9 caminho B): AuthKit (WorkOS
// Connect) is the Authorization Server; this MCP server validates the JWT
// access tokens it issues, statelessly, against the AuthKit domain's JWKS.
// This is what lets OAuth-only web clients (claude.ai, ChatGPT) connect —
// terminal clients keep using the static `Bearer sk_` header untouched.
//
// Zero dependencies added: JWKS via native fetch, RS256 via node:crypto
// (JWK import + crypto.verify). The whole feature is OFF unless
// AUTHKIT_DOMAIN is configured (config.ts) — with it unset, behavior is
// byte-identical to before.
//
// Token family note (load-bearing): MCP clients present *Connect-issued*
// JWTs — JWKS at `<authkit_domain>/oauth2/jwks`, issuer = the AuthKit domain
// itself. This is NOT the classic AuthKit session-token family (JWKS at
// api.workos.com/sso/jwks/<client_id>); mixing them fails every signature.

import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";

/** Only RS256 is accepted. Never trust the token header's alg on its own. */
const ALLOWED_ALGS = new Set(["RS256"]);
const JWKS_TTL_MS = 10 * 60 * 1000;
// Minimum interval between JWKS fetches, no matter what. getKey runs BEFORE
// signature verification, so without this an attacker sending unauthenticated
// tokens with random kids forces a 1:1 fetch amplification against the
// AuthKit JWKS endpoint — and if WorkOS rate-limits us, every legitimate
// verification starts failing (the whole OAuth surface goes down). A real key
// rotation is rare; a token signed with a brand-new key fails for at most
// this window and the client retries.
const JWKS_REFETCH_COOLDOWN_MS = 30 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export class OAuthTokenError extends Error {
  /** RFC 6750 error code for the WWW-Authenticate challenge. */
  readonly code: "invalid_token";
  constructor(message: string) {
    super(message);
    this.name = "OAuthTokenError";
    this.code = "invalid_token";
  }
}

export interface WorkosIdentity {
  /** WorkOS user id (stable) — the operator clustering key server-side. */
  sub: string;
  /** Organization selected at consent, when present. */
  orgId: string | null;
}

interface JwksKey extends JsonWebKey {
  kid?: string;
  alg?: string;
  kty?: string;
}

// Module-level JWKS cache (per warm instance). Keyed by domain so tests with
// different domains never cross-contaminate.
let jwksCache: { domain: string; fetchedAt: number; keys: JwksKey[] } | null = null;

/** Test hook — resets the module cache. */
export function _resetJwksCache(): void {
  jwksCache = null;
}

/** Test hook — ages the cached JWKS by `ms` (to cross the refetch cooldown). */
export function _ageJwksCache(ms: number): void {
  if (jwksCache) jwksCache = { ...jwksCache, fetchedAt: jwksCache.fetchedAt - ms };
}

type FetchLike = typeof fetch;

async function fetchJwks(domain: string, fetchImpl: FetchLike): Promise<JwksKey[]> {
  const res = await fetchImpl(`${domain}/oauth2/jwks`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new OAuthTokenError(`JWKS fetch failed (HTTP ${res.status})`);
  const body = (await res.json()) as { keys?: JwksKey[] };
  if (!Array.isArray(body.keys)) throw new OAuthTokenError("JWKS response has no keys array");
  return body.keys;
}

async function getKey(
  domain: string,
  kid: string | undefined,
  fetchImpl: FetchLike,
): Promise<JwksKey> {
  const now = Date.now();
  const pick = (keys: JwksKey[]) =>
    kid ? keys.find((k) => k.kid === kid) : keys.length === 1 ? keys[0] : undefined;

  if (jwksCache && jwksCache.domain === domain && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    const hit = pick(jwksCache.keys);
    if (hit) return hit;
    // Unknown kid with a warm cache: only refetch past the cooldown — an
    // unauthenticated random-kid flood must NOT translate into JWKS fetches.
    if (now - jwksCache.fetchedAt < JWKS_REFETCH_COOLDOWN_MS) {
      throw new OAuthTokenError("no JWKS key matches the token kid");
    }
  }
  // No cache / stale / cooled-down kid miss — (re)fetch once (key rotation).
  const keys = await fetchJwks(domain, fetchImpl);
  jwksCache = { domain, fetchedAt: now, keys };
  const hit = pick(keys);
  if (!hit) throw new OAuthTokenError("no JWKS key matches the token kid");
  return hit;
}

function b64urlJson(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  return parsed as Record<string, unknown>;
}

/** RFC 7519 aud may be a string or an array — accept either. */
function audienceMatches(aud: unknown, resource: string): boolean {
  if (typeof aud === "string") return aud === resource;
  if (Array.isArray(aud)) return aud.some((a) => a === resource);
  return false;
}

export interface VerifyOptions {
  /** AuthKit domain, e.g. https://acme-123.authkit.app (issuer + JWKS host). */
  authkitDomain: string;
  /** Canonical MCP resource URL the token's aud must contain. */
  resourceUrl: string;
  /** Injectable clock (unix seconds) and fetch, for tests. */
  nowSec?: number;
  fetchImpl?: FetchLike;
}

/**
 * Verify a Connect-issued access token. Throws OAuthTokenError on ANY failure
 * (malformed, bad signature, wrong issuer/audience, expired). Fail-closed.
 */
export async function verifyWorkosAccessToken(
  token: string,
  opts: VerifyOptions,
): Promise<WorkosIdentity> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  const parts = token.split(".");
  if (parts.length !== 3) throw new OAuthTokenError("token is not a JWS compact serialization");
  const [h64, p64, s64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlJson(h64);
    payload = b64urlJson(p64);
  } catch {
    throw new OAuthTokenError("token header/payload is not valid base64url JSON");
  }

  // Algorithm allowlist — the header's alg must be expected AND the selected
  // JWK must be an RSA key (defeats alg-confusion swaps).
  if (typeof header.alg !== "string" || !ALLOWED_ALGS.has(header.alg)) {
    throw new OAuthTokenError(`unexpected token alg ${String(header.alg)}`);
  }
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const jwk = await getKey(opts.authkitDomain, kid, fetchImpl);
  if (jwk.kty !== "RSA" || (jwk.alg !== undefined && jwk.alg !== "RS256")) {
    throw new OAuthTokenError("selected JWKS key is not an RS256 RSA key");
  }

  let signatureOk = false;
  try {
    const pub = createPublicKey({ key: jwk, format: "jwk" });
    signatureOk = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${h64}.${p64}`),
      pub,
      Buffer.from(s64, "base64url"),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new OAuthTokenError("token signature verification failed");

  if (payload.iss !== opts.authkitDomain) {
    throw new OAuthTokenError("token issuer does not match the AuthKit domain");
  }
  // MCP spec 2025-06-18: servers MUST validate they are the intended audience.
  if (!audienceMatches(payload.aud, opts.resourceUrl)) {
    throw new OAuthTokenError("token audience does not include this MCP resource");
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSec - CLOCK_SKEW_SECONDS) {
    throw new OAuthTokenError("token is expired");
  }
  // nbf mirrors exp: absent is fine, but present-and-non-numeric is rejected
  // (a claim we cannot evaluate must fail closed, not be skipped).
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || payload.nbf > nowSec + CLOCK_SKEW_SECONDS) {
      throw new OAuthTokenError("token is not yet valid (nbf)");
    }
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new OAuthTokenError("token has no sub");
  }

  return { sub: payload.sub, orgId: typeof payload.org_id === "string" ? payload.org_id : null };
}

// ── Discovery documents (RFC 9728) + the 401 challenge ────────────────────

/** The origin that hosts /.well-known/oauth-protected-resource. */
export function resourceOrigin(resourceUrl: string): string {
  return new URL(resourceUrl).origin;
}

/**
 * RFC 9728 Protected Resource Metadata. The `resource` value must byte-match
 * BOTH the Resource Indicator configured in the WorkOS dashboard AND the URL
 * the user types into claude.ai/ChatGPT — drift in any of the three breaks
 * the audience check.
 */
export function buildProtectedResourceMetadata(opts: {
  resourceUrl: string;
  authkitDomain: string;
}): Record<string, unknown> {
  return {
    resource: opts.resourceUrl,
    authorization_servers: [opts.authkitDomain],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The 401 challenge header (MCP spec 2025-06-18 MUST). claude.ai requires a
 * real 401 — a WWW-Authenticate on a 200 is ignored. Per RFC 6750 §3, a
 * no-credentials challenge SHOULD NOT carry an error code (only registered
 * codes like invalid_token exist), so the bare form is exactly claude.ai's
 * documented minimal accepted shape.
 */
export function buildWwwAuthenticate(resourceUrl: string, error?: "invalid_token"): string {
  const metadata = `${resourceOrigin(resourceUrl)}/.well-known/oauth-protected-resource`;
  if (!error) return `Bearer resource_metadata="${metadata}"`;
  return `Bearer error="${error}", error_description="The access token is invalid or expired", resource_metadata="${metadata}"`;
}
