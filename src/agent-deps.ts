// The DEFAULT wiring of the agent-local tools to the real DepixAgent + the
// encrypted credential store (§3.1). Kept out of stdio.ts so the bin stays a thin
// composition root and this stays unit-testable. Everything that pulls the wallet
// engine (DepixAgent, AgentCredentialStore, argon2) is imported LAZILY, inside the
// handlers, so a gateway-only `npx @depixapp/mcp` boot never pays for it.

import { homedir } from "node:os";
import { join } from "node:path";
import { agentNotInitialized, type AgentToolDeps, type AgentWalletLike, type KeyActivation } from "./agent-tools.js";
import { ToolError } from "./wallet-engine/mcp/errors.js";
import { withNextAction } from "./next-action.js";
import type { CredentialResolver } from "./credentials.js";
import type { UnlockStoreDeps } from "./wallet-engine/store/unlock-store.js";
import type { ActiveKeyMode } from "./wallet-engine/agent/credential-store.js";

/** Mirrors DepixAgent.resolveDataDir — the agent identity + credentials live here. */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEPIX_AGENT_DIR ?? join(homedir(), ".depix-agent");
}

/**
 * What the boot found in one sealed vault on this machine.
 *   active  — it opened, and the credential inside is in use;
 *   locked  — the file is THERE and did not open (see resolveAgentPassphrase);
 *   none    — no such file on this machine;
 *   skipped — DEPIX_API_KEY already decides, so nothing was opened.
 */
export type VaultState = "active" | "locked" | "none" | "skipped";

export interface AgentVaultOptions {
  /** Environment the passphrase and the two dirs are read from. */
  env?: NodeJS.ProcessEnv;
  /** Keychain/file backends behind the unlock key. Injected by tests only. */
  unlock?: Partial<UnlockStoreDeps>;
}

/** An env var that actually carries a value — "" and unset are the same fact. */
const set = (value: string | undefined): string | undefined => (value ? value : undefined);

/**
 * The passphrase that seals the agent's three vaults — the Ed25519 identity, the
 * sk_ credentials and the owner session — resolved through the SAME chain the
 * wallet resolves its seed with (wallet.ts resolveUnlockPassphrase, §3.7 #8):
 *
 *   DEPIX_AGENT_PASSPHRASE > DEPIX_WALLET_PASSPHRASE > the unlock key `init`
 *   put in the OS keychain (or, on a machine without one, its 0600 file).
 *
 * The env comes first because an operator who pins a passphrase means it. The
 * keychain has to be there at all because `init` deliberately writes NO
 * passphrase into the host config: on the configuration it prints, the env is
 * empty and the keychain is the only place the key exists.
 *
 * The unlock key is filed under the WALLET dir — that is the account `init`
 * stores it against — never the agent dir.
 */
export async function resolveAgentPassphrase(opts: AgentVaultOptions = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  // An empty var is NOT a pinned passphrase — it is a host config carrying a
  // placeholder. It seals nothing and opens nothing, so letting it win would
  // shut the very door below. Same reading CredentialResolver gives DEPIX_API_KEY.
  const fromEnv = set(env.DEPIX_AGENT_PASSPHRASE) ?? set(env.DEPIX_WALLET_PASSPHRASE);
  if (fromEnv !== undefined) return fromEnv;
  // Lazy, like every other engine import here: a gateway-only boot that finds a
  // passphrase in its env never loads the unlock store at all.
  const [{ readUnlockKey }, { resolveWalletDir }] = await Promise.all([
    import("./wallet-engine/store/unlock-store.js"),
    import("./unified.js"),
  ]);
  return readUnlockKey(resolveWalletDir(env), opts.unlock);
}

/** Every door the passphrase could have come through — named in the errors. */
const CHAIN_DESCRIPTION =
  "not in DEPIX_AGENT_PASSPHRASE or DEPIX_WALLET_PASSPHRASE, and no unlock key for this wallet in this machine's " +
  "keychain (which is where `npx -y @depixapp/mcp init` puts it)";

export interface BuildAgentToolDepsOptions {
  resolver: CredentialResolver;
  apiBase: string;
  /** The wallet resolver (for the payout address). */
  getWallet: () => Promise<AgentWalletLike | null>;
  /** Passphrase-chain overrides (tests). */
  vault?: AgentVaultOptions;
}

