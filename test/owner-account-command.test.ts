// `depix-mcp account status` / `account use <persona>` — switching identity is
// an OPERATOR act at a terminal, never an MCP tool: a prompt-injected agent must
// not be able to promote itself to the owner's login.
//
// `status` prints ids and labels only. It must never print a token, and it must
// always say WHY the active persona is active.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runAccountCommand, type AccountDeps } from "../src/account-command.js";
import { readAccountPreference, writeAccountPreference, clearAccountPreference } from "../src/account-preference.js";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function harness(overrides: Partial<AccountDeps> = {}) {
  const out: string[] = [];
  const writes: Array<string | null> = [];
  const deps: AccountDeps = {
    write: (t) => out.push(t),
    envKeyPresent: false,
    hasAgentAccount: () => Promise.resolve(false),
    ownerSession: () => Promise.resolve(null),
    preference: () => Promise.resolve(undefined),
    setPreference: (p) => {
      writes.push(p);
      return Promise.resolve();
    },
    clearPreference: () => {
      writes.push(null);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, out, writes, text: () => out.join("") };
}

describe("account status", () => {
  it("with nothing configured, it says so and points at both doors", async () => {
    const h = harness();
    expect(await runAccountCommand(["status"], h.deps)).toBe(0);
    expect(h.text()).toMatch(/no credentials/i);
    expect(h.text()).toContain("login");
    expect(h.text()).toContain("register_account");
  });

  it("names the agent account as active, and gives the reason", async () => {
    const h = harness({ hasAgentAccount: () => Promise.resolve(true) });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toMatch(/active:\s*agent/i);
    expect(h.text()).toMatch(/default/i);
  });

  it("names the owner session with its label — never a token", async () => {
    const h = harness({
      ownerSession: () =>
        Promise.resolve({ present: true, provider: "google", email: "dono@example.com", expiresAt: 4_000_000_000_000 }),
    });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toMatch(/active:\s*owner/i);
    expect(h.text()).toContain("dono@example.com");
    expect(h.text()).toContain("google");
  });

  it("an explicit selection is reported as the reason, over the default", async () => {
    const h = harness({
      hasAgentAccount: () => Promise.resolve(true),
      ownerSession: () => Promise.resolve({ present: true, provider: "github" }),
      preference: () => Promise.resolve("owner"),
    });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toMatch(/active:\s*owner/i);
    expect(h.text()).toMatch(/account use/i);
  });

  it("DEPIX_API_KEY is reported as the override that beats both", async () => {
    const h = harness({
      envKeyPresent: true,
      hasAgentAccount: () => Promise.resolve(true),
      ownerSession: () => Promise.resolve({ present: true }),
      preference: () => Promise.resolve("owner"),
    });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toContain("DEPIX_API_KEY");
    expect(h.text()).toMatch(/overrid/i);
  });

  it("a locked session (no passphrase) is visible but not decrypted", async () => {
    const h = harness({ ownerSession: () => Promise.resolve({ present: true, locked: true }) });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toMatch(/locked/i);
    expect(h.text()).toContain("DEPIX_WALLET_PASSPHRASE");
  });

  it("a stale selection whose persona is gone is called out, not silently ignored", async () => {
    const h = harness({
      hasAgentAccount: () => Promise.resolve(true),
      ownerSession: () => Promise.resolve(null),
      preference: () => Promise.resolve("owner"),
    });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toMatch(/active:\s*agent/i);
    expect(h.text()).toMatch(/no owner login/i);
  });
});

describe("account use", () => {
  it("selects the owner persona when a session exists", async () => {
    const h = harness({ ownerSession: () => Promise.resolve({ present: true, provider: "google" }) });
    expect(await runAccountCommand(["use", "owner"], h.deps)).toBe(0);
    expect(h.writes).toEqual(["owner"]);
    expect(h.text()).toMatch(/active:\s*owner/i);
  });

  it("refuses `use owner` without a session and points at login", async () => {
    const h = harness({ hasAgentAccount: () => Promise.resolve(true) });
    expect(await runAccountCommand(["use", "owner"], h.deps)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.text()).toContain("login");
  });

  it("refuses `use agent` without a registered account and points at register_account", async () => {
    const h = harness({ ownerSession: () => Promise.resolve({ present: true }) });
    expect(await runAccountCommand(["use", "agent"], h.deps)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.text()).toContain("register_account");
  });

  it("selects the agent persona when an account exists", async () => {
    const h = harness({
      hasAgentAccount: () => Promise.resolve(true),
      ownerSession: () => Promise.resolve({ present: true }),
    });
    expect(await runAccountCommand(["use", "agent"], h.deps)).toBe(0);
    expect(h.writes).toEqual(["agent"]);
  });

  it("warns that DEPIX_API_KEY still wins after a selection", async () => {
    const h = harness({
      envKeyPresent: true,
      hasAgentAccount: () => Promise.resolve(true),
    });
    await runAccountCommand(["use", "agent"], h.deps);
    expect(h.text()).toContain("DEPIX_API_KEY");
  });

  it("rejects an unknown persona instead of writing it", async () => {
    const h = harness();
    expect(await runAccountCommand(["use", "root"], h.deps)).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("rejects an unknown subcommand", async () => {
    const h = harness();
    expect(await runAccountCommand(["switch"], h.deps)).toBe(1);
    expect(await runAccountCommand([], h.deps)).toBe(1);
  });
});

describe("the preference file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "depix-pref-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips, and a cleared preference reads back as none", async () => {
    expect(await readAccountPreference(dir)).toBeUndefined();
    await writeAccountPreference(dir, "owner");
    expect(await readAccountPreference(dir)).toBe("owner");
    await writeAccountPreference(dir, "agent");
    expect(await readAccountPreference(dir)).toBe("agent");
    await clearAccountPreference(dir);
    expect(await readAccountPreference(dir)).toBeUndefined();
  });

  it("is a preference, not a secret: the file holds no token-shaped value", async () => {
    await writeAccountPreference(dir, "owner");
    const raw = await readFile(join(dir, "account-preference.json"), "utf8");
    expect(raw).not.toMatch(/sk_|eyJ/);
    expect(JSON.parse(raw)).toMatchObject({ persona: "owner" });
  });

  it("a corrupt or unknown persona reads as no selection, never as a crash", async () => {
    await writeFile(join(dir, "account-preference.json"), "{not json");
    expect(await readAccountPreference(dir)).toBeUndefined();
    await writeFile(join(dir, "account-preference.json"), JSON.stringify({ persona: "root" }));
    expect(await readAccountPreference(dir)).toBeUndefined();
  });

  it("clearing a preference that was never written is a no-op", async () => {
    await expect(clearAccountPreference(dir)).resolves.toBeUndefined();
  });
});


describe("account status with only DEPIX_API_KEY (N1)", () => {
  it("never prints `active: agent` above `agent account: none`", async () => {
    const h = harness({ envKeyPresent: true });
    await runAccountCommand(["status"], h.deps);
    const text = h.text();
    // The contradiction the label fixes: a real credential, named after an
    // account this machine has no record of.
    expect(text).not.toMatch(/active:\s*agent\b/);
    expect(text).toMatch(/active:\s*the DEPIX_API_KEY account/);
    expect(text).toContain("agent account: none");
  });

  it("still says `agent` when a real agent account is what won", async () => {
    const h = harness({ hasAgentAccount: () => Promise.resolve(true) });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toMatch(/active:\s*agent\b/);
  });
});
