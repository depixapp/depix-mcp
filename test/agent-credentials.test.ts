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

describe("activateKey (the post-registration test↔live switch)", () => {
  it("re-points the vault AND the in-session resolver at the live key — persisted for the next boot", async () => {
    const env = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const resolver = new CredentialResolver({ envKey: undefined });
    const deps = buildAgentToolDeps({ resolver, apiBase: "https://api.depixapp.com", getWallet: async () => null, vault: { env } });
    await deps.persistKeys({ testKey: "sk_test_A", liveKey: "sk_live_B", prefer: "test" });
    expect(resolver.resolve()).toBe("sk_test_A");

    const activation = await deps.activateKey("live");

    expect(activation).toEqual({ activeMode: "live", source: "store", envOverride: false });
    expect(resolver.resolve()).toBe("sk_live_B");
    const onDisk = await new AgentCredentialStore({ dataDir: dir, passphrase: PASS }).load();
    expect(onDisk?.active).toBe("live");
    expect(AgentCredentialStore.activeKey(onDisk!)).toBe("sk_live_B");
  });

  it("refuses live when the vault holds no live key, leaving the pointer untouched", async () => {
    const env = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const resolver = new CredentialResolver({ envKey: undefined });
    const deps = buildAgentToolDeps({ resolver, apiBase: "https://api.depixapp.com", getWallet: async () => null, vault: { env } });
    await deps.persistKeys({ testKey: "sk_test_A", prefer: "test" });

    await expect(deps.activateKey("live")).rejects.toMatchObject({ code: "live_key_missing" });
    expect(resolver.resolve()).toBe("sk_test_A");
    const onDisk = await new AgentCredentialStore({ dataDir: dir, passphrase: PASS }).load();
    expect(onDisk?.active).toBe("test");
  });

  it("with no vault at all it is agent_not_initialized — pointing at register_account", async () => {
    const env = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const resolver = new CredentialResolver({ envKey: undefined });
    const deps = buildAgentToolDeps({ resolver, apiBase: "https://api.depixapp.com", getWallet: async () => null, vault: { env } });
    await expect(deps.activateKey("live")).rejects.toMatchObject({ code: "agent_not_initialized" });
  });

  it("switches back to test, and reports an env key as the override it is", async () => {
    const env = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const resolver = new CredentialResolver({ envKey: undefined });
    const deps = buildAgentToolDeps({ resolver, apiBase: "https://api.depixapp.com", getWallet: async () => null, vault: { env } });
    await deps.persistKeys({ testKey: "sk_test_A", liveKey: "sk_live_B", prefer: "live" });
    expect(resolver.resolve()).toBe("sk_live_B");

    expect(await deps.activateKey("test")).toEqual({ activeMode: "test", source: "store", envOverride: false });
    expect(resolver.resolve()).toBe("sk_test_A");

    const shadowed = new CredentialResolver({ envKey: "sk_live_ENV" });
    const shadowedDeps = buildAgentToolDeps({ resolver: shadowed, apiBase: "https://api.depixapp.com", getWallet: async () => null, vault: { env } });
    expect(await shadowedDeps.activateKey("live")).toEqual({ activeMode: "live", source: "env", envOverride: true });
    expect(shadowed.resolve()).toBe("sk_live_ENV");
  });

  it("no vault AND an empty unlock chain is agent_not_initialized — never the locked relay", async () => {
    const deps = buildAgentToolDeps({
      resolver: new CredentialResolver({}),
      apiBase: "https://api.depixapp.com",
      getWallet: async () => null,
      vault: {
        env: { DEPIX_AGENT_DIR: dir, DEPIX_WALLET_DIR: dir } as NodeJS.ProcessEnv,
        unlock: {
          platform: "darwin",
          home: "/nonexistent",
          files: { read: () => Promise.resolve(undefined), write: () => Promise.resolve(), remove: () => Promise.resolve() },
          run: () => Promise.resolve({ code: 44, stdout: "", stderr: "" }),
        },
      },
    });
    await expect(deps.activateKey("live")).rejects.toMatchObject({ code: "agent_not_initialized" });
  });

  it("a vault this server cannot unlock is a typed credentials_locked, not an internal_error", async () => {
    // A vault exists (sealed with PASS), but the passphrase chain is EMPTY for
    // this process: no env passphrase, an empty keychain, no fallback file.
    const sealedEnv = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const seeded = buildAgentToolDeps({ resolver: new CredentialResolver({}), apiBase: "https://api.depixapp.com", getWallet: async () => null, vault: { env: sealedEnv } });
    await seeded.persistKeys({ testKey: "sk_test_A", liveKey: "sk_live_B", prefer: "test" });

    const lockedEnv = { DEPIX_AGENT_DIR: dir, DEPIX_WALLET_DIR: dir } as NodeJS.ProcessEnv;
    const deps = buildAgentToolDeps({
      resolver: new CredentialResolver({}),
      apiBase: "https://api.depixapp.com",
      getWallet: async () => null,
      vault: {
        env: lockedEnv,
        unlock: {
          platform: "darwin",
          home: "/nonexistent",
          files: { read: () => Promise.resolve(undefined), write: () => Promise.resolve(), remove: () => Promise.resolve() },
          run: () => Promise.resolve({ code: 44, stdout: "", stderr: "" }),
        },
      },
    });
    await expect(deps.activateKey("live")).rejects.toMatchObject({ code: "credentials_locked" });
  });
});

