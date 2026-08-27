// The credential resolver (§3.1 / Part C): ApiClient.apiKey stops being captured
// once at construction and becomes a per-request resolver, so a key written mid
// session (register_account) is used on the VERY NEXT request without a restart
// (smoke S3.3). Precedence and the deployment-aware missing-key error are also
// pinned here.

import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/apiClient.js";
import { CredentialResolver } from "../src/credentials.js";
import { makeFetch } from "./helpers/mockFetch.js";

const BASE = "https://api.depixapp.com";

describe("ApiClient credential resolver (§3.1)", () => {
  it("resolves the key PER REQUEST — a key set after construction is used at once", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.Authorization);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    let current: string | undefined = undefined;
    const client = new ApiClient({ apiKey: () => current, apiBase: BASE, fetchImpl, deployment: "local" });

    // No key yet → the typed missing-key error, no request made.
    await expect(client.request({ method: "GET", path: "/api/me", tool: "t" })).rejects.toMatchObject({
      code: "missing_api_key",
    });
    expect(seen).toHaveLength(0);

    // Key appears mid-session (as register_account would set it) — same client.
    current = "sk_test_NEWKEY";
    await client.request({ method: "GET", path: "/api/me", tool: "t" });
    expect(seen).toEqual(["Bearer sk_test_NEWKEY"]);
  });

  it("still accepts a plain string key (back-compat)", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, json: { ok: true } }]);
    const client = new ApiClient({ apiKey: "sk_test_ABC", apiBase: BASE, fetchImpl });
    await expect(client.request({ method: "GET", path: "/api/me", tool: "t" })).resolves.toMatchObject({
      status: 200,
    });
  });

  it("local missing_api_key points at register_account (not a header the operator must set)", async () => {
    const { fetchImpl } = makeFetch([]);
    const client = new ApiClient({ apiKey: () => undefined, apiBase: BASE, fetchImpl, deployment: "local" });
    await client.request({ method: "GET", path: "/api/me", tool: "t" }).catch((err) => {
      expect(err.code).toBe("missing_api_key");
      expect(err.data.next_action).toEqual({ kind: "call_tool", tool: "register_account" });
    });
  });
});

describe("CredentialResolver precedence (§3.1)", () => {
  it("env WINS over the store, and reports which key is active", () => {
    const r = new CredentialResolver({ envKey: "sk_test_ENV" });
    r.setActiveKey("sk_test_STORE");
    expect(r.resolve()).toBe("sk_test_ENV");
    expect(r.source()).toBe("env");
  });

  it("falls back to the store key when no env key is set", () => {
    const r = new CredentialResolver({ envKey: undefined });
    expect(r.resolve()).toBeUndefined();
    expect(r.source()).toBe("none");
    r.setActiveKey("sk_test_STORE");
    expect(r.resolve()).toBe("sk_test_STORE");
    expect(r.source()).toBe("store");
  });

  it("conflict is detectable: an env key present when a store key is set", () => {
    const r = new CredentialResolver({ envKey: "sk_live_ENV" });
    r.setActiveKey("sk_test_STORE");
    expect(r.hasEnvOverride()).toBe(true);
  });
});