export function buildAgentToolDeps(opts: BuildAgentToolDepsOptions): AgentToolDeps {
  const { resolver, apiBase, getWallet, vault } = opts;
  const agentOptions = async () => {
    const passphrase = await resolveAgentPassphrase(vault);
    return {
      apiBase,
      dataDir: resolveAgentDir(vault?.env),
      ...(passphrase !== undefined ? { passphrase } : {}),
    };
  };

  // The two vault mutators run one at a time: activate_key is load→save, and
  // a register_account landing between the two would be written back over
  // with the keys it had just replaced.
  let vaultOp: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = vaultOp.then(fn, fn);
    vaultOp = next.catch(() => undefined);
    return next;
  };

  return {
    getWallet,
    openAgent: async () => {
      const { DepixAgent } = await import("./wallet-engine/agent.js");
      try {
        return await DepixAgent.open(await agentOptions());
      } catch (err) {
        // No identity yet → null so register_account creates one. Every other
        // failure (bad passphrase, corrupt store) rethrows.
        if ((err as { code?: string } | undefined)?.code === "agent_not_initialized") return null;
        throw err;
      }
    },
    createAgent: async () => {
      const { DepixAgent } = await import("./wallet-engine/agent.js");
      return DepixAgent.create(await agentOptions());
    },
    persistKeys: ({ testKey, liveKey, prefer }): Promise<KeyActivation> => serial(async () => {
      const passphrase = await resolveAgentPassphrase(vault);
      if (passphrase === undefined) {
        throw new Error(`No passphrase to seal the API credentials: ${CHAIN_DESCRIPTION}.`);
      }
      const { AgentCredentialStore } = await import("./wallet-engine/agent/credential-store.js");
      const store = new AgentCredentialStore({ dataDir: resolveAgentDir(vault?.env), passphrase });
      await store.save({ testKey, ...(liveKey ? { liveKey } : {}), active: prefer });
      // Verify durability BEFORE the caller reports success (§3.1): read it back.
      const readBack = await store.load();
      if (!readBack || readBack.testKey !== testKey) {
        throw new Error("The API credentials did not survive a write+read verification.");
      }
      // Activate in-session so the very next gateway request uses the new key —
      // unless an env key is overriding it, in which case env still wins.
      resolver.setActiveKey(AgentCredentialStore.activeKey(readBack));
      const source = resolver.source();
      return {
        activeMode: prefer,
        // "none" cannot happen — a key was just activated — but the resolver's
        // type allows it, and mapping it to "store" is the honest fallback.
        source: source === "none" ? "store" : source,
        envOverride: resolver.hasEnvOverride(),
      };
    }),
    keyState: (): Promise<{ active: ActiveKeyMode; hasLive: boolean }> => serial(async () => {
      if (!(await agentCredentialsExist(vault?.env))) throw agentNotInitialized();
      const passphrase = await resolveAgentPassphrase(vault);
      if (passphrase === undefined) throw credentialsLocked();
      const { AgentCredentialStore } = await import("./wallet-engine/agent/credential-store.js");
      const store = new AgentCredentialStore({ dataDir: resolveAgentDir(vault?.env), passphrase });
      const current = await store.load();
      if (!current) throw agentNotInitialized();
      return { active: current.active, hasLive: !!current.liveKey };
    }),
    replaceKey: ({ key, mode, activate }): Promise<KeyActivation> => serial(async () => {
      if (!(await agentCredentialsExist(vault?.env))) throw agentNotInitialized();
      const passphrase = await resolveAgentPassphrase(vault);
      if (passphrase === undefined) throw credentialsLocked();
      const { AgentCredentialStore } = await import("./wallet-engine/agent/credential-store.js");
      const store = new AgentCredentialStore({ dataDir: resolveAgentDir(vault?.env), passphrase });
      const current = await store.load();
      if (!current) throw agentNotInitialized();
      // One slot only: minting a live key must not erase the sandbox key the
      // operator can fall back to, and vice versa.
      const next = {
        ...current,
        ...(mode === "live" ? { liveKey: key } : { testKey: key }),
        active: activate ? mode : current.active,
      };
      await store.save(next);
      // Same write+read-back discipline as persistKeys: the vault is what the
      // next boot reads, so it must be on disk before this reports success.
      const readBack = await store.load();
      if (!readBack || (mode === "live" ? readBack.liveKey : readBack.testKey) !== key) {
        throw new Error("The minted key did not survive a write+read verification.");
      }
      resolver.setActiveKey(AgentCredentialStore.activeKey(readBack));
      const source = resolver.source();
      return {
        activeMode: readBack.active,
        source: source === "none" ? "store" : source,
        envOverride: resolver.hasEnvOverride(),
      };
    }),
    activateKey: (mode): Promise<KeyActivation> => serial(async () => {
      // Existence before unlock: on a machine with no vault at all the locked
      // relay would tell the agent "the account already here is the right one".
      if (!(await agentCredentialsExist(vault?.env))) throw agentNotInitialized();
      const passphrase = await resolveAgentPassphrase(vault);
      if (passphrase === undefined) {
        throw credentialsLocked();
      }
      const { AgentCredentialStore } = await import("./wallet-engine/agent/credential-store.js");
      const store = new AgentCredentialStore({ dataDir: resolveAgentDir(vault?.env), passphrase });
      const current = await store.load();
      if (!current) throw agentNotInitialized();
      if (mode === "live" && !current.liveKey) {
        throw new ToolError(
          "This account's local vault holds no live key (registration normally issues a starter one). " +
            "Keep using the sandbox key, or register a new account.",
          "live_key_missing",
        );
      }
      // Same write+read-back discipline as persistKeys: the pointer is what the
      // next boot reads, so it must be on disk before this reports success.
      await store.save({ ...current, active: mode });
      const readBack = await store.load();
      if (!readBack || readBack.active !== mode) {
        throw new Error("The active-key pointer did not survive a write+read verification.");
      }
      // In-session: the resolver serves the new key on the very next request —
      // the wallet reads it per request too, so it is in force on its next call.
      resolver.setActiveKey(AgentCredentialStore.activeKey(readBack));
      const source = resolver.source();
      return {
        activeMode: mode,
        source: source === "none" ? "store" : source,
        envOverride: resolver.hasEnvOverride(),
      };
    }),
  };
}

