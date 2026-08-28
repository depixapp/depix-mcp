// `depix-mcp login` / `logout` — the orchestration, with the listener, the
// browser, fetch and the encrypted store all injected.
//
// The listener is started BEFORE the browser is opened (a test asserts the
// order): opening first would race the redirect against a socket that is not
// bound yet, and the operator would see a connection-refused page.

import { describe, expect, it } from "vitest";
import { OWNER_LOOPBACK_PORT, OWNER_LOOPBACK_REDIRECT_URI } from "../src/owner-oauth.js";
import { runOwnerLogin, runOwnerLogout, type OwnerLoginDeps } from "../src/login-flow.js";
import type { OwnerSession } from "../src/wallet-engine/agent/owner-session-store.js";

const RESOURCE = "https://mcp.depixapp.com/mcp";
const AS = "https://as.example";
const ACCESS = "eyJhbGciOiJSUzI1NiJ9.PAYLOAD.OWNER-ACCESS-TOKEN-VALUE";
const REFRESH = "wos_refresh_TOKEN_VALUE";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Harness {
  deps: OwnerLoginDeps;
  out: string[];
  saved: OwnerSession[];
  order: string[];
  authorizeUrl(): string;
  pages: Array<{ status: number; html: string }>;
}

function harness(overrides: Partial<OwnerLoginDeps> = {}, opts: { tokenResponse?: Response } = {}): Harness {
  const out: string[] = [];
  const saved: OwnerSession[] = [];
  const order: string[] = [];
  const pages: Array<{ status: number; html: string }> = [];
  let opened = "";
  let release: ((q: URLSearchParams) => void) | undefined;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("oauth-protected-resource")) return json({ resource: RESOURCE, authorization_servers: [AS] });
    if (u.includes("oauth-authorization-server")) {
      return json({
        issuer: AS,
        authorization_endpoint: `${AS}/oauth2/authorize`,
        token_endpoint: `${AS}/oauth2/token`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    order.push(`token:${new URLSearchParams(String(init?.body)).get("grant_type")}`);
    return opts.tokenResponse ?? json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 900 });
  }) as unknown as typeof fetch;

  const deps: OwnerLoginDeps = {
    write: (t) => out.push(t),
    fetchImpl,
    waitForCallback: () => {
      order.push("listen");
      return Promise.resolve({
        callback: new Promise((resolve) => {
          release = (q) =>
            resolve({
              query: q,
              respond: (page) => {
                order.push("respond");
                pages.push(page);
              },
            });
        }),
        close: () => order.push("close"),
      });
    },
    openBrowser: (url) => {
      order.push("open");
      opened = url;
      // The "browser" completes the redirect with the state the flow just minted.
      const state = new URL(url).searchParams.get("state") ?? "";
      setTimeout(() => release?.(new URLSearchParams({ code: "AUTHCODE", state })), 0);
      return Promise.resolve(true);
    },
    saveSession: (s) => {
      saved.push(s);
      return Promise.resolve();
    },
    hasAgentAccount: () => Promise.resolve(false),
    preference: () => Promise.resolve(undefined),
    clientId: "client_01ABC",
    resourceUrl: RESOURCE,
    headless: false,
    now: () => 1_000_000,
    ...overrides,
  };
  return { deps, out, saved, order, pages, authorizeUrl: () => opened };
}

