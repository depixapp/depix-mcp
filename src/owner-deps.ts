// The DEFAULT wiring of `login` / `logout` / `account` to the real listener,
// browser and encrypted store. Kept out of stdio.ts so the bin stays a thin
// composition root, and out of login-flow.ts so that stays unit-testable.
//
// Everything that pulls the wallet engine (OwnerSessionStore, argon2) is
// imported LAZILY inside the handlers, exactly like agent-deps.ts: a plain
// `npx @depixapp/mcp` boot that never touches the owner session pays nothing.
//
// TWO DIRECTORIES, ON PURPOSE:
//   - the SESSION is sealed next to the agent's sk_ keys (~/.depix-agent), under
//     the same passphrase, because both are credentials;
//   - the SELECTION is plain JSON in the wallet dir (~/.depix-wallet), because a
//     preference is not a secret and must stay readable with no passphrase at
//     all — `account status` has to work on a locked machine.

import { resolveWalletDir } from "./unified.js";
import {
  agentCredentialsExist,
  readAgentCredentials,
  resolveAgentDir,
  resolveAgentPassphrase,
  type AgentVaultOptions,
  type VaultState,
} from "./agent-deps.js";
import { clearAccountPreference, readAccountPreference, writeAccountPreference, type Persona } from "./account-preference.js";
import { discoverAuthServer, refreshOwnerTokens, resolveOwnerClientId } from "./owner-oauth.js";
import { createOwnerRefreshHook } from "./owner-refresh.js";
import { waitForLoopbackCallback } from "./loopback-listener.js";
import type { CredentialResolver } from "./credentials.js";
import type { OwnerLoginDeps, OwnerLogoutDeps } from "./login-flow.js";
import type { AccountDeps, OwnerSessionFacts } from "./account-command.js";
import type { OwnerSession } from "./wallet-engine/agent/owner-session-store.js";

/**
 * The MCP resource the owner's token is audienced for. The DePix App API accepts
 * a WorkOS bearer only when `aud` matches the resource it is configured with, so
 * this must stay byte-identical to the published protected-resource document.
 */
export function resolveOwnerResourceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.DEPIX_MCP_RESOURCE_URL?.trim() || "https://mcp.depixapp.com/mcp").replace(/\/+$/, "");
}

/** Marks a save that failed for lack of a wallet/passphrase (login-flow reads it). */
class OwnerSessionLockedError extends Error {
  readonly code = "owner_session_locked";
}

async function openStore(vault: AgentVaultOptions = {}): Promise<{ save: (s: OwnerSession) => Promise<void>; load: () => Promise<OwnerSession | null>; clear: () => Promise<boolean> }> {
  const passphrase = await resolveAgentPassphrase(vault);
  const dataDir = resolveAgentDir(vault.env);
  const { OwnerSessionStore } = await import("./wallet-engine/agent/owner-session-store.js");
  if (passphrase === undefined) {
    // The whole chain came up empty ⇒ nothing can be sealed or opened. `clear`
    // still works: it only unlinks, which is what `logout` needs on a locked
    // machine.
    return {
      save: () => Promise.reject(new OwnerSessionLockedError("No passphrase to seal the owner session.")),
      load: () => Promise.reject(new OwnerSessionLockedError("No passphrase to open the owner session.")),
      clear: () => new OwnerSessionStore({ dataDir, passphrase: "" }).clear(),
    };
  }
  const store = new OwnerSessionStore({ dataDir, passphrase });
  return { save: (s) => store.save(s), load: () => store.load(), clear: () => store.clear() };
}

async function ownerSessionExists(env?: NodeJS.ProcessEnv): Promise<boolean> {
  const { OwnerSessionStore } = await import("./wallet-engine/agent/owner-session-store.js");
  return OwnerSessionStore.exists(resolveAgentDir(env));
}

/**
 * Does this machine have a browser the loopback redirect can come back to? Only
 * a display-less Linux host is treated as headless — macOS and Windows always
 * have a UI, and `DEPIX_LOGIN_ASSUME_BROWSER` is the escape hatch for the exotic
 * setups (X forwarding, a container that proxies `xdg-open`) this cannot see.
 */
export function isLikelyHeadless(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.DEPIX_LOGIN_ASSUME_BROWSER === "1") return false;
  if (platform !== "linux") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

