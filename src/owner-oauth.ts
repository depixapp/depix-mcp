// OAuth 2.1 client for `depix-mcp login` — the PURE half: PKCE, the authorize
// URL, the code exchange and the refresh. No listener, no browser, no disk.
//
// PUBLIC NATIVE CLIENT. This runs on the operator's own machine, so it has no
// place to keep a client_secret: authentication is PKCE (S256) alone, which is
// what OAuth 2.1 requires of a native client. `client_secret` is never sent —
// a test asserts its absence, because adding one "to make it work" would mean
// shipping a shared secret inside an npm tarball.
//
// TOKEN FAMILY (load-bearing). The DePix App API accepts a WorkOS bearer only
// when it verifies against the AuthKit domain's own `/oauth2/jwks` with the MCP
// resource in `aud` — the Connect family that claude.ai/ChatGPT already use.
// The classic `api.workos.com/user_management/authenticate` session token is a
// DIFFERENT family and fails that verification, so this client deliberately
// does NOT go there. It discovers the authorization server the way any RFC 9728
// client would (protected-resource metadata -> RFC 8414 AS metadata), which is
// also why no AuthKit domain is hardcoded here.

import { createHash } from "node:crypto";
import { randomBytes as nodeRandomBytes } from "node:crypto";

/**
 * The loopback port, FIXED — a deliberate choice, not an AS constraint (WorkOS
 * follows RFC 8252 §7.3 and accepts any port on a loopback redirect). Fixing it
 * makes a second concurrent `login` fail, and fail BEFORE the browser opens —
 * loopback-listener.ts resolves only once the socket is bound, so the
 * EADDRINUSE surfaces with no window open and no code in flight.
 */
export const OWNER_LOOPBACK_PORT = 47617;
export const OWNER_LOOPBACK_PATH = "/callback";
export const OWNER_LOOPBACK_REDIRECT_URI = `http://127.0.0.1:${OWNER_LOOPBACK_PORT}${OWNER_LOOPBACK_PATH}`;

/**
 * The DePix App OAuth client id for the operator's own sign-in. PUBLIC by
 * construction — it travels in the query string of every authorize URL. This is
 * the dedicated "DePix App MCP local" public OAuth application (PKCE, no
 * secret, loopback redirect); the operator-token flow at
 * `GET https://api.depixapp.com/api/agents/oauth/start` uses a different,
 * server-side client. Baked so `login` needs no configuration;
 * `DEPIX_WORKOS_CLIENT_ID` overrides it for a staging environment.
 */
export const DEFAULT_OWNER_CLIENT_ID = "client_01M148HDF82C0WBV7BDDYN3J7E";

/** `offline_access` is what makes a refresh token exist at all. */
export const OWNER_SCOPE = "openid profile email offline_access";

/** Conservative lifetime when the token response omits `expires_in`. */
const FALLBACK_EXPIRES_IN_SECONDS = 300;
const DISCOVERY_TIMEOUT_MS = 8000;
const TOKEN_TIMEOUT_MS = 15_000;
/** Upstream free text is content, not code — truncated and clearly labeled. */
const UNTRUSTED_MAX = 200;

export function resolveOwnerClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEPIX_WORKOS_CLIENT_ID?.trim() || DEFAULT_OWNER_CLIENT_ID;
}

/** A failure of the login flow, with a stable code the CLI branches on. */
export class OwnerLoginError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;
  constructor(message: string, code: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "OwnerLoginError";
    this.code = code;
    this.data = data;
  }
}

// ── PKCE (RFC 7636) ─────────────────────────────────────────────────────────

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The S256 challenge for a verifier: base64url(SHA-256(ASCII(verifier))). */
export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createPkce(random: (n: number) => Uint8Array = nodeRandomBytes): Pkce {
  // 32 bytes -> 43 base64url chars, the RFC's minimum legal verifier length.
  const verifier = base64url(random(32));
  return { verifier, challenge: pkceChallengeFor(verifier), method: "S256" };
}

/** The CSRF state: opaque, single-use, compared for equality on the callback. */
export function createState(random: (n: number) => Uint8Array = nodeRandomBytes): string {
  return base64url(random(24));
}

// ── discovery (RFC 9728 -> RFC 8414) ────────────────────────────────────────

export interface AuthServerEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

function discoveryFailure(reason: string, detail?: Record<string, unknown>): OwnerLoginError {
  return new OwnerLoginError(
    `Could not read the DePix App sign-in configuration: ${reason}.`,
    "oauth_discovery_failed",
    detail ?? {},
  );
}

