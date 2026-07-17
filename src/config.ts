// Public, zero-secret configuration (spec §2.6). No API key, Eulen token, HMAC
// or DB credential ever lives here — those would be an architecture bug. The
// caller's `sk_` never comes from env: it arrives per-request in the
// Authorization header (HTTP transport) or DEPIX_API_KEY (stdio transport) and
// lives only in the memory of that invocation.

export const DEFAULT_API_BASE = "https://api.depixapp.com";

// Hobby-safe default wait budget for wait_for_checkout (spec §2.5). Production
// sets MCP_MAX_WAIT_SECONDS ~780 (Vercel Pro, maxDuration 800) via env; this
// fallback keeps the tool correct even on Hobby (maxDuration 300) by returning
// timed_out well before the platform cap instead of being killed.
export const DEFAULT_MAX_WAIT_SECONDS = 290;

// Absolute ceiling, safely below the Vercel maxDuration (800s). A misconfigured
// MCP_MAX_WAIT_SECONDS can never push the wait budget above this, so the internal
// deadline always fires before the platform would kill the stream (spec §2.5).
export const MAX_WAIT_CEILING_SECONDS = 790;

// Strict, hard-coded allowlist of origins this server may EVER send the caller's
// Authorization header to (spec §3.2). This is the single fail-closed gate: a
// misconfigured or malicious DEPIX_API_BASE whose origin is not on this list is
// rejected BEFORE any fetch, so the bearer key can never leak to an unexpected
// host. Deliberately NOT driven by an env var — runtime config must not be able
// to widen it. To enable a staging origin, add it here in a reviewed change.
export const ALLOWED_API_ORIGINS: readonly string[] = ["https://api.depixapp.com"];

export const SERVER_NAME = "com.depixapp/gateway";
export const SERVER_TITLE = "DePix Gateway";

/** Resolve the API base URL, trimming trailing slashes. */
export function resolveApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.DEPIX_API_BASE?.trim() || DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}

/** Resolve the wait budget; falls back to the Hobby-safe default. */
export function resolveMaxWaitSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_MAX_WAIT_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 5) {
    // Clamp to the platform-safe ceiling — never trust the env to stay below 800s.
    return Math.min(parsed, MAX_WAIT_CEILING_SECONDS);
  }
  return DEFAULT_MAX_WAIT_SECONDS;
}

/** Server version, surfaced in the MCP handshake and /.well-known/mcp.json. */
export function resolveServerVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCP_SERVER_VERSION?.trim() || "1.0.0";
}

// ── OAuth Resource Server (F4 §2.9 caminho B) — both values are PUBLIC ────

// Canonical MCP resource URL: must byte-match the Resource Indicator in the
// WorkOS dashboard AND the URL users type into claude.ai/ChatGPT.
export const DEFAULT_RESOURCE_URL = "https://mcp.depixapp.com/mcp";

/**
 * The AuthKit domain (issuer + JWKS host), e.g. https://acme-123.authkit.app.
 * This is the FEATURE FLAG for the whole OAuth surface: null (unset) means
 * OAuth is off and every behavior is byte-identical to before — no 401
 * challenge, no discovery documents.
 */
export function resolveAuthkitDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AUTHKIT_DOMAIN?.trim();
  if (!raw) return null;
  const normalized = raw.replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(normalized)) return null; // https origin only
  return normalized;
}

/** Canonical resource URL (aud check + PRM `resource` field). */
export function resolveResourceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MCP_RESOURCE_URL?.trim();
  return (raw || DEFAULT_RESOURCE_URL).replace(/\/+$/, "");
}

// DNS-rebinding protection (official MCP guidance): the Streamable HTTP
// transport rejects requests whose Host header is not on this list. Default is
// the production host; MCP_ALLOWED_HOSTS (comma-separated) lets Vercel preview
// environments add their *.vercel.app host without touching code.
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["mcp.depixapp.com"];

/** Resolve the allowed Host headers for DNS-rebinding protection. */
export function resolveAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MCP_ALLOWED_HOSTS?.trim();
  if (!raw) return [...DEFAULT_ALLOWED_HOSTS];
  const hosts = raw
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return hosts.length > 0 ? hosts : [...DEFAULT_ALLOWED_HOSTS];
}