describe("runOwnerLogin", () => {
  it("binds the listener BEFORE opening the browser, then saves the session", async () => {
    const h = harness();
    expect(await runOwnerLogin(h.deps)).toBe(0);
    expect(h.order.slice(0, 2)).toEqual(["listen", "open"]);
    expect(h.order).toContain("token:authorization_code");
    expect(h.saved).toEqual([
      {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: 1_000_000 + 900_000,
      },
    ]);
  });

  it("opens the FIXED loopback redirect the dashboard has to allow", async () => {
    const h = harness();
    await runOwnerLogin(h.deps);
    const url = new URL(h.authorizeUrl());
    expect(url.searchParams.get("redirect_uri")).toBe(OWNER_LOOPBACK_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("client_01ABC");
  });

  it("the browser page confirms success and carries NO token", async () => {
    const h = harness();
    await runOwnerLogin(h.deps);
    expect(h.pages).toHaveLength(1);
    const html = h.pages[0]?.html ?? "";
    expect(html).toMatch(/back to your terminal/i);
    // Whole-token comparisons: a substring check would pass on a truncated leak.
    expect(html).not.toContain(ACCESS);
    expect(html).not.toContain(REFRESH);
    expect(html).not.toContain("AUTHCODE");
  });

  it("nothing the operator sees on the terminal contains a token", async () => {
    const h = harness();
    await runOwnerLogin(h.deps);
    const printed = h.out.join("");
    expect(printed).not.toContain(ACCESS);
    expect(printed).not.toContain(REFRESH);
    expect(printed).not.toContain("AUTHCODE");
    expect(printed).toMatch(/signed in/i);
  });

  it("a mismatched state is rejected and no session is written", async () => {
    const h = harness({
      openBrowser: () => Promise.resolve(true),
      waitForCallback: () =>
        Promise.resolve({
          callback: Promise.resolve({
            query: new URLSearchParams({ code: "AUTHCODE", state: "NOT-THE-STATE" }),
            respond: () => {},
          }),
          close: () => {},
        }),
    });
    expect(await runOwnerLogin(h.deps)).toBe(1);
    expect(h.saved).toEqual([]);
    expect(h.out.join("")).toMatch(/state/i);
  });

  it("refuses on a headless machine and points at the sk_ path instead", async () => {
    const h = harness({ headless: true });
    expect(await runOwnerLogin(h.deps)).toBe(1);
    expect(h.order).not.toContain("listen");
    const msg = h.out.join("");
    expect(msg).toContain("127.0.0.1");
    expect(msg).toMatch(/DEPIX_API_KEY|register_account/);
  });

  it("a busy port fails BEFORE the browser opens — the code must not reach the squatter", async () => {
    // Proven live: with something else on 47617 the old flow printed "opening
    // your browser…", opened it, and only then reported EADDRINUSE — handing the
    // authorization code to whoever held the port. Binding must therefore
    // complete before the browser is ever launched.
    const h = harness({
      waitForCallback: () => Promise.reject(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" })),
    });
    expect(await runOwnerLogin(h.deps)).toBe(1);
    expect(h.order).not.toContain("open");
    expect(h.out.join("")).not.toMatch(/opening your browser/i);
    expect(h.out.join("")).toContain(String(OWNER_LOOPBACK_PORT));
    expect(h.out.join("")).toMatch(/already in use|already listening/i);
  });

  it("an abandoned flow closes the listener instead of leaving the port held", async () => {
    const h = harness({
      openBrowser: () => Promise.reject(new Error("spawn blew up")),
    });
    expect(await runOwnerLogin(h.deps)).toBe(1);
    expect(h.order).toContain("close");
  });

  it("prints the URL for the operator when the browser cannot be opened", async () => {
    // The flow keeps waiting either way — a failed `open` is not a failed login,
    // it just means the human pastes the URL themselves.
    let release: ((q: URLSearchParams) => void) | undefined;
    const h = harness({
      waitForCallback: () =>
        Promise.resolve({
          callback: new Promise((resolve) => {
            release = (q) => resolve({ query: q, respond: () => {} });
          }),
          close: () => {},
        }),
      openBrowser: (url) => {
        const state = new URL(url).searchParams.get("state") ?? "";
        setTimeout(() => release?.(new URLSearchParams({ code: "AUTHCODE", state })), 0);
        return Promise.resolve(false);
      },
    });
    expect(await runOwnerLogin(h.deps)).toBe(0);
    expect(h.out.join("")).toContain("/oauth2/authorize");
  });

  it("warns LOUDLY when an agent account already owns this server", async () => {
    const h = harness({ hasAgentAccount: () => Promise.resolve(true) });
    expect(await runOwnerLogin(h.deps)).toBe(0);
    const msg = h.out.join("");
    expect(msg).toMatch(/keeps acting as the agent/i);
    expect(msg).toContain("account use owner");
  });

  it("does not warn when the operator already selected the owner persona", async () => {
    const h = harness({
      hasAgentAccount: () => Promise.resolve(true),
      preference: () => Promise.resolve("owner"),
    });
    await runOwnerLogin(h.deps);
    expect(h.out.join("")).not.toMatch(/keeps acting as the agent/i);
  });

  it("a store that refuses to seal (no wallet) fails with the init pointer, not a stack trace", async () => {
    const h = harness({
      saveSession: () => Promise.reject(Object.assign(new Error("no wallet"), { code: "owner_session_locked" })),
    });
    expect(await runOwnerLogin(h.deps)).toBe(1);
    expect(h.out.join("")).toContain("init");
  });
});

describe("runOwnerLogout", () => {
  it("clears the session and says so", async () => {
    const out: string[] = [];
    let cleared = false;
    const code = await runOwnerLogout({
      write: (t) => out.push(t),
      clearSession: () => {
        cleared = true;
        return Promise.resolve(true);
      },
      preference: () => Promise.resolve(undefined),
      clearPreference: () => Promise.resolve(),
      hasAgentAccount: () => Promise.resolve(false),
    });
    expect(code).toBe(0);
    expect(cleared).toBe(true);
    expect(out.join("")).toMatch(/signed out/i);
  });

  it("an explicit `owner` selection is dropped and the fallback is announced", async () => {
    const out: string[] = [];
    let prefCleared = false;
    await runOwnerLogout({
      write: (t) => out.push(t),
      clearSession: () => Promise.resolve(true),
      preference: () => Promise.resolve("owner"),
      clearPreference: () => {
        prefCleared = true;
        return Promise.resolve();
      },
      hasAgentAccount: () => Promise.resolve(true),
    });
    expect(prefCleared).toBe(true);
    expect(out.join("")).toMatch(/agent/i);
  });

  it("logging out with nothing stored is not an error", async () => {
    const out: string[] = [];
    const code = await runOwnerLogout({
      write: (t) => out.push(t),
      clearSession: () => Promise.resolve(false),
      preference: () => Promise.resolve(undefined),
      clearPreference: () => Promise.resolve(),
      hasAgentAccount: () => Promise.resolve(false),
    });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/no owner login/i);
  });
});

describe("the session carries WHO signed in (R5)", () => {
  const idToken = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(
    JSON.stringify({ sub: "user_01", email: "dono@example.com", provider: "GoogleOAuth" }),
  ).toString("base64url")}.SIG`;

  function withIdToken(overrides: Partial<OwnerLoginDeps> = {}) {
    return harness(overrides, {
      tokenResponse: json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 900, id_token: idToken }),
    });
  }

  it("stores the email and provider even when --provider was not given", async () => {
    const h = withIdToken();
    expect(await runOwnerLogin(h.deps)).toBe(0);
    expect(h.saved[0]).toMatchObject({ email: "dono@example.com", provider: "GoogleOAuth" });
  });

  it("an explicit --provider wins over the claim", async () => {
    const h = withIdToken({ provider: "github" });
    await runOwnerLogin(h.deps);
    expect(h.saved[0]?.provider).toBe("github");
  });

  it("names the account on the terminal — and still prints no token", async () => {
    const h = withIdToken();
    await runOwnerLogin(h.deps);
    const printed = h.out.join("");
    expect(printed).toContain("dono@example.com");
    expect(printed).not.toContain(ACCESS);
    expect(printed).not.toContain(REFRESH);
    expect(printed).not.toContain(idToken);
  });

  it("a login with no id_token still succeeds, just without a label", async () => {
    const h = harness();
    expect(await runOwnerLogin(h.deps)).toBe(0);
    expect(h.saved[0]?.email).toBeUndefined();
    expect(h.out.join("")).toMatch(/signed in\./i);
  });
});
