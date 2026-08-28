// The agent's vaults must open the SAME way the wallet opens its seed.
//
// `init` never writes a passphrase into the MCP host config (by design, §3.7 #8):
// it puts an unlock key in the OS keychain (or a 0600 fallback file) and the
// wallet reads it there at boot. The agent's three sealed files — the Ed25519
// identity, the sk_ credentials `register_account` writes, and the owner session
// `login` seals — used to read the env AND NOTHING ELSE, so on the
// configuration `init` itself prints they were unopenable: the server booted
// announcing "no API key configured", and `register_account` answered
// agent_key_unreadable.
//
// Two properties are asserted here, and they are separate:
//   1. the chain — env, then the keychain, then the 0600 file;
//   2. LOCKED is not ABSENT — a vault that exists and will not open is reported
//      as locked, everywhere, instead of being reported as "nothing here".

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialResolver } from "../src/credentials.js";
import { ApiClient } from "../src/apiClient.js";
import { missingApiKeyError } from "../src/errors.js";
import { buildAgentToolDeps, seedResolverFromStore } from "../src/agent-deps.js";
import { buildAccountDeps, buildOwnerLoginDeps, seedOwnerSession } from "../src/owner-deps.js";
import { runAccountCommand, type AccountDeps } from "../src/account-command.js";
import { AgentCredentialStore } from "../src/wallet-engine/agent/credential-store.js";
import { OwnerSessionStore } from "../src/wallet-engine/agent/owner-session-store.js";
import { AgentKeyStore } from "../src/wallet-engine/agent/store.js";
import { generateAgentKeypair } from "../src/wallet-engine/agent/keypair.js";
import {
  UNLOCK_KEYCHAIN_SERVICE,
  fallbackFilePath,
  type CommandResult,
  type UnlockStoreDeps,
} from "../src/wallet-engine/store/unlock-store.js";

const KEYCHAIN_PASS = "keychain unlock key for the wallet";
const ENV_PASS = "an entirely different env passphrase";
const API_BASE = "https://api.depixapp.com";

const noKeychain = (): Promise<CommandResult> => Promise.resolve({ code: null, stdout: "", stderr: "" });
const noFiles = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

interface FakeUnlock {
  deps: Partial<UnlockStoreDeps>;
  /** How many times the keychain CLI was actually spawned. */
  reads: () => number;
}

/** A fake macOS Keychain holding one unlock key per wallet dir. */
function keychainHolding(entries: Record<string, string>): FakeUnlock {
  let reads = 0;
  return {
    reads: () => reads,
    deps: {
      platform: "darwin",
      home: "/nonexistent",
      files: noFiles,
      run: (command, args) => {
        reads += 1;
        if (command !== "security" || args[0] !== "find-generic-password") return noKeychain();
        const account = args[args.indexOf("-a") + 1] ?? "";
        const service = args[args.indexOf("-s") + 1] ?? "";
        const secret = service === UNLOCK_KEYCHAIN_SERVICE ? entries[account] : undefined;
        if (secret === undefined) return Promise.resolve({ code: 44, stdout: "", stderr: "" });
        return Promise.resolve({ code: 0, stdout: `${Buffer.from(secret, "utf8").toString("base64")}\n`, stderr: "" });
      },
    },
  };
}

/** A machine with NO keychain CLI, where `init` fell through to the 0600 file. */
function fallbackFileHolding(entries: Record<string, string>): FakeUnlock {
  const home = "/home/operator";
  const byPath = new Map(Object.entries(entries).map(([dir, secret]) => [fallbackFilePath(dir, home), secret]));
  let reads = 0;
  return {
    reads: () => reads,
    deps: {
      platform: "freebsd", // keychainCommand() returns null — no CLI to try
      home,
      run: () => {
        reads += 1;
        return noKeychain();
      },
      files: {
        ...noFiles,
        read: (path) => Promise.resolve(byPath.get(path)),
      },
    },
  };
}

/** Nothing anywhere: no env, no keychain entry, no fallback file. */
function emptyChain(): FakeUnlock {
  return keychainHolding({});
}

