// Renewing the owner session, SINGLE-FLIGHT.
//
// The MCP serves tool calls concurrently, so two of them can hit a 401 at the
// same instant. Without a gate each one loads the session, reads the SAME
// refresh token, and POSTs it. WorkOS rotates on first use: the second POST
// presents a token that is already spent, its failure raises
// `owner_session_expired`, and a session that is perfectly alive is declared
// dead. One renewal in flight at a time is the whole fix — every concurrent
// caller awaits the same promise and gets the same answer.
//
// The gate is PER FLIGHT, not once per process: it clears when the renewal
// settles (success or failure), so a token that expires again an hour later is
// renewed again, and a transient network failure does not latch the session
// shut.
//
// Injected wholesale so this is testable without a store, a socket or a clock.
// The engine-backed wiring lives in src/owner-deps.ts.

import { ownerSessionExpiredError } from "./errors.js";
import type { OwnerTokens } from "./owner-oauth.js";
import type { OwnerSession } from "./wallet-engine/agent/owner-session-store.js";

export interface OwnerRefreshDeps {
  loadSession(): Promise<OwnerSession | null>;
  saveSession(session: OwnerSession): Promise<void>;
  /** Resolved once and reused — discovery is stable for the life of a process. */
  tokenEndpoint(): Promise<string>;
  refresh(opts: { tokenEndpoint: string; refreshToken: string }): Promise<OwnerTokens>;
  /** Hand the fresh access token to the credential resolver. */
  setToken(token: string): void;
}

/**
 * Build the ApiClient's 401 hook. Resolves true when the session was renewed
 * and the request is worth one more attempt; throws the typed
 * `owner_session_expired` when only a human can fix it.
 */
export function createOwnerRefreshHook(deps: OwnerRefreshDeps): () => Promise<boolean> {
  let inFlight: Promise<boolean> | undefined;
  let endpoint: string | undefined;

  async function renew(): Promise<boolean> {
    let session: OwnerSession | null;
    try {
      session = await deps.loadSession();
    } catch {
      // Unreadable store (no passphrase, wrong one, tampered blob): from here
      // it is indistinguishable from an expired session, and the fix is the
      // same human step.
      throw ownerSessionExpiredError();
    }
    if (session === null || session.refreshToken === undefined) throw ownerSessionExpiredError();
    try {
      endpoint ??= await deps.tokenEndpoint();
      const tokens = await deps.refresh({ tokenEndpoint: endpoint, refreshToken: session.refreshToken });
      await deps.saveSession({
        ...session,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
        expiresAt: tokens.expiresAt,
      });
      deps.setToken(tokens.accessToken);
      return true;
    } catch {
      // Swallowed on purpose: the cause can carry the refresh token, and this
      // error reaches the model.
      throw ownerSessionExpiredError();
    }
  }

  return () => {
    // `finally` clears the gate BEFORE the awaiting callers resolve, so the
    // next 401 after this one starts a fresh flight rather than reusing a
    // settled promise.
    inFlight ??= renew().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
