// The DEFAULT wiring of the agent-local tools to the real DepixAgent + the
// encrypted credential store (§3.1). Kept out of stdio.ts so the bin stays a thin
// composition root and this stays unit-testable. Everything that pulls the wallet
// engine (DepixAgent, AgentCredentialStore, argon2) is imported LAZILY, inside the
// handlers, so a gateway-only `npx @depixapp/mcp` boot never pays for it.

import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolDeps, AgentWalletLike, KeyActivation } from "./agent-tools.js";
import type { CredentialResolver } from "./credentials.js";

/** Mirrors DepixAgent.resolveDataDir — the agent identity + credentials live here. */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEPIX_AGENT_DIR ?? join(homedir(), ".depix-agent");
}

/** The passphrase that seals the identity + credential stores (env only in F3). */
export function resolveAgentPassphrase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DEPIX_AGENT_PASSPHRASE ?? env.DEPIX_WALLET_PASSPHRASE;
}

export interface BuildAgentToolDepsOptions {
  resolver: CredentialResolver;
  apiBase: string;
  /** The wallet resolver (for the payout address). */
  getWallet: () => Promise<AgentWalletLike | null>;
}

export function buildAgentToolDeps(opts: BuildAgentToolDepsOptions): AgentToolDeps {
  const { resolver, apiBase, getWallet } = opts;
  const agentOptions = () => ({
    apiBase,
    dataDir: resolveAgentDir(),
    ...(resolveAgentPassphrase() !== undefined ? { passphrase: resolveAgentPassphrase() } : {}),
  });

  return {
    getWallet,
    openAgent: async () => {
      const { DepixAgent } = await import("./wallet-engine/agent.js");
      try {
        return await DepixAgent.open(agentOptions());
      } catch (err) {
        // No identity yet → null so register_account creates one. Every other
        // failure (bad passphrase, corrupt store) rethrows.
        if ((err as { code?: string } | undefined)?.code === "agent_not_initialized") return null;
        throw err;
      }
    },
    createAgent: async () => {
      const { DepixAgent } = await import("./wallet-engine/agent.js");
      return DepixAgent.create(agentOptions());
    },
    persistKeys: async ({ testKey, liveKey, prefer }): Promise<KeyActivation> => {
      const passphrase = resolveAgentPassphrase();
      if (passphrase === undefined) {
        throw new Error("No passphrase to seal the API credentials (set DEPIX_WALLET_PASSPHRASE).");
      }
      const { AgentCredentialStore } = await import("./wallet-engine/agent/credential-store.js");
      const store = new AgentCredentialStore({ dataDir: resolveAgentDir(), passphrase });
      await store.save({ testKey, ...(liveKey ? { liveKey } : {}), active: prefer });
      // Verify durability BEFORE the caller reports success (§3.1): read it back.
      const readBack = await store.load();
      if (!readBack || readBack.testKey !== testKey) {
        throw new Error("The API credentials did not survive a write+read verification.");
      }
      // Activate in-session so the very next gateway request uses the new key —
      // unless an env key is overriding it, in which case env still wins.
      resolver.setActiveKey(AgentCredentialStore.activeKey(readBack));
      return {
        activeMode: prefer,
        source: resolver.source() === "env" ? "env" : "store",
        envOverride: resolver.hasEnvOverride(),
      };
    },
  };
}

/**
 * Seed the resolver from the encrypted store at boot, so a restarted agent keeps
 * using the account it created (given the passphrase) without a key in the env.
 * Best-effort: no store, no passphrase, or a decrypt failure just leaves the
 * resolver empty (the tools then answer missing_api_key → register_account).
 */
export async function seedResolverFromStore(resolver: CredentialResolver): Promise<boolean> {
  if (resolver.envKeyPresent()) return false; // env wins; nothing to seed
  const passphrase = resolveAgentPassphrase();
  if (passphrase === undefined) return false;
  try {
    const { AgentCredentialStore } = await import("./wallet-engine/agent/credential-store.js");
    const store = new AgentCredentialStore({ dataDir: resolveAgentDir(), passphrase });
    const creds = await store.load();
    if (!creds) return false;
    resolver.setActiveKey(AgentCredentialStore.activeKey(creds));
    return true;
  } catch {
    return false;
  }
}