let agentDir: string;
let walletDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "depix-unlock-agent-"));
  walletDir = await mkdtemp(join(tmpdir(), "depix-unlock-wallet-"));
  process.env.DEPIX_AGENT_DIR = agentDir;
  process.env.DEPIX_WALLET_DIR = walletDir;
  delete process.env.DEPIX_AGENT_PASSPHRASE;
  delete process.env.DEPIX_WALLET_PASSPHRASE;
  delete process.env.DEPIX_API_KEY;
});

afterEach(async () => {
  delete process.env.DEPIX_AGENT_DIR;
  delete process.env.DEPIX_WALLET_DIR;
  delete process.env.DEPIX_AGENT_PASSPHRASE;
  delete process.env.DEPIX_WALLET_PASSPHRASE;
  delete process.env.DEPIX_API_KEY;
  await rm(agentDir, { recursive: true, force: true });
  await rm(walletDir, { recursive: true, force: true });
});

function sealOwnerSession(passphrase: string): Promise<void> {
  return new OwnerSessionStore({ dataDir: agentDir, passphrase }).save({
    accessToken: "owner_access_token",
    refreshToken: "owner_refresh_token",
    expiresAt: Date.now() + 3_600_000,
    provider: "google",
    email: "dono@example.com",
  });
}

describe("the owner session opens through the wallet's unlock chain (§3.7 #8)", () => {
  it("boot opens a session sealed with the KEYCHAIN's unlock key, with no passphrase in the env", async () => {
    await sealOwnerSession(KEYCHAIN_PASS);
    const unlock = keychainHolding({ [walletDir]: KEYCHAIN_PASS });

    const resolver = new CredentialResolver({});
    const state = await seedOwnerSession(resolver, { unlock: unlock.deps });

    expect(state).toBe("active");
    expect(resolver.resolveCredential()).toEqual({ token: "owner_access_token", kind: "oauth" });
  });

  it("falls through to the 0600 file on a machine with no keychain CLI", async () => {
    await sealOwnerSession(KEYCHAIN_PASS);
    const unlock = fallbackFileHolding({ [walletDir]: KEYCHAIN_PASS });

    const resolver = new CredentialResolver({});
    expect(await seedOwnerSession(resolver, { unlock: unlock.deps })).toBe("active");
    expect(resolver.hasOwnerSession()).toBe(true);
  });

  it("the env still WINS: the keychain is not even consulted", async () => {
    process.env.DEPIX_WALLET_PASSPHRASE = ENV_PASS;
    await sealOwnerSession(ENV_PASS);
    // The keychain holds a passphrase that would NOT open this session.
    const unlock = keychainHolding({ [walletDir]: KEYCHAIN_PASS });

    const resolver = new CredentialResolver({});
    expect(await seedOwnerSession(resolver, { unlock: unlock.deps })).toBe("active");
    expect(unlock.reads()).toBe(0);
  });

  it("DEPIX_AGENT_PASSPHRASE still outranks DEPIX_WALLET_PASSPHRASE", async () => {
    process.env.DEPIX_AGENT_PASSPHRASE = ENV_PASS;
    process.env.DEPIX_WALLET_PASSPHRASE = "the wrong one for this vault";
    await sealOwnerSession(ENV_PASS);

    const resolver = new CredentialResolver({});
    expect(await seedOwnerSession(resolver, { unlock: emptyChain().deps })).toBe("active");
  });
});

