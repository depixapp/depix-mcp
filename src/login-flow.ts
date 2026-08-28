// `depix-mcp login` / `depix-mcp logout` — the orchestration.
//
// Every side effect is injected (the listener, the browser, fetch, the encrypted
// store), so the whole flow is exercised in unit tests without binding a socket
// or opening a window. src/owner-deps.ts supplies the real ones.
//
// ORDER IS LOAD-BEARING: the loopback listener is bound BEFORE the browser is
// opened. The other way round, a fast redirect reaches a socket that is not
// listening yet and the operator sees "connection refused" on a login that
// actually started fine.
//
// NOTHING SECRET IS EVER PRINTED. The success page carries no token (the code
// arrives in the query, is exchanged, and is discarded), and the terminal
// readout names the account, not the credential.

import {
  OWNER_LOOPBACK_PATH,
  OWNER_LOOPBACK_PORT,
  OWNER_LOOPBACK_REDIRECT_URI,
  OwnerLoginError,
  buildAuthorizeUrl,
  createPkce,
  createState,
  discoverAuthServer,
  exchangeCode,
  readCallbackParams,
  type OwnerProvider,
} from "./owner-oauth.js";
import { UNIFIED_INIT_COMMAND } from "./instructions.js";
import type { Persona } from "./account-preference.js";
import type { OwnerSession } from "./wallet-engine/agent/owner-session-store.js";

/** How long the operator has to finish the sign-in before the listener gives up. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** The single browser hit the loopback listener accepts. */
export interface LoopbackCallback {
  query: URLSearchParams;
  /** Answer the browser and close the listener. Called exactly once. */
  respond(page: { status: number; html: string }): void;
}

export type WaitForCallback = (opts: {
  port: number;
  path: string;
  timeoutMs: number;
}) => Promise<LoopbackCallback>;

export interface OwnerLoginDeps {
  /** Human output. STDOUT is the JSON-RPC channel, so this MUST be stderr. */
  write(text: string): void;
  fetchImpl: typeof fetch;
  waitForCallback: WaitForCallback;
  /** Returns false when no browser could be opened (the URL is printed instead). */
  openBrowser(url: string): Promise<boolean>;
  /** Seal the session on disk. Rejects when there is no wallet/passphrase. */
  saveSession(session: OwnerSession): Promise<void>;
  /** Is there already an agent account on this machine? (steers the warning) */
  hasAgentAccount(): Promise<boolean>;
  /** The explicit `account use` selection, if any. */
  preference(): Promise<Persona | undefined>;
  clientId: string;
  resourceUrl: string;
  /** True when this machine has no browser at all (a headless Linux box). */
  headless: boolean;
  provider?: OwnerProvider;
  now?(): number;
  timeoutMs?: number;
}

export interface OwnerLogoutDeps {
  write(text: string): void;
  /** Remove the session; reports whether there was one. */
  clearSession(): Promise<boolean>;
  preference(): Promise<Persona | undefined>;
  clearPreference(): Promise<void>;
  hasAgentAccount(): Promise<boolean>;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
body{font:16px/1.6 system-ui,-apple-system,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0d10;color:#e8eaed}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#9aa0a6}
</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

const SUCCESS_PAGE = page("Signed in.", "Go back to your terminal.");
const FAILURE_PAGE = page("Sign-in failed.", "Go back to your terminal for the reason.");

/**
 * The loopback redirect only ever reaches a browser on THIS machine, so a box
 * with no display cannot complete it however long it waits. Say that, and point
 * at the credential paths that do work over SSH.
 */
const HEADLESS_MESSAGE =
  `depix-mcp: \`login\` needs a web browser on this same machine — the sign-in comes back to ${OWNER_LOOPBACK_REDIRECT_URI}, ` +
  "which is this computer and nowhere else. On a headless or remote host, authenticate with an API key instead: set " +
  "DEPIX_API_KEY in the server config, or let the agent create its own account with the register_account tool.\n" +
  "  If this machine does have a browser, re-run with DEPIX_LOGIN_ASSUME_BROWSER=1.\n";

export async function runOwnerLogin(deps: OwnerLoginDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  if (deps.headless) {
    deps.write(HEADLESS_MESSAGE);
    return 1;
  }

  let callback: LoopbackCallback | undefined;
  try {
    const endpoints = await discoverAuthServer({ resourceUrl: deps.resourceUrl, fetchImpl: deps.fetchImpl });
    const pkce = createPkce();
    const state = createState();
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId: deps.clientId,
      redirectUri: OWNER_LOOPBACK_REDIRECT_URI,
      state,
      challenge: pkce.challenge,
      resource: deps.resourceUrl,
      ...(deps.provider ? { provider: deps.provider } : {}),
    });

    // Bind first, open second — see the header note.
    const pending = deps.waitForCallback({
      port: OWNER_LOOPBACK_PORT,
      path: OWNER_LOOPBACK_PATH,
      timeoutMs: deps.timeoutMs ?? CALLBACK_TIMEOUT_MS,
    });
    // Mark it handled now: the browser is opened before `pending` is awaited,
    // and a listener that fails to bind must not surface as an unhandled
    // rejection in the gap.
    void pending.catch(() => {});
    const opened = await deps.openBrowser(authorizeUrl);
    deps.write(
      opened
        ? "depix-mcp: opening your browser to sign in with DePix App…\n"
        : `depix-mcp: could not open a browser. Open this URL to sign in:\n\n  ${authorizeUrl}\n\n`,
    );

    callback = await pending;
    const code = readCallbackParams(callback.query, state);
    const tokens = await exchangeCode({
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: deps.clientId,
      code,
      verifier: pkce.verifier,
      redirectUri: OWNER_LOOPBACK_REDIRECT_URI,
      resource: deps.resourceUrl,
      fetchImpl: deps.fetchImpl,
      nowMs: now(),
    });
    callback.respond({ status: 200, html: SUCCESS_PAGE });
    callback = undefined;

    await deps.saveSession({
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokens.expiresAt,
      ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    });

    deps.write("depix-mcp: signed in. The owner's DePix account is now available to this server.\n");
    await announceActivePersona(deps);
    return 0;
  } catch (err) {
    callback?.respond({ status: 400, html: FAILURE_PAGE });
    deps.write(explain(err));
    return 1;
  }
}

