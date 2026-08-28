// Thin, stateless HTTP client for the public DePix App API (spec §2.1, §3.2, §4.6).
// It injects the caller's Bearer key VERBATIM, enforces the fail-closed egress
// rules (origin allowlist + redirect:'error'), captures X-Request-Id, maps the
// structured error envelope to ToolError, and auto-retries only transient 429 /
// 503 / idempotency_in_flight with a bounded backoff.

import { ALLOWED_API_ORIGINS } from "./config.js";
import {
  AUTO_RETRY_CODES,
  ToolError,
  mapApiError,
  missingApiKeyError,
  type ApiErrorEnvelope,
  type LockedVaults,
} from "./errors.js";
import { logger } from "./log.js";

export interface ApiResult<T = unknown> {
  data: T;
  status: number;
  requestId?: string;
  replayed: boolean;
}

export type QueryValue = string | number | boolean | undefined;

export interface ApiRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Tool name for correlation logging (never the key/body). */
  tool: string;
  /**
   * Optional abort/timeout signal, forwarded to fetch AND to retry sleeps so a
   * deadline-bound caller (wait_for_checkout) or a disconnected client stops
   * this request immediately instead of running past its budget.
   */
  signal?: AbortSignal;
}

/** A resolved bearer plus what kind it is — only an OAuth session can refresh. */
export interface ResolvedCredential {
  token: string;
  kind: "api_key" | "oauth";
}

/**
 * A per-request key source: a fixed string, or a resolver read on every call.
 * The resolver may return a bare string (an sk_ key) or a ResolvedCredential,
 * which is what lets the local server also present the operator's OAuth session.
 */
export type ApiKeySource = string | undefined | (() => string | ResolvedCredential | undefined);

function asCredential(value: string | ResolvedCredential | undefined): ResolvedCredential | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? { token: value, kind: "api_key" } : value;
}