describe("a vault that exists and will not open is LOCKED, never absent", () => {
  it("boot reports `locked` when the whole chain is empty", async () => {
    await sealOwnerSession(KEYCHAIN_PASS);

    const resolver = new CredentialResolver({});
    const state = await seedOwnerSession(resolver, { unlock: emptyChain().deps });

    expect(state).toBe("locked");
    expect(resolver.hasOwnerSession()).toBe(false);
  });

  it("boot reports `locked` when the chain answers with the WRONG passphrase", async () => {
    await sealOwnerSession(KEYCHAIN_PASS);
    const unlock = keychainHolding({ [walletDir]: "a stale unlock key from another wallet" });

    expect(await seedOwnerSession(new CredentialResolver({}), { unlock: unlock.deps })).toBe("locked");
  });

  it("boot reports `none` — not `locked` — on a machine with no session file at all", async () => {
    expect(await seedOwnerSession(new CredentialResolver({}), { unlock: emptyChain().deps })).toBe("none");
  });

  it("the same holds for the agent's sk_ vault", async () => {
    await new AgentCredentialStore({ dataDir: agentDir, passphrase: KEYCHAIN_PASS }).save({
      testKey: "sk_test_STORED",
      active: "test",
    });

    expect(await seedResolverFromStore(new CredentialResolver({}), { unlock: emptyChain().deps })).toBe("locked");
    const resolver = new CredentialResolver({});
    expect(
      await seedResolverFromStore(resolver, { unlock: keychainHolding({ [walletDir]: KEYCHAIN_PASS }).deps }),
    ).toBe("active");
    expect(resolver.resolve()).toBe("sk_test_STORED");
  });

  it("the gateway credential error names the locked vault instead of asking for a key", () => {
    const err = missingApiKeyError(undefined, "local", { ownerSession: true });

    expect(err.code).toBe("credentials_locked");
    expect(err.message).toMatch(/owner/i);
    expect(err.message).toMatch(/could not unlock|unlock/i);
    // The old sentence sent the operator to configure a credential they already have.
    expect(err.message).not.toMatch(/No DePix App API key is configured/);
    expect((err.data.next_action as { kind?: string } | undefined)?.kind).toBe("human_step");
  });

  it("with nothing locked, the credential error is unchanged", () => {
    expect(missingApiKeyError(undefined, "local").code).toBe("missing_api_key");
    expect(missingApiKeyError(undefined, "local", {}).code).toBe("missing_api_key");
  });

  it("the ApiClient raises it before any request — the boot's verdict reaches the tools", async () => {
    const client = new ApiClient({
      apiKey: undefined,
      apiBase: "https://api.depixapp.com",
      deployment: "local",
      lockedCredentials: { agentCredentials: true },
      fetchImpl: () => Promise.reject(new Error("no request may leave without a credential")),
    });

    await expect(client.request({ tool: "get_account", method: "GET", path: "/api/me" })).rejects.toMatchObject({
      code: "credentials_locked",
    });
  });
});

describe("register_account on a machine whose passphrase lives only in the keychain", () => {
  it("opens the agent identity `init`'s unlock key seals — today it answers agent_key_unreadable", async () => {
    const keypair = generateAgentKeypair();
    await new AgentKeyStore({ dataDir: agentDir, passphrase: KEYCHAIN_PASS }).save(keypair, {});

    const deps = buildAgentToolDeps({
      resolver: new CredentialResolver({}),
      apiBase: API_BASE,
      getWallet: () => Promise.resolve(null),
      vault: { unlock: keychainHolding({ [walletDir]: KEYCHAIN_PASS }).deps },
    });

    const agent = await deps.openAgent();
    expect(agent?.publicKeyHex).toBe(keypair.publicKeyHex);
  });

  it("seals the minted sk_ keys and serves them on the next boot", async () => {
    const unlock = keychainHolding({ [walletDir]: KEYCHAIN_PASS });
    const resolver = new CredentialResolver({});
    const deps = buildAgentToolDeps({
      resolver,
      apiBase: API_BASE,
      getWallet: () => Promise.resolve(null),
      vault: { unlock: unlock.deps },
    });

    const activation = await deps.persistKeys({ testKey: "sk_test_MINTED", prefer: "test" });
    expect(activation.source).toBe("store");
    expect(resolver.resolve()).toBe("sk_test_MINTED");

    // The restart: a fresh resolver reads it back through the same chain.
    const rebooted = new CredentialResolver({});
    expect(await seedResolverFromStore(rebooted, { unlock: unlock.deps })).toBe("active");
    expect(rebooted.resolve()).toBe("sk_test_MINTED");
  });

  it("still refuses to seal when the whole chain is empty, and says where it looked", async () => {
    const deps = buildAgentToolDeps({
      resolver: new CredentialResolver({}),
      apiBase: API_BASE,
      getWallet: () => Promise.resolve(null),
      vault: { unlock: emptyChain().deps },
    });

    await expect(deps.persistKeys({ testKey: "sk_test_X", prefer: "test" })).rejects.toThrow(/keychain/i);
  });
});

