import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/apiClient.js";
import { ToolError } from "../src/errors.js";
import { makeFetch, errorEnvelope } from "./helpers/mockFetch.js";

const BASE = "https://api.depixapp.com";
const KEY = "sk_test_ABCDEF123456";

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  return new ApiClient({
    apiKey: KEY,
    apiBase: BASE,
    fetchImpl,
    sleep: async () => {}, // no real waiting in tests
    ...extra,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("auth passthrough (spec §3.1, §3.2)", () => {
  it("forwards the caller's key VERBATIM as a Bearer header", async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 200, json: { ok: true } }]);
    await client(fetchImpl).request({ method: "GET", path: "/api/me", tool: "get_account" });
    expect(requests[0].headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("clear error when no key is provided (no anonymous API call)", async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 200, json: {} }]);
    const c = new ApiClient({ apiKey: undefined, apiBase: BASE, fetchImpl });
    await expect(
      c.request({ method: "GET", path: "/api/me", tool: "get_account" }),
    ).rejects.toMatchObject({ code: "missing_api_key" });
    expect(requests.length).toBe(0); // never called the API
  });
});

describe("egress safety (spec §3.2)", () => {
  it("rejects a non-allowlisted origin BEFORE any fetch (key can't leak)", async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 200, json: {} }]);
    const c = new ApiClient({ apiKey: KEY, apiBase: "https://evil.example.com", fetchImpl });
    await expect(
      c.request({ method: "GET", path: "/api/me", tool: "get_account" }),
    ).rejects.toMatchObject({ code: "config_error" });
    expect(requests.length).toBe(0);
  });

  it("a 3xx (redirect:'error' throws) becomes a retryable network error, not a leak", async () => {
    const { fetchImpl } = makeFetch([{ throwNetwork: true }, { throwNetwork: true }, { throwNetwork: true }]);
    await expect(
      client(fetchImpl).request({ method: "GET", path: "/api/me", tool: "get_account" }),
    ).rejects.toMatchObject({ code: "network_error", retryable: true });
  });
});

describe("Idempotency-Key (spec §4.2)", () => {
  it("propagates an explicit key", async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 201, json: { id: "chk_1" } }]);
    await client(fetchImpl).request({
      method: "POST",
      path: "/api/checkouts",
      body: { amount: 1500 },
      idempotencyKey: "my-key",
      tool: "create_checkout",
    });
    expect(requests[0].headers["Idempotency-Key"]).toBe("my-key");
  });
});

describe("abort/deadline signal (spec §2.5 — wait polls are bounded)", () => {
  it("forwards the signal to fetch and rethrows the abort untouched", async () => {
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seenSignals.push(init?.signal ?? undefined);
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(
      client(fetchImpl).request({
        method: "GET",
        path: "/api/checkouts/chk_1",
        tool: "wait_for_checkout",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(seenSignals[0]).toBe(controller.signal); // forwarded, not replaced
  });

  it("an aborted signal cancels the retry sleep (no zombie retries)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, requests } = makeFetch([
      { status: 429, json: errorEnvelope("merchant_rate_limited", { retry_after: 1 }) },
    ]);
    // Real (signal-aware) default sleep: the aborted signal rejects immediately.
    const c = new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl });
    await expect(
      c.request({ method: "GET", path: "/api/me", tool: "get_account", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.length).toBe(1); // no second attempt after the abort
  });
});

describe("query params", () => {
  it("serializes defined params and skips undefined", async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 200, json: {} }]);
    await client(fetchImpl).request({
      method: "GET",
      path: "/api/checkouts",
      query: { status: "completed", limit: 50, product_id: undefined },
      tool: "list_checkouts",
    });
    expect(requests[0].url).toContain("status=completed");
    expect(requests[0].url).toContain("limit=50");
    expect(requests[0].url).not.toContain("product_id");
  });
});