async function fetchJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw discoveryFailure(`${url} could not be reached`);
  }
  if (!res.ok) throw discoveryFailure(`${url} answered HTTP ${res.status}`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw discoveryFailure(`${url} did not answer JSON`);
  }
}

/** An https origin, and nothing else — a downgrade would leak the code. */
function httpsOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? value.replace(/\/+$/, "") : null;
}

function endpointOn(origin: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.origin === new URL(origin).origin ? value : null;
}

/**
 * Resolve the authorization server for `resourceUrl` from its published
 * metadata. Fails closed on anything unexpected: a non-https server, endpoints
 * on a foreign origin (which would receive the code AND the verifier), or an
 * AS that cannot do PKCE S256.
 */
export async function discoverAuthServer(opts: {
  resourceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<AuthServerEndpoints> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const origin = new URL(opts.resourceUrl).origin;
  const prm = await fetchJson(`${origin}/.well-known/oauth-protected-resource`, fetchImpl, DISCOVERY_TIMEOUT_MS);

  const servers = prm.authorization_servers;
  const issuer = Array.isArray(servers) ? httpsOrigin(servers[0]) : null;
  if (issuer === null) throw discoveryFailure("the resource names no https authorization server");

  const meta = await fetchJson(`${issuer}/.well-known/oauth-authorization-server`, fetchImpl, DISCOVERY_TIMEOUT_MS);
  const authorizationEndpoint = endpointOn(issuer, meta.authorization_endpoint);
  const tokenEndpoint = endpointOn(issuer, meta.token_endpoint);
  if (authorizationEndpoint === null || tokenEndpoint === null) {
    throw discoveryFailure("the authorization server's endpoints are missing or point at another host");
  }
  const methods = meta.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes("S256")) {
    // A public client with no secret and no PKCE has no client authentication
    // at all — better to stop than to fall back to a weaker exchange.
    throw discoveryFailure("the authorization server does not support PKCE S256");
  }
  return { issuer, authorizationEndpoint, tokenEndpoint };
}

// ── authorize ───────────────────────────────────────────────────────────────

/** The friendly CLI names, mapped to the WorkOS connection names. */
const PROVIDER_CONNECTIONS = { google: "GoogleOAuth", github: "GithubOAuth" } as const;
export type OwnerProvider = keyof typeof PROVIDER_CONNECTIONS;
export const OWNER_PROVIDERS = Object.keys(PROVIDER_CONNECTIONS) as OwnerProvider[];

export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  resource: string;
  /** Omitted ⇒ the sign-in screen offers every button instead of pinning one. */
  provider?: OwnerProvider;
  scope?: string;
}): string {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope ?? OWNER_SCOPE);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", opts.state);
  // RFC 8707: without it the token is audienced for nothing this API accepts.
  url.searchParams.set("resource", opts.resource);
  if (opts.provider) url.searchParams.set("provider", PROVIDER_CONNECTIONS[opts.provider]);
  return url.toString();
}

function truncate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > UNTRUSTED_MAX ? `${value.slice(0, UNTRUSTED_MAX)}…` : value;
}

/** Only a registered-looking error code, never free text, reaches a message. */
function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : undefined;
}

/**
 * Validate the loopback callback and return the authorization code. Throws on a
 * provider error, a missing/mismatched state, or a missing code.
 *
 * The code is a credential: it is never placed in an error message or in the
 * error's data bag, so a failure that gets logged cannot replay the exchange.
 */
export function readCallbackParams(query: URLSearchParams, expectedState: string): string {
  const providerError = query.get("error");
  if (providerError !== null) {
    throw new OwnerLoginError("The sign-in was refused at the provider.", "oauth_authorize_failed", {
      provider_error: safeErrorCode(providerError) ?? "unknown",
      provider_message: truncate(query.get("error_description")),
    });
  }
  const state = query.get("state");
  if (state === null || state !== expectedState) {
    throw new OwnerLoginError(
      "The sign-in reply did not carry the state this login started with, so it was discarded.",
      "oauth_state_mismatch",
    );
  }
  const code = query.get("code");
  if (code === null || code.length === 0) {
    throw new OwnerLoginError("The sign-in reply carried no authorization code.", "oauth_authorize_failed", {
      provider_error: "missing_code",
    });
  }
  return code;
}

// ── token endpoint ──────────────────────────────────────────────────────────