describe("`login` seals its session through the DEFAULT chain, with no injection", () => {
  // No fake backends here on purpose: this walks the same code the shipped bin
  // walks, so a chain wired only through the test seam would not pass.
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), "depix-unlock-home-"));
    process.env.HOME = home; // os.homedir() reads it — this is where the 0600 key lives
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it("seals and reopens a session whose passphrase is only in the 0600 fallback file", async () => {
    // What `init` leaves behind on a machine with no OS keychain.
    const { storeUnlockKey } = await import("../src/wallet-engine/store/unlock-store.js");
    expect((await storeUnlockKey(walletDir, KEYCHAIN_PASS, { platform: "freebsd", home })).backend).toBe("file");

    await buildOwnerLoginDeps({ write: () => {} }).saveSession({
      accessToken: "owner_access_token",
      expiresAt: Date.now() + 3_600_000,
      provider: "github",
    });

    const resolver = new CredentialResolver({});
    expect(await seedOwnerSession(resolver)).toBe("active");
    expect(resolver.resolve()).toBe("owner_access_token");
  });
});

describe("`account status` on a locked machine", () => {
  function harness(overrides: Partial<AccountDeps> = {}) {
    const out: string[] = [];
    const deps: AccountDeps = {
      write: (t) => out.push(t),
      envKeyPresent: false,
      hasAgentAccount: () => Promise.resolve(false),
      ownerSession: () => Promise.resolve(null),
      preference: () => Promise.resolve(undefined),
      setPreference: () => Promise.resolve(),
      clearPreference: () => Promise.resolve(),
      ...overrides,
    };
    return { deps, text: () => out.join("") };
  }

  it("says the agent vault is locked instead of a clean `registered on this machine`", async () => {
    const h = harness({
      hasAgentAccount: () => Promise.resolve(true),
      agentAccountLocked: () => Promise.resolve(true),
    });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toMatch(/agent account:.*LOCKED/);
  });

  it("names the keychain, not only the env vars, as the door to a locked owner login", async () => {
    const h = harness({ ownerSession: () => Promise.resolve({ present: true, locked: true }) });
    await runAccountCommand(["status"], h.deps);
    expect(h.text()).toMatch(/owner login:.*LOCKED/);
    expect(h.text()).toMatch(/init/);
  });

  it("the real deps report both vaults as locked when the chain is empty", async () => {
    await sealOwnerSession(KEYCHAIN_PASS);
    await new AgentCredentialStore({ dataDir: agentDir, passphrase: KEYCHAIN_PASS }).save({
      testKey: "sk_test_STORED",
      active: "test",
    });

    const out: string[] = [];
    const deps = buildAccountDeps((t) => out.push(t), { unlock: emptyChain().deps });
    await runAccountCommand(["status"], deps);

    const text = out.join("");
    expect(text).toMatch(/agent account:.*LOCKED/);
    expect(text).toMatch(/owner login:.*LOCKED/);
    expect(text).not.toMatch(/no credentials/i);
  });

  it("with the keychain in place the same machine reports neither as locked", async () => {
    await sealOwnerSession(KEYCHAIN_PASS);
    const out: string[] = [];
    const deps = buildAccountDeps((t) => out.push(t), {
      unlock: keychainHolding({ [walletDir]: KEYCHAIN_PASS }).deps,
    });
    await runAccountCommand(["status"], deps);

    expect(out.join("")).toContain("dono@example.com");
    expect(out.join("")).not.toMatch(/LOCKED/);
  });
});
