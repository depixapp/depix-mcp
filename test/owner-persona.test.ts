// Persona precedence (`depix-mcp account`) and the OAuth refresh retry.
//
// The whole point of this file is that the server NEVER acts as an ambiguous
// identity: with an agent account AND an owner login on the same machine, one of
// them wins for a stated reason that `account status` can print.
//
// PRECEDENCE: DEPIX_API_KEY env > explicit `account use` > default (agent > owner).

import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/apiClient.js";
import { CredentialResolver } from "../src/credentials.js";

const BASE = "https://api.depixapp.com";
const OWNER_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzAxIn0.OWNER-SIGNATURE-VALUE";

describe("CredentialResolver personas", () => {
  it("default order is agent-first: a registered agent key beats the owner session", () => {
    const r = new CredentialResolver({});
    r.setActiveKey("sk_test_AGENT");
    r.setOwnerToken(OWNER_JWT);
    expect(r.resolve()).toBe("sk_test_AGENT");
    expect(r.source()).toBe("store");
    expect(r.persona()).toBe("agent");
    expect(r.bothPersonasPresent()).toBe(true);
  });

  it("with only an owner session, the owner session is what authenticates", () => {
    const r = new CredentialResolver({});
    r.setOwnerToken(OWNER_JWT);
    expect(r.resolveCredential()).toEqual({ token: OWNER_JWT, kind: "oauth" });
    expect(r.source()).toBe("owner");
    expect(r.persona()).toBe("owner");
    expect(r.bothPersonasPresent()).toBe(false);
  });

  it("an explicit `account use owner` overrides the agent-first default", () => {
    const r = new CredentialResolver({});
    r.setActiveKey("sk_test_AGENT");
    r.setOwnerToken(OWNER_JWT);
    r.setPreference("owner");
    expect(r.resolveCredential()).toEqual({ token: OWNER_JWT, kind: "oauth" });
    expect(r.source()).toBe("owner");
    expect(r.preference()).toBe("owner");
  });

  it("an explicit `account use agent` is honoured too", () => {
    const r = new CredentialResolver({ preference: "agent" });
    r.setActiveKey("sk_test_AGENT");
    r.setOwnerToken(OWNER_JWT);
    expect(r.resolve()).toBe("sk_test_AGENT");
    expect(r.source()).toBe("store");
  });

  it("DEPIX_API_KEY beats BOTH personas and says so", () => {
    const r = new CredentialResolver({ envKey: "sk_live_ENV", preference: "owner" });
    r.setActiveKey("sk_test_AGENT");
    r.setOwnerToken(OWNER_JWT);
    expect(r.resolveCredential()).toEqual({ token: "sk_live_ENV", kind: "api_key" });
    expect(r.source()).toBe("env");
    expect(r.hasEnvOverride()).toBe(true);
  });

  it("a selection whose persona is not available falls back instead of authenticating as nobody", () => {
    // `logout` clears the session but a stale `owner` selection can survive a
    // crash. Refusing every request would be worse than falling back, so the
    // fallback happens AND stays visible (selectionUnavailable).
    const r = new CredentialResolver({ preference: "owner" });
    r.setActiveKey("sk_test_AGENT");
    expect(r.resolve()).toBe("sk_test_AGENT");
    expect(r.source()).toBe("store");
    expect(r.selectionUnavailable()).toBe(true);

    const r2 = new CredentialResolver({ preference: "agent" });
    r2.setOwnerToken(OWNER_JWT);
    expect(r2.source()).toBe("owner");
    expect(r2.selectionUnavailable()).toBe(true);
  });

  it("no credential at all resolves to nothing", () => {
    const r = new CredentialResolver({});
    expect(r.resolveCredential()).toBeUndefined();
    expect(r.source()).toBe("none");
    expect(r.persona()).toBe("none");
  });

  it("clearing the owner token (logout) drops back to the agent account", () => {
    const r = new CredentialResolver({});
    r.setActiveKey("sk_test_AGENT");
    r.setOwnerToken(OWNER_JWT);
    r.setPreference("owner");
    expect(r.source()).toBe("owner");
    r.setOwnerToken(undefined);
    r.setPreference(undefined);
    expect(r.resolve()).toBe("sk_test_AGENT");
    expect(r.hasOwnerSession()).toBe(false);
  });
});