/**
 * Which identity the server will actually use now. With an agent account
 * already registered, logging in changes NOTHING by default — say so loudly
 * rather than letting the operator assume the new session took over.
 */
async function announceActivePersona(deps: OwnerLoginDeps): Promise<void> {
  const [hasAgent, preference] = await Promise.all([deps.hasAgentAccount(), deps.preference()]);
  if (!hasAgent || preference === "owner") {
    deps.write("depix-mcp: active account: owner (your DePix login).\n");
    return;
  }
  deps.write(
    "depix-mcp: WARNING — this server keeps acting as the AGENT's own account, not yours. An agent account is " +
      "registered on this machine and wins by default.\n" +
      "  To act as you: `npx -y @depixapp/mcp account use owner`\n" +
      "  To check at any time: `npx -y @depixapp/mcp account status`\n",
  );
}

export async function runOwnerLogout(deps: OwnerLogoutDeps): Promise<number> {
  const [removed, preference] = await Promise.all([deps.clearSession(), deps.preference()]);
  if (!removed) {
    deps.write("depix-mcp: no owner login was stored on this machine — nothing to sign out of.\n");
    return 0;
  }
  deps.write("depix-mcp: signed out. The owner's DePix login was removed from this machine.\n");
  if (preference === "owner") {
    // The selection would now point at a persona that no longer exists.
    await deps.clearPreference();
    const hasAgent = await deps.hasAgentAccount();
    deps.write(
      hasAgent
        ? "depix-mcp: the `account use owner` selection was dropped — this server is back to the agent's own account.\n"
        : "depix-mcp: the `account use owner` selection was dropped. No credentials remain: set DEPIX_API_KEY, or let " +
            "the agent create an account with register_account.\n",
    );
  }
  return 0;
}

/** Turn a thrown failure into one didactic line — never a stack, never a token. */
function explain(err: unknown): string {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  if (errno === "EADDRINUSE") {
    return (
      `depix-mcp: port ${OWNER_LOOPBACK_PORT} is already in use, so the sign-in reply has nowhere to land. ` +
      "The sign-in address is registered with a fixed port, so it cannot move: close the other `depix-mcp login` " +
      "(or whatever holds that port) and try again.\n"
    );
  }
  if (err instanceof OwnerLoginError) {
    const detail = err.data.provider_error;
    return `depix-mcp: ${err.message}${typeof detail === "string" ? ` (${detail})` : ""}\n`;
  }
  if (errno === "owner_session_locked" || errno === "WEAK_PASSPHRASE") {
    return (
      "depix-mcp: signed in, but the session could not be saved — this machine has no wallet to seal it with. " +
      `Run \`${UNIFIED_INIT_COMMAND}\` first (it creates the wallet and its passphrase), then run \`login\` again.\n`
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return `depix-mcp: login failed: ${message}\n`;
}