/**
 * Typed, like every other surface that names this state (the boot line, the
 * tools' credentials_locked relay): a bare Error would reach the agent as an
 * opaque internal_error with nowhere to go.
 */
function credentialsLocked(): ToolError {
  return new ToolError(
    `The API credentials vault on this machine could not be opened: ${CHAIN_DESCRIPTION}.`,
    "credentials_locked",
    { data: withNextAction({}, "credentials_locked", { deployment: "local" }) },
  );
}

/** Is the sk_ vault on disk at all? Answers without a passphrase. */
export async function agentCredentialsExist(env?: NodeJS.ProcessEnv): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  const { AGENT_CREDENTIALS_FILE } = await import("./wallet-engine/agent/credential-store.js");
  try {
    return (await stat(join(resolveAgentDir(env), AGENT_CREDENTIALS_FILE))).isFile();
  } catch {
    return false;
  }
}

/**
 * Open the sk_ vault through the unlock chain and report WHICH of the three
 * situations this machine is in. "Would not open" and "is not here" have
 * opposite remedies, so they must not come back as one boolean: a caller that
 * cannot tell them apart sends the operator to configure a credential they
 * already have.
 */
export async function readAgentCredentials(
  vault: AgentVaultOptions = {},
): Promise<{ state: Exclude<VaultState, "skipped">; activeKey?: string }> {
  if (!(await agentCredentialsExist(vault.env))) return { state: "none" };
  const passphrase = await resolveAgentPassphrase(vault);
  if (passphrase === undefined) return { state: "locked" };
  try {
    const { AgentCredentialStore } = await import("./wallet-engine/agent/credential-store.js");
    const store = new AgentCredentialStore({ dataDir: resolveAgentDir(vault.env), passphrase });
    const creds = await store.load();
    // Raced away between the stat and the read — genuinely nothing to serve.
    if (!creds) return { state: "none" };
    return { state: "active", activeKey: AgentCredentialStore.activeKey(creds) };
  } catch {
    return { state: "locked" };
  }
}

/**
 * Seed the resolver from the encrypted store at boot, so a restarted agent keeps
 * using the account it created (through the unlock chain) without a key in the env.
 */
export async function seedResolverFromStore(
  resolver: CredentialResolver,
  vault: AgentVaultOptions = {},
): Promise<VaultState> {
  if (resolver.envKeyPresent()) return "skipped"; // env wins; nothing to open
  const { state, activeKey } = await readAgentCredentials(vault);
  if (activeKey !== undefined) resolver.setActiveKey(activeKey);
  return state;
}