describe("auto-retry (spec §4.6)", () => {
  it("retries 429 respecting Retry-After up to 3 attempts", async () => {
    const { fetchImpl, requests } = makeFetch([
      { status: 429, json: errorEnvelope("merchant_rate_limited", { retry_after: 1 }) },
      { status: 429, json: errorEnvelope("merchant_rate_limited", { retry_after: 1 }) },
      { status: 200, json: { ok: true } },
    ]);
    const res = await client(fetchImpl).request({ method: "GET", path: "/api/me", tool: "get_account" });
    expect(res.status).toBe(200);
    expect(requests.length).toBe(3);
  });

  it("does NOT auto-retry a non-idempotent POST on 503 (double-create guard)", async () => {
    const { fetchImpl, requests } = makeFetch([
      { status: 503, json: errorEnvelope("service_unavailable", { retry_after: 1 }) },
    ]);
    await expect(
      client(fetchImpl).request({
        method: "POST",
        path: "/api/products",
        body: { name: "x", amount: 700 },
        tool: "create_product",
      }),
    ).rejects.toMatchObject({ code: "service_unavailable", retryable: true });
    expect(requests.length).toBe(1); // surfaced, not retried
  });

  it("DOES auto-retry an idempotency-keyed POST on 503", async () => {
    const { fetchImpl, requests } = makeFetch([
      { status: 503, json: errorEnvelope("service_unavailable", { retry_after: 1 }) },
      { status: 201, json: { id: "chk_1" } },
    ]);
    const res = await client(fetchImpl).request({
      method: "POST",
      path: "/api/checkouts",
      body: {},
      idempotencyKey: "k1",
      tool: "create_checkout",
    });
    expect(res.status).toBe(201);
    expect(requests.length).toBe(2);
  });

  it("does NOT retry a non-retryable 4xx", async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 403, json: errorEnvelope("insufficient_scope", { details: { required_scope: "merchant_read" } }) }]);
    await expect(
      client(fetchImpl).request({ method: "GET", path: "/api/me", tool: "get_account" }),
    ).rejects.toBeInstanceOf(ToolError);
    expect(requests.length).toBe(1);
  });

  it("surfaces (does not sleep through) a 429 whose Retry-After exceeds the budget", async () => {
    const { fetchImpl, requests } = makeFetch([
      { status: 429, json: errorEnvelope("merchant_rate_limited", { retry_after: 3600 }) },
    ]);
    await expect(
      client(fetchImpl, { maxRetrySleepMs: 10_000 }).request({
        method: "GET",
        path: "/api/me",
        tool: "get_account",
      }),
    ).rejects.toMatchObject({ code: "merchant_rate_limited", retryable: true });
    expect(requests.length).toBe(1); // did not loop
  });

  it("captures X-Request-Id and Idempotency-Replayed", async () => {
    const { fetchImpl } = makeFetch([
      { status: 201, json: { id: "chk_1" }, headers: { "x-request-id": "req_9", "idempotency-replayed": "true" } },
    ]);
    const res = await client(fetchImpl).request({ method: "POST", path: "/api/checkouts", body: {}, tool: "create_checkout" });
    expect(res.requestId).toBe("req_9");
    expect(res.replayed).toBe(true);
  });
});

describe("redaction (spec §3.2, §8)", () => {
  it("never writes the API key to logs, even on error", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const { fetchImpl } = makeFetch([
      { status: 200, json: { ok: true }, headers: { "x-request-id": "req_1" } },
      { status: 403, json: errorEnvelope("insufficient_scope", { details: { required_scope: "wallet_read" } }) },
    ]);
    const c = client(fetchImpl);
    await c.request({ method: "GET", path: "/api/me", tool: "get_account" });
    await c.request({ method: "GET", path: "/api/deposits/x", tool: "get_deposit_status" }).catch(() => {});
    spy.mockRestore();
    const all = writes.join("");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("sk_test_ABCDEF");
    expect(writes.length).toBeGreaterThan(0); // it did log something
  });
});