describe("replaceKey (the slot a freshly minted key lands in)", () => {
  const deps = (env: NodeJS.ProcessEnv, resolver: CredentialResolver) =>
    buildAgentToolDeps({ resolver, apiBase: "https://api.depixapp.com", getWallet: async () => null, vault: { env } });

  it("writes ONE slot — minting live must not erase the sandbox key, and vice versa", async () => {
    const env = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const d = deps(env, new CredentialResolver({ envKey: undefined }));
    await d.persistKeys({ testKey: "sk_test_A", liveKey: "sk_live_B", prefer: "test" });

    await d.replaceKey({ key: "sk_live_UPGRADED", mode: "live", activate: false });

    const store = new AgentCredentialStore({ dataDir: dir, passphrase: PASS });
    const after = await store.load();
    expect(after).toMatchObject({ testKey: "sk_test_A", liveKey: "sk_live_UPGRADED", active: "test" });
  });

  it("activate:false leaves the mode pointer where it was; activate:true moves it", async () => {
    const env = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const resolver = new CredentialResolver({ envKey: undefined });
    const d = deps(env, resolver);
    await d.persistKeys({ testKey: "sk_test_A", liveKey: "sk_live_B", prefer: "test" });

    expect((await d.replaceKey({ key: "sk_live_C", mode: "live", activate: false })).activeMode).toBe("test");
    expect(resolver.resolve()).toBe("sk_test_A");

    expect((await d.replaceKey({ key: "sk_live_D", mode: "live", activate: true })).activeMode).toBe("live");
    expect(resolver.resolve()).toBe("sk_live_D");
  });

  it("REFUSES to report success when the write did not land", async () => {
    const env = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const resolver = new CredentialResolver({ envKey: undefined });
    const d = deps(env, resolver);
    await d.persistKeys({ testKey: "sk_test_A", prefer: "test" });

    // A save that silently keeps the old contents — the exact shape the
    // read-back exists to catch. Without it, the upgrade would go on to revoke
    // the superseded key while the new one lives nowhere.
    const realSave = AgentCredentialStore.prototype.save;
    AgentCredentialStore.prototype.save = async function () {};
    try {
      await expect(d.replaceKey({ key: "sk_test_NEW", mode: "test", activate: true })).rejects.toThrow(
        /did not survive a write\+read verification/,
      );
    } finally {
      AgentCredentialStore.prototype.save = realSave;
    }
    // And the resolver is still on the key that IS on disk.
    expect(resolver.resolve()).toBe("sk_test_A");
  });

  it("keyState reads the live pointer without a write", async () => {
    const env = { DEPIX_AGENT_DIR: dir, DEPIX_AGENT_PASSPHRASE: PASS } as NodeJS.ProcessEnv;
    const d = deps(env, new CredentialResolver({ envKey: undefined }));
    await d.persistKeys({ testKey: "sk_test_A", liveKey: "sk_live_B", prefer: "live" });
    expect(await d.keyState()).toEqual({ active: "live", hasLive: true });

    await d.persistKeys({ testKey: "sk_test_A", prefer: "test" });
    expect(await d.keyState()).toEqual({ active: "test", hasLive: false });
  });
});
