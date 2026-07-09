// Thin, stateless HTTP client for the public DePix API (spec §2.1, §3.2, §4.6).
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

export interface ApiClientOptions {
  /** Caller's sk_ key (verbatim). Undefined ⇒ every request errors clearly. */
  apiKey: string | undefined;
  apiBase: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxAttempts?: number;
  /** If a retry would sleep longer than this, surface a retryable error instead. */
  maxRetrySleepMs?: number;
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
  private readonly apiKey: string | undefined;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly maxRetrySleepMs: number;

  constructor(opts: ApiClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.maxRetrySleepMs = opts.maxRetrySleepMs ?? 10_000;
  }

  /** Build + validate the target URL against the strict origin allowlist. */
  private resolveUrl(path: string, query?: Record<string, QueryValue>): URL {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(normalizedPath + buildQueryString(query), this.apiBase);
    if (!ALLOWED_API_ORIGINS.includes(url.origin)) {
      // Fail-closed BEFORE any fetch and before the Authorization header exists,
      // so a misconfigured/malicious DEPIX_API_BASE can never receive the key.
      throw new ToolError(
        "DePix MCP is misconfigured: the API base points to a non-allowlisted origin. The request was refused before any network call.",
        "config_error",
        { data: { origin: url.origin } },
      );
    }
    return url;
  }

  async request<T = unknown>(req: ApiRequest): Promise<ApiResult<T>> {
    // Key presence first (clear, actionable error — spec §3.3).
    if (!this.apiKey || !this.apiKey.startsWith("sk_")) {
      throw missingApiKeyError();
    }
    // Origin allowlist BEFORE the Authorization header is ever attached (§3.2).
    const url = this.resolveUrl(req.path, req.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
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
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
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
          "Could not reach the DePix API (network error). Please retry.",
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

      const toolError = mapApiError(res.status, parsed as ApiErrorEnvelope, requestId);
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