describe("ApiClient with an owner (OAuth) credential", () => {
  it("sends a non-sk_ owner token as the bearer instead of refusing it", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.Authorization);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = new CredentialResolver({});
    r.setOwnerToken(OWNER_JWT);
    const client = new ApiClient({ apiKey: r.asFunction(), apiBase: BASE, fetchImpl, deployment: "local" });
    await client.request({ method: "GET", path: "/api/me", tool: "get_account" });
    expect(seen).toEqual([`Bearer ${OWNER_JWT}`]);
  });

  it("still refuses a non-sk_ credential that is NOT an OAuth session", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const client = new ApiClient({ apiKey: () => "not-a-key", apiBase: BASE, fetchImpl, deployment: "local" });
    await expect(client.request({ method: "GET", path: "/api/me", tool: "t" })).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });

  it("on a 401 it refreshes ONCE and retries ONCE with the rotated token", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.Authorization);
      return seen.length === 1
        ? new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = new CredentialResolver({});
    r.setOwnerToken("eyJ.OLD.TOKEN");
    let refreshes = 0;
    const client = new ApiClient({
      apiKey: r.asFunction(),
      apiBase: BASE,
      fetchImpl,
      deployment: "local",
      onUnauthorized: async () => {
        refreshes++;
        r.setOwnerToken("eyJ.NEW.TOKEN");
        return true;
      },
    });

    await expect(client.request({ method: "GET", path: "/api/me", tool: "t" })).resolves.toMatchObject({
      status: 200,
    });
    expect(refreshes).toBe(1);
    expect(seen).toEqual(["Bearer eyJ.OLD.TOKEN", "Bearer eyJ.NEW.TOKEN"]);
  });

  it("a second 401 after the refresh does NOT trigger another refresh (no loops)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 })) as unknown as typeof fetch;
    const r = new CredentialResolver({});
    r.setOwnerToken("eyJ.OLD.TOKEN");
    let refreshes = 0;
    const client = new ApiClient({
      apiKey: r.asFunction(),
      apiBase: BASE,
      fetchImpl,
      deployment: "local",
      onUnauthorized: async () => {
        refreshes++;
        r.setOwnerToken("eyJ.NEW.TOKEN");
        return true;
      },
    });
    await expect(client.request({ method: "GET", path: "/api/me", tool: "t" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(refreshes).toBe(1);
  });

  it("never refreshes for an sk_ key — only an OAuth session can be refreshed", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 })) as unknown as typeof fetch;
    let refreshes = 0;
    const client = new ApiClient({
      apiKey: "sk_test_ABC",
      apiBase: BASE,
      fetchImpl,
      deployment: "local",
      onUnauthorized: async () => {
        refreshes++;
        return true;
      },
    });
    await expect(client.request({ method: "GET", path: "/api/me", tool: "t" })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(refreshes).toBe(0);
  });

  it("a POST is retried after the refresh too — a 401 means the write never happened", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.Authorization);
      return seen.length === 1
        ? new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 })
        : new Response(JSON.stringify({ id: "chk_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = new CredentialResolver({});
    r.setOwnerToken("eyJ.OLD.TOKEN");
    const client = new ApiClient({
      apiKey: r.asFunction(),
      apiBase: BASE,
      fetchImpl,
      deployment: "local",
      onUnauthorized: async () => {
        r.setOwnerToken("eyJ.NEW.TOKEN");
        return true;
      },
    });
    await expect(
      client.request({ method: "POST", path: "/api/checkouts", body: {}, tool: "create_checkout" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(seen).toHaveLength(2);
  });

  it("a refresh that throws surfaces the typed owner_session_expired error, not a bare 401", async () => {
    const { ownerSessionExpiredError } = await import("../src/errors.js");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 })) as unknown as typeof fetch;
    const r = new CredentialResolver({});
    r.setOwnerToken("eyJ.OLD.TOKEN");
    const client = new ApiClient({
      apiKey: r.asFunction(),
      apiBase: BASE,
      fetchImpl,
      deployment: "local",
      onUnauthorized: () => Promise.reject(ownerSessionExpiredError()),
    });
    await expect(client.request({ method: "GET", path: "/api/me", tool: "t" })).rejects.toMatchObject({
      code: "owner_session_expired",
      data: { next_action: { kind: "human_step" } },
    });
  });
});