async function openBrowser(url: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

const preferenceDir = (env?: NodeJS.ProcessEnv) => resolveWalletDir(env);

export interface BuildOwnerLoginDepsOptions {
  write(text: string): void;
  provider?: "google" | "github";
}

export function buildOwnerLoginDeps(opts: BuildOwnerLoginDepsOptions): OwnerLoginDeps {
  return {
    write: opts.write,
    fetchImpl: fetch,
    waitForCallback: waitForLoopbackCallback,
    openBrowser,
    saveSession: async (session) => {
      const store = await openStore();
      await store.save(session);
    },
    hasAgentAccount: agentCredentialsExist,
    preference: () => readAccountPreference(preferenceDir()),
    clientId: resolveOwnerClientId(),
    resourceUrl: resolveOwnerResourceUrl(),
    headless: isLikelyHeadless(),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
}

export function buildOwnerLogoutDeps(write: (text: string) => void): OwnerLogoutDeps {
  return {
    write,
    clearSession: async () => (await openStore()).clear(),
    preference: () => readAccountPreference(preferenceDir()),
    clearPreference: () => clearAccountPreference(preferenceDir()),
    hasAgentAccount: agentCredentialsExist,
  };
}

export function buildAccountDeps(write: (text: string) => void, vault: AgentVaultOptions = {}): AccountDeps {
  return {
    write,
    envKeyPresent: Boolean((vault.env ?? process.env).DEPIX_API_KEY),
    hasAgentAccount: () => agentCredentialsExist(vault.env),
    agentAccountLocked: async () => (await readAgentCredentials(vault)).state === "locked",
    ownerSession: async (): Promise<OwnerSessionFacts | null> => {
      if (!(await ownerSessionExists(vault.env))) return null;
      try {
        const session = await (await openStore(vault)).load();
        if (session === null) return null;
        return {
          present: true,
          ...(session.provider !== undefined ? { provider: session.provider } : {}),
          ...(session.email !== undefined ? { email: session.email } : {}),
          expiresAt: session.expiresAt,
        };
      } catch {
        // The file is there but will not open (nothing in the whole unlock
        // chain, the wrong passphrase, or a corrupt blob). That is a REPORTABLE
        // state, not an absent session: saying "no owner login" would send the
        // operator to re-run `login` when the actual fix is the passphrase.
        return { present: true, locked: true };
      }
    },
    preference: () => readAccountPreference(preferenceDir(vault.env)),
    setPreference: (persona: Persona) => writeAccountPreference(preferenceDir(vault.env), persona),
    clearPreference: () => clearAccountPreference(preferenceDir(vault.env)),
  };
}

// ── boot + refresh wiring for the served process ────────────────────────────

/**
 * Seed the resolver with the owner's session (and the persona they selected) at
 * boot, so a restarted server keeps acting as whoever it was acting as.
 *
 * Reports WHICH of the three states this machine is in — see readAgentCredentials
 * for why a boolean cannot carry that.
 */
export async function seedOwnerSession(
  resolver: CredentialResolver,
  vault: AgentVaultOptions = {},
): Promise<VaultState> {
  resolver.setPreference(await readAccountPreference(preferenceDir(vault.env)));
  if (!(await ownerSessionExists(vault.env))) return "none";
  try {
    const session = await (await openStore(vault)).load();
    // Raced away between the stat and the read.
    if (session === null) return "none";
    resolver.setOwnerToken(session.accessToken);
    return "active";
  } catch {
    return "locked";
  }
}

/**
 * The ApiClient's 401 hook, wired to the real store and the real endpoints.
 * The single-flight gate that keeps two concurrent 401s from spending the same
 * one-shot refresh token lives in createOwnerRefreshHook.
 */
export function buildOwnerRefreshHook(resolver: CredentialResolver): () => Promise<boolean> {
  const resourceUrl = resolveOwnerResourceUrl();
  return createOwnerRefreshHook({
    loadSession: async () => (await openStore()).load(),
    saveSession: async (session) => (await openStore()).save(session),
    tokenEndpoint: async () => (await discoverAuthServer({ resourceUrl })).tokenEndpoint,
    refresh: ({ tokenEndpoint, refreshToken }) =>
      refreshOwnerTokens({ tokenEndpoint, clientId: resolveOwnerClientId(), refreshToken, resource: resourceUrl }),
    setToken: (token) => resolver.setOwnerToken(token),
  });
}
