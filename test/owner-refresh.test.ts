// SINGLE-FLIGHT on the owner-session refresh.
//
// The MCP serves tool calls concurrently. Without this, two calls that both hit
// a 401 each load the session, each read the SAME refresh token, and each POST
// it: WorkOS rotates on first use, so the second POST presents a token that is
// already spent — the loser's failure then kills a session that is perfectly
// alive. One renewal in flight at a time is the whole fix.

import { describe, expect, it } from "vitest";
import { createOwnerRefreshHook } from "../src/owner-refresh.js";
import type { OwnerSession } from "../src/wallet-engine/agent/owner-session-store.js";

interface Harness {
  hook: () => Promise<boolean>;
  presented: string[];
  saved: OwnerSession[];
  tokens: string[];
  discoveries: number;
}

function harness(
  overrides: {
    session?: OwnerSession | null;
    refresh?: (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }>;
    loadSession?: () => Promise<OwnerSession | null>;
  } = {},
): Harness {
  const presented: string[] = [];
  const saved: OwnerSession[] = [];
  const tokens: string[] = [];
  let discoveries = 0;
  let stored: OwnerSession | null =
    overrides.session === undefined
      ? { accessToken: "AT.1", refreshToken: "RT.1", expiresAt: 0 }
      : overrides.session;

  const hook = createOwnerRefreshHook({
    loadSession: overrides.loadSession ?? (() => Promise.resolve(stored)),
    saveSession: (s) => {
      saved.push(s);
      stored = s;
      return Promise.resolve();
    },
    tokenEndpoint: () => {
      discoveries++;
      return Promise.resolve("https://as.example/oauth2/token");
    },
    refresh: async ({ refreshToken }) => {
      presented.push(refreshToken);
      if (overrides.refresh) return overrides.refresh(refreshToken);
      // A rotating server: the old token is now spent.
      await new Promise((r) => setTimeout(r, 10));
      return { accessToken: `AT.${presented.length + 1}`, refreshToken: `RT.${presented.length + 1}`, expiresAt: 1 };
    },
    setToken: (t) => tokens.push(t),
  });

  return {
    hook,
    presented,
    saved,
    tokens,
    get discoveries() {
      return discoveries;
    },
  };
}

describe("createOwnerRefreshHook", () => {
  it("two concurrent 401s share ONE renewal — the refresh token is presented once", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.hook(), h.hook()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    // The bug this pins: ["RT.1", "RT.1"] — the same one-shot token, twice.
    expect(h.presented).toEqual(["RT.1"]);
    expect(h.saved).toHaveLength(1);
  });

  it("three concurrent callers all get the same result from the one renewal", async () => {
    const h = harness();
    const results = await Promise.all([h.hook(), h.hook(), h.hook()]);
    expect(results).toEqual([true, true, true]);
    expect(h.presented).toEqual(["RT.1"]);
  });

  it("a LATER 401 renews again — the gate is per flight, not once per process", async () => {
    const h = harness();
    await h.hook();
    await h.hook();
    expect(h.presented).toEqual(["RT.1", "RT.2"]);
    expect(h.tokens).toEqual(["AT.2", "AT.3"]);
  });

  it("persists the rotated refresh token before reporting success", async () => {
    const h = harness();
    await h.hook();
    expect(h.saved[0]).toMatchObject({ accessToken: "AT.2", refreshToken: "RT.2" });
    expect(h.tokens).toEqual(["AT.2"]);
  });

  it("a failed renewal rejects every concurrent caller, and the gate reopens", async () => {
    let calls = 0;
    const h = harness({
      refresh: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("invalid_grant");
      },
    });
    const results = await Promise.allSettled([h.hook(), h.hook()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toBe(1);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "owner_session_expired" });
    }
    // Not latched shut: a later call tries again rather than being poisoned.
    await expect(h.hook()).rejects.toMatchObject({ code: "owner_session_expired" });
    expect(calls).toBe(2);
  });

  it("no session, or one with no refresh token, is a typed expiry — never a silent false", async () => {
    await expect(harness({ session: null }).hook()).rejects.toMatchObject({ code: "owner_session_expired" });
    await expect(
      harness({ session: { accessToken: "AT", expiresAt: 0 } }).hook(),
    ).rejects.toMatchObject({ code: "owner_session_expired" });
  });

  it("an unreadable store is a typed expiry too, not a crash", async () => {
    const h = harness({ loadSession: () => Promise.reject(new Error("bad passphrase")) });
    await expect(h.hook()).rejects.toMatchObject({ code: "owner_session_expired" });
  });

  it("never leaks the refresh token into the error it throws", async () => {
    const h = harness({
      session: { accessToken: "AT", refreshToken: "RT.SECRET.VALUE", expiresAt: 0 },
      refresh: () => Promise.reject(new Error("nope")),
    });
    try {
      await h.hook();
      throw new Error("expected a rejection");
    } catch (err) {
      const dump = `${(err as Error).message} ${JSON.stringify((err as { data?: unknown }).data)}`;
      expect(dump).not.toContain("RT.SECRET.VALUE");
    }
  });

  it("discovers the token endpoint once, not once per 401", async () => {
    const h = harness();
    await h.hook();
    await h.hook();
    expect(h.discoveries).toBe(1);
  });
});