describe("owner_session_expired next_action", () => {
  it("tells the human to run login again, in both languages", async () => {
    const { ownerSessionExpiredError } = await import("../src/errors.js");
    const err = ownerSessionExpiredError();
    const action = err.data.next_action as { kind: string; relay: { pt: string; en: string } };
    expect(action.kind).toBe("human_step");
    expect(action.relay.en).toContain("login");
    expect(action.relay.pt).toContain("login");
    expect(action.relay.en).toContain("@depixapp/mcp");
  });
});

describe("decidePersona — ONE ladder behind every surface (R3)", () => {
  // The boot line used to glue persona() to preference() without asking whether
  // the choice actually decided anything. With DEPIX_API_KEY set AND
  // `account use owner` selected it printed:
  //
  //   acting as the agent account (selected with `account use owner`)
  //
  // — wrong on all three counts. `account status` walked its own copy of the
  // ladder and got it right, which is exactly how the two drifted. One function
  // now answers for both.
  const decide = async (facts: Parameters<typeof import("../src/credentials.js").decidePersona>[0]) =>
    (await import("../src/credentials.js")).decidePersona(facts);

  it("env key + `account use owner`: the env key wins, and the reason says so", async () => {
    const v = await decide({ envKeyPresent: true, hasAgent: true, hasOwner: true, preference: "owner" });
    expect(v.active).toBe("agent");
    expect(v.basis).toBe("env_override");
    expect(v.reason).toContain("DEPIX_API_KEY");
    // The lie that shipped: crediting the selection for a decision it lost.
    expect(v.reason).not.toContain("account use owner");
  });

  it("`account use owner` with a session: the selection is the reason", async () => {
    const v = await decide({ envKeyPresent: false, hasAgent: true, hasOwner: true, preference: "owner" });
    expect(v.active).toBe("owner");
    expect(v.basis).toBe("selection");
    expect(v.reason).toContain("account use owner");
  });

  it("`account use owner` with NO session: the fallback is named as a fallback", async () => {
    const v = await decide({ envKeyPresent: false, hasAgent: true, hasOwner: false, preference: "owner" });
    expect(v.active).toBe("agent");
    expect(v.basis).toBe("selection_unavailable");
    expect(v.reason).toMatch(/no owner login/i);
    expect(v.reason).toMatch(/fall/i);
  });

  it("two identities, no selection: the default order is the reason", async () => {
    const v = await decide({ envKeyPresent: false, hasAgent: true, hasOwner: true });
    expect(v.active).toBe("agent");
    expect(v.basis).toBe("default");
    expect(v.reason).toMatch(/default/i);
  });

  it("owner only: the sole identity, said plainly", async () => {
    const v = await decide({ envKeyPresent: false, hasAgent: false, hasOwner: true });
    expect(v.active).toBe("owner");
    expect(v.basis).toBe("default");
  });

  it("nothing configured resolves to none", async () => {
    const v = await decide({ envKeyPresent: false, hasAgent: false, hasOwner: false });
    expect(v.active).toBe("none");
    expect(v.basis).toBe("none");
  });

  it("an env key alone is not an override — there is nothing to override", async () => {
    const v = await decide({ envKeyPresent: true, hasAgent: false, hasOwner: false });
    expect(v.active).toBe("agent");
    expect(v.basis).toBe("env");
  });

  it("the resolver reports the SAME verdict it authenticates with", async () => {
    const { CredentialResolver } = await import("../src/credentials.js");
    const r = new CredentialResolver({ envKey: "sk_live_ENV", preference: "owner" });
    r.setActiveKey("sk_test_AGENT");
    r.setOwnerToken(OWNER_JWT);
    // The credential actually sent, and the sentence printed about it, agree.
    expect(r.resolveCredential()?.token).toBe("sk_live_ENV");
    expect(r.verdict().active).toBe("agent");
    expect(r.verdict().basis).toBe("env_override");
  });
});