export interface ApiClientOptions {
  /** Caller's bearer credential, forwarded verbatim: an `sk_` API key, or the
   * verified WorkOS JWT when authMode==="oauth". A FUNCTION is resolved PER
   * REQUEST (§3.1) so a key minted mid-session (register_account) is used at
   * once, without a restart. Undefined ⇒ every request errors clearly. */
  apiKey: ApiKeySource;
  apiBase: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxAttempts?: number;
  /** If a retry would sleep longer than this, surface a retryable error instead. */
  maxRetrySleepMs?: number;
  /** "oauth" when the CONNECTION authenticated via OAuth (no sk_): the
   * missing-key error then explains the OAuth situation instead of telling
   * the user to reconnect with a header they already sent. */
  authMode?: "oauth";
  /** Which deployment this client serves — steers the missing_api_key
   * next_action (§5.1): "local" points at register_account, "hosted" at signup.
   * Default "hosted". */
  deployment?: "hosted" | "local";
  /**
   * Local vaults the boot found sealed shut. Read only when NO credential
   * resolves: it turns "no key is configured" into the truth, which is that one
   * is configured and could not be opened.
   */
  lockedCredentials?: LockedVaults;
  /**
   * Renew an expired OAuth session on a 401. Called AT MOST ONCE per request,
   * and only when the resolved credential is an OAuth session (an sk_ key has
   * nothing to renew). Returning true means the resolver now holds a fresh
   * token and the request is worth one more attempt; throwing propagates —
   * which is how the didactic `owner_session_expired` reaches the agent instead
   * of a bare 401.
   */
  onUnauthorized?: () => Promise<boolean>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function buildQueryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, typeof value === "boolean" ? String(value) : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export class ApiClient {
  /** Resolved per request (§3.1): a fixed key is wrapped as a constant thunk. */
  private readonly resolveKey: () => ResolvedCredential | undefined;
  private readonly onUnauthorized?: () => Promise<boolean>;
  private readonly authMode?: "oauth";
  private readonly deployment: "hosted" | "local";
  private readonly lockedCredentials: LockedVaults;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly maxRetrySleepMs: number;

  constructor(opts: ApiClientOptions) {
    // Bind to a const so the type narrowing survives into the constant thunk.
    const key = opts.apiKey;
    this.resolveKey = typeof key === "function" ? () => asCredential(key()) : () => asCredential(key);
    if (opts.onUnauthorized) this.onUnauthorized = opts.onUnauthorized;
    this.apiBase = opts.apiBase;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.maxRetrySleepMs = opts.maxRetrySleepMs ?? 10_000;
    this.authMode = opts.authMode;
    this.deployment = opts.deployment ?? "hosted";
    this.lockedCredentials = opts.lockedCredentials ?? {};
  }

  /** Build + validate the target URL against the strict origin allowlist. */
  private resolveUrl(path: string, query?: Record<string, QueryValue>): URL {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(normalizedPath + buildQueryString(query), this.apiBase);
    if (!ALLOWED_API_ORIGINS.includes(url.origin)) {
      // Fail-closed BEFORE any fetch and before the Authorization header exists,
      // so a misconfigured/malicious DEPIX_API_BASE can never receive the key.
      throw new ToolError(
        "DePix App MCP is misconfigured: the API base points to a non-allowlisted origin. The request was refused before any network call.",
        "config_error",
        { data: { origin: url.origin } },
      );
    }
    return url;
  }

  async request<T = unknown>(req: ApiRequest): Promise<ApiResult<T>> {
    // Resolve the key HERE, per request (§3.1): a key written mid-session by
    // register_account is picked up on the very next call, no restart.
    let credential = this.resolveKey();
    // Credential presence first (clear, actionable error — spec §3.3). A WorkOS
    // token has no sk_ prefix, and arrives two ways: the HOSTED connection
    // forwards the JWT it verified at the edge (authMode "oauth"), and the LOCAL
    // server can present the operator's own login (kind "oauth"). Every other
    // mode still requires an sk_ key. The strict origin allowlist below gates
    // where the header may be sent, for all of them.
    const isOAuth = credential?.kind === "oauth" || this.authMode === "oauth";
    if (!credential || (!isOAuth && !credential.token.startsWith("sk_"))) {
      throw missingApiKeyError(this.authMode, this.deployment, this.lockedCredentials);
    }
    // Origin allowlist BEFORE the Authorization header is ever attached (§3.2).
    const url = this.resolveUrl(req.path, req.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.token}`,
      Accept: "application/json",
    };
    let bodyText: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(req.body);
    }
    if (req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;

    // Only GETs and idempotency-keyed POSTs are safe to auto-retry on a
    // transient failure: a 503 or dropped connection on a non-idempotent POST
    // (e.g. create_product) could double-create. Unsafe requests surface the
    // retryable error to the agent instead of looping.
    const retrySafe = req.method === "GET" || Boolean(req.idempotencyKey);

    let lastError: ToolError | undefined;
    // ONE renewal per request, and it buys exactly one extra attempt: an expired
    // OAuth session must not eat the transient-failure budget, and `refreshed`
    // is set before the hook is awaited so no 401 can ever loop.
    let refreshed = false;
    for (let attempt = 1; attempt <= this.maxAttempts + (refreshed ? 1 : 0); attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: req.method,
          headers,
          body: bodyText,
          // Never follow a 3xx — the key must never be re-sent to a redirect
          // target. Any 3xx becomes a network error (spec §3.2).
          redirect: "error",
          signal: req.signal,
        });
      } catch (cause) {
        // Abort/timeout is the caller's deadline speaking — propagate as-is so
        // deadline-aware callers (wait_for_checkout) can handle it.
        if (
          cause instanceof DOMException &&
          (cause.name === "AbortError" || cause.name === "TimeoutError")
        ) {
          throw cause;
        }
        lastError = new ToolError(
          "Could not reach the DePix App API (network error). Please retry.",
          "network_error",
          { retryable: true },
        );
        logger.warn("api_network_error", { tool: req.tool, method: req.method, path: req.path, attempt });
        if (retrySafe && attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs(attempt), req.signal);
          continue;
        }
        throw lastError;
      }

      const requestId = res.headers.get("x-request-id") ?? undefined;
      const replayed = res.headers.get("idempotency-replayed") === "true";
      const parsed = await this.parseBody(res);

      logger.info("api_request", {
        tool: req.tool,
        method: req.method,
        path: req.path,
        status: res.status,
        request_id: requestId,
        attempt,
      });

      if (res.ok) {
        return { data: parsed as T, status: res.status, requestId, replayed };
      }

      // An expired owner session: renew once and replay. Safe for a POST too —
      // a 401 means the API rejected the credential and did nothing.
      if (res.status === 401 && credential.kind === "oauth" && !refreshed && this.onUnauthorized !== undefined) {
        refreshed = true;
        if (await this.onUnauthorized()) {
          const renewed = this.resolveKey();
          if (renewed !== undefined) {
            credential = renewed;
            headers.Authorization = `Bearer ${renewed.token}`;
            continue;
          }
        }
      }

      const toolError = mapApiError(res.status, parsed as ApiErrorEnvelope, requestId, this.authMode, this.deployment);
      logger.warn("api_error", {
        tool: req.tool,
        method: req.method,
        path: req.path,
        status: res.status,
        error_code: toolError.code,
        request_id: requestId,
        attempt,
      });

      // Auto-retry only the transient set, and only when the required wait fits
      // the per-call budget (spec §4.6). Everything else surfaces immediately.
      if (retrySafe && AUTO_RETRY_CODES.has(toolError.code) && attempt < this.maxAttempts) {
        const waitMs = this.retryDelayMs(attempt, toolError.data.retry_after);
        if (waitMs !== null) {
          lastError = toolError;
          await this.sleep(waitMs, req.signal);
          continue;
        }
      }
      throw toolError;
    }
    // Exhausted attempts.
    throw lastError ?? new ToolError("Request failed after retries.", "network_error", { retryable: true });
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.maxRetrySleepMs, 1000 * 2 ** (attempt - 1));
  }

  /**
   * Delay before an auto-retry. Honors Retry-After when present; returns null
   * (⇒ do not auto-retry, surface a retryable error) when the wait exceeds the
   * per-call budget, so a long business window never blocks the invocation.
   */
  private retryDelayMs(attempt: number, retryAfter: unknown): number | null {
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      const ms = retryAfter * 1000;
      return ms > this.maxRetrySleepMs ? null : ms;
    }
    return this.backoffMs(attempt);
  }

  private async parseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON body: wrap so error mapping still has something structured.
      return res.ok ? null : { error: { code: `http_${res.status}`, message: text } };
    }
  }
}
