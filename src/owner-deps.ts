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
import { resolveAgentDir, resolveAgentPassphrase } from "./agent-deps.js";
import { clearAccountPreference, readAccountPreference, writeAccountPreference, type Persona } from "./account-preference.js";
import { ownerSessionExpiredError } from "./errors.js";
import { discoverAuthServer, refreshOwnerTokens, resolveOwnerClientId, type AuthServerEndpoints } from "./owner-oauth.js";
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

async function openStore(): Promise<{ save: (s: OwnerSession) => Promise<void>; load: () => Promise<OwnerSession | null>; clear: () => Promise<boolean> }> {
  const passphrase = resolveAgentPassphrase();
  const dataDir = resolveAgentDir();
  const { OwnerSessionStore } = await import("./wallet-engine/agent/owner-session-store.js");
  if (passphrase === undefined) {
    // No passphrase ⇒ nothing can be sealed or opened. `clear` still works: it
    // only unlinks, which is what `logout` needs on a locked machine.
    return {
      save: () => Promise.reject(new OwnerSessionLockedError("No passphrase to seal the owner session.")),
      load: () => Promise.reject(new OwnerSessionLockedError("No passphrase to open the owner session.")),
      clear: () => new OwnerSessionStore({ dataDir, passphrase: "" }).clear(),
    };
  }
  const store = new OwnerSessionStore({ dataDir, passphrase });
  return { save: (s) => store.save(s), load: () => store.load(), clear: () => store.clear() };
}

async function ownerSessionExists(): Promise<boolean> {
  const { OwnerSessionStore } = await import("./wallet-engine/agent/owner-session-store.js");
  return OwnerSessionStore.exists(resolveAgentDir());
}

async function agentAccountExists(): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { AGENT_CREDENTIALS_FILE } = await import("./wallet-engine/agent/credential-store.js");
  try {
    return (await stat(join(resolveAgentDir(), AGENT_CREDENTIALS_FILE))).isFile();
  } catch {
    return false;
  }
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

const preferenceDir = () => resolveWalletDir();

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
    hasAgentAccount: agentAccountExists,
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
    hasAgentAccount: agentAccountExists,
  };
}

export function buildAccountDeps(write: (text: string) => void): AccountDeps {
  return {
    write,
    envKeyPresent: Boolean(process.env.DEPIX_API_KEY),
    hasAgentAccount: agentAccountExists,
    ownerSession: async (): Promise<OwnerSessionFacts | null> => {
      if (!(await ownerSessionExists())) return null;
      try {
        const session = await (await openStore()).load();
        if (session === null) return null;
        return {
          present: true,
          ...(session.provider !== undefined ? { provider: session.provider } : {}),
          ...(session.email !== undefined ? { email: session.email } : {}),
          expiresAt: session.expiresAt,
        };
      } catch {
        // The file is there but will not open (no passphrase, wrong one, or a
        // corrupt blob). That is a REPORTABLE state, not an absent session:
        // saying "no owner login" would send the operator to re-run `login`
        // when the actual fix is the passphrase.
        return { present: true, locked: true };
      }
    },
    preference: () => readAccountPreference(preferenceDir()),
    setPreference: (persona: Persona) => writeAccountPreference(preferenceDir(), persona),
    clearPreference: () => clearAccountPreference(preferenceDir()),
  };
}

// ── boot + refresh wiring for the served process ────────────────────────────

/**
 * Seed the resolver with the owner's session (and the persona they selected) at
 * boot, so a restarted server keeps acting as whoever it was acting as.
 * Best-effort: no session, no passphrase, or a decrypt failure just leaves the
 * owner half empty and the agent/env credential decides on its own.
 */
export async function seedOwnerSession(resolver: CredentialResolver): Promise<boolean> {
  resolver.setPreference(await readAccountPreference(preferenceDir()));
  try {
    const session = await (await openStore()).load();
    if (session === null) return false;
    resolver.setOwnerToken(session.accessToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ApiClient's 401 hook: renew the owner session ONCE, persist the rotation,
 * and hand the fresh token to the resolver. A refused refresh throws the typed
 * `owner_session_expired` so the agent gets the "ask the operator to run login
 * again" step instead of an opaque 401.
 */
export function buildOwnerRefreshHook(resolver: CredentialResolver): () => Promise<boolean> {
  // Discovery is stable for the life of the process; one round trip, not one
  // per 401.
  let endpoints: AuthServerEndpoints | undefined;
  const resourceUrl = resolveOwnerResourceUrl();
  return async () => {
    const store = await openStore();
    let session: OwnerSession | null;
    try {
      session = await store.load();
    } catch {
      throw ownerSessionExpiredError();
    }
    if (session === null || session.refreshToken === undefined) throw ownerSessionExpiredError();
    try {
      endpoints ??= await discoverAuthServer({ resourceUrl });
      const tokens = await refreshOwnerTokens({
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId: resolveOwnerClientId(),
        refreshToken: session.refreshToken,
        resource: resourceUrl,
      });
      await store.save({
        ...session,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
        expiresAt: tokens.expiresAt,
      });
      resolver.setOwnerToken(tokens.accessToken);
      return true;
    } catch {
      throw ownerSessionExpiredError();
    }
  };
}