export interface OwnerTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms after which the access token must be refreshed. */
  expiresAt: number;
  /** Present when `openid` was granted. DISPLAY ONLY — see readIdTokenClaims. */
  idToken?: string;
}

/** The two labels `account status` prints so the operator knows WHICH login. */
export interface IdTokenClaims {
  email?: string;
  provider?: string;
}

/**
 * Read the display labels out of an id_token. The signature is NOT verified,
 * and MUST NOT be: nothing here may steer a decision.
 *
 * That is safe for exactly this use. The token arrives over TLS on a direct
 * connection to the authorization server we discovered, it is stored sealed
 * next to the access token, and the only thing done with it is printing a name
 * next to "owner login:" in `account status`. Authorisation is decided by the
 * ACCESS token, which api.depixapp.com verifies against the AuthKit JWKS on
 * every request — a forged claim here changes a label, never an identity.
 */
export function readIdTokenClaims(idToken: string | undefined): IdTokenClaims {
  if (typeof idToken !== "string") return {};
  const payload = idToken.split(".")[1];
  if (payload === undefined) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  // Control characters stripped, not escaped: these strings are printed straight
  // onto a terminal, where a newline in `email` buys the claim a second line of
  // its own — and an ANSI escape buys rather more than that.
  const str = (value: unknown): string | undefined => {
    if (typeof value !== "string" || value.length === 0 || value.length > 320) return undefined;
    // eslint-disable-next-line no-control-regex
    const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
    return clean.length > 0 ? clean : undefined;
  };
  return {
    ...(str(parsed.email) !== undefined ? { email: str(parsed.email) } : {}),
    // Best effort: AuthKit does not promise a provider claim, so an absent one
    // is normal and simply leaves the label off.
    ...(str(parsed.provider) !== undefined ? { provider: str(parsed.provider) } : {}),
  };
}

async function postToken(opts: {
  tokenEndpoint: string;
  body: URLSearchParams;
  fetchImpl: typeof fetch;
  failureCode: string;
  failureMessage: string;
}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await opts.fetchImpl(opts.tokenEndpoint, {
      method: "POST",
      // No Authorization header: a public client has no secret to present.
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: opts.body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new OwnerLoginError(`${opts.failureMessage} The sign-in server could not be reached.`, opts.failureCode);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    throw new OwnerLoginError(opts.failureMessage, opts.failureCode, {
      http_status: res.status,
      provider_error: safeErrorCode(parsed.error) ?? `http_${res.status}`,
      provider_message: truncate(parsed.error_description),
    });
  }
  return parsed;
}

function readTokens(parsed: Record<string, unknown>, nowMs: number, previousRefresh?: string): OwnerTokens {
  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (accessToken.length === 0) {
    throw new OwnerLoginError("The sign-in server returned no access token.", "oauth_token_exchange_failed");
  }
  const expiresIn =
    typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) && parsed.expires_in > 0
      ? parsed.expires_in
      : FALLBACK_EXPIRES_IN_SECONDS;
  // Rotation: keep the previous refresh token when the server does not send a
  // new one, or a non-rotating server would log the operator out on first use.
  const refreshToken = typeof parsed.refresh_token === "string" ? parsed.refresh_token : previousRefresh;
  const idToken = typeof parsed.id_token === "string" ? parsed.id_token : undefined;
  return {
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    expiresAt: nowMs + expiresIn * 1000,
    ...(idToken !== undefined ? { idToken } : {}),
  };
}

export async function exchangeCode(opts: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<OwnerTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    code: opts.code,
    code_verifier: opts.verifier,
    redirect_uri: opts.redirectUri,
    resource: opts.resource,
  });
  const parsed = await postToken({
    tokenEndpoint: opts.tokenEndpoint,
    body,
    fetchImpl: opts.fetchImpl ?? fetch,
    failureCode: "oauth_token_exchange_failed",
    failureMessage: "The sign-in could not be completed.",
  });
  return readTokens(parsed, opts.nowMs ?? Date.now());
}

export async function refreshOwnerTokens(opts: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  resource: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<OwnerTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
    resource: opts.resource,
  });
  const parsed = await postToken({
    tokenEndpoint: opts.tokenEndpoint,
    body,
    fetchImpl: opts.fetchImpl ?? fetch,
    failureCode: "oauth_refresh_failed",
    failureMessage: "The owner login on this machine could not be renewed.",
  });
  return readTokens(parsed, opts.nowMs ?? Date.now(), opts.refreshToken);
}
