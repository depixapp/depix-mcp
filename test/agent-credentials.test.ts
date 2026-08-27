// The encrypted credential store + the hot-swap wiring (§3.1, smoke S3.2/S3.3):
//   - the sk_ keys are sealed at rest — agent-credentials.json is unreadable
//     without the passphrase, and the wrong passphrase fails the GCM tag;
//   - the default deps persist + activate so the SAME session's resolver serves
//     the new key at once (no restart), and the env key still wins when set.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCredentialStore } from "../src/wallet-engine/agent/credential-store.js";
import { CredentialResolver } from "../src/credentials.js";
import { buildAgentToolDeps } from "../src/agent-deps.js";

const PASS = "correct horse battery staple";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "depix-cred-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AgentCredentialStore (§9.2)", () => {
  it("round-trips the keys and marks the active one", async () => {
    const store = new AgentCredentialStore({ dataDir: dir, passphrase: PASS });
    await store.save({ testKey: "sk_test_A", liveKey: "sk_live_B", active: "test" });
    const loaded = await store.load();
    expect(loaded).toEqual({ testKey: "sk_test_A", liveKey: "sk_live_B", active: "test" });
    expect(AgentCredentialStore.activeKey(loaded!)).toBe("sk_test_A");
  });

  it("is UNREADABLE without the passphrase — the file holds no plaintext key", async () => {
    const store = new AgentCredentialStore({ dataDir: dir, passphrase: PASS });
    await store.save({ testKey: "sk_test_SECRET", active: "test" });
    const raw = await readFile(join(dir, "agent-credentials.json"), "utf8");
    expect(raw).not.toContain("sk_test_SECRET");

    const wrong = new AgentCredentialStore({ dataDir: dir, passphrase: "another passphrase entirely" });
    await expect(wrong.load()).rejects.toMatchObject({ code: "agent_key_unreadable" });
  });

  it("live mode resolves the live key", async () => {
    const store = new AgentCredentialStore({ dataDir: dir, passphrase: PASS });
    await store.save({ testKey: "sk_test_A", liveKey: "sk_live_B", active: "live" });
    expect(AgentCredentialStore.activeKey((await store.load())!)).toBe("sk_live_B");
  });
});

describe("hot-swap via the default deps (§3.1 — S3.2/S3.3)", () => {
  const env = { DEPIX_AGENT_DIR: "", DEPIX_WALLET_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
  beforeEach(() => {
    env.DEPIX_AGENT_DIR = dir;
    process.env.DEPIX_AGENT_DIR = dir;
    process.env.DEPIX_WALLET_PASSPHRASE = PASS;
    delete process.env.DEPIX_AGENT_PASSPHRASE;
    delete process.env.DEPIX_API_KEY;
  });
  afterEach(() => {
    delete process.env.DEPIX_AGENT_DIR;
    delete process.env.DEPIX_WALLET_PASSPHRASE;
  });

  it("persistKeys writes the store AND activates the resolver in-session (no restart)", async () => {
    const resolver = new CredentialResolver({ envKey: undefined });
    const deps = buildAgentToolDeps({ resolver, apiBase: "https://api.depixapp.com", getWallet: async () => null });
    expect(resolver.resolve()).toBeUndefined();

    const activation = await deps.persistKeys({ testKey: "sk_test_NEW", liveKey: "sk_live_NEW", prefer: "test" });
    // Same session: the resolver now serves the freshly-minted key.
    expect(resolver.resolve()).toBe("sk_test_NEW");
    expect(activation).toEqual({ activeMode: "test", source: "store", envOverride: false });

    // And it survives a "restart": a new resolver seeded from the store.
    const store = new AgentCredentialStore({ dataDir: dir, passphrase: PASS });
    expect(AgentCredentialStore.activeKey((await store.load())!)).toBe("sk_test_NEW");
  });

  it("an env key WINS and is reported as an override", async () => {
    process.env.DEPIX_API_KEY = "sk_test_ENV";
    const resolver = new CredentialResolver({ envKey: "sk_test_ENV" });
    const deps = buildAgentToolDeps({ resolver, apiBase: "https://api.depixapp.com", getWallet: async () => null });
    const activation = await deps.persistKeys({ testKey: "sk_test_NEW", prefer: "test" });
    expect(activation.envOverride).toBe(true);
    expect(activation.source).toBe("env");
    // The env key still governs actual requests.
    expect(resolver.resolve()).toBe("sk_test_ENV");
  });
});
