#!/usr/bin/env node
// The UNIFIED local bin — `npx -y @depixapp/mcp` (unified-MCP spec §1).
//
// One process, one server, 62 tools: the 26 gateway tools (a pure client of the
// public DePix App API) plus the 29 `wallet_*` tools of the non-custodial Liquid
// wallet, which signs HERE, in the operator's own environment. Custody is decided
// by who holds the seed, not by the transport — so this deployment is the one that
// can hold one, and mcp.depixapp.com structurally cannot (§2.1).
//
// THREE-STATE BOOT (§1(b)) — it never exits over missing configuration:
//   - no DEPIX_API_KEY: the API-backed tools return the typed `missing_api_key`.
//     (BEHAVIOUR CHANGE from 1.x, which exited 1: an operator running only the
//     wallet half has no gateway key, and refusing to boot would deny them all 29
//     wallet tools over a credential they do not need.)
//   - no wallet on the machine: every wallet_* tool returns the typed
//     `wallet_not_configured` naming `npx -y @depixapp/mcp init`.
//   - both present: all 62 work.
// The catalog is ALWAYS 62 — MCP hosts snapshot tools/list at connect and
// `list_changed` support is uneven, so a catalog that grew after `init` would mean
// "restart your client".
//
// STDOUT is the JSON-RPC channel; every human byte goes to STDERR, redacted.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCli } from "./cli.js";
import { isAllowedApiOrigin, resolveApiBase, resolveMaxWaitSeconds, resolveServerVersion } from "./config.js";
import { UNIFIED_INIT_COMMAND } from "./instructions.js";
import { logger, redact } from "./log.js";
import { sanitizeOutgoingSchemas } from "./schemaDialect.js";
import { CredentialResolver, personaLabel } from "./credentials.js";
import { buildAgentToolDeps, seedResolverFromStore } from "./agent-deps.js";
import {
  buildAccountDeps,
  buildOwnerLoginDeps,
  buildOwnerLogoutDeps,
  buildOwnerRefreshHook,
  seedOwnerSession,
} from "./owner-deps.js";
import { runOwnerLogin, runOwnerLogout } from "./login-flow.js";
import { runAccountCommand } from "./account-command.js";
import {
  UNIFIED_PACKAGE_NAME,
  UNIFIED_TOOL_COUNT,
  createUnifiedServer,
  createWalletOpener,
  createWalletRuntime,
  isWalletConfigured,
  resolveWalletDir,
  walletApiKey,
} from "./unified.js";
import {
  createShutdownHandler,
  resolveKeyMode,
  resolveMaxWaitSeconds as resolveWalletMaxWaitSeconds,
} from "./wallet-engine/mcp/runtime.js";

function stderr(text: string): void {
  process.stderr.write(redact(text));
}

/** The engine's Logger shape, backed by this package's redacting logger. */
const engineLogger = {
  debug: (event: string, fields?: unknown) => logger.info(event, fields as Record<string, unknown>),
  info: (event: string, fields?: unknown) => logger.info(event, fields as Record<string, unknown>),
  warn: (event: string, fields?: unknown) => logger.warn(event, fields as Record<string, unknown>),
  error: (event: string, fields?: unknown) => logger.error(event, fields as Record<string, unknown>),
};

async function serve(): Promise<void> {
  const envKey = process.env.DEPIX_API_KEY;
  // The credential is now RESOLVED per request (§3.1): the env key wins, else the
  // key register_account wrote to the encrypted store. Seed it from the store at
  // boot so a restarted agent keeps operating the account it created.
  const credentials = new CredentialResolver({ envKey });
  const agentVault = await seedResolverFromStore(credentials);
  // The operator's own login (`depix-mcp login`) is the second identity this
  // process can act as. Seeding it here — with the persona they selected — is
  // what makes a restart keep acting as whoever it was acting as.
  const ownerVault = await seedOwnerSession(credentials);
  // A vault that EXISTS and would not open is not an absent credential. Carried
  // to the ApiClient so the tools' error names the lock instead of sending the
  // agent to register an account this machine already has.
  const lockedCredentials = {
    ...(ownerVault === "locked" ? { ownerSession: true } : {}),
    ...(agentVault === "locked" ? { agentCredentials: true } : {}),
  };
  const anythingLocked = Object.keys(lockedCredentials).length > 0;
  const apiKeyConfigured = credentials.resolveCredential() !== undefined;
  const walletDir = resolveWalletDir();
  const walletConfigured = await isWalletConfigured(walletDir);

  if (!apiKeyConfigured && anythingLocked) {
    stderr(
      "depix-mcp: this machine HAS a stored DePix credential, but this server could not unlock it — the passphrase " +
        "is not in DEPIX_AGENT_PASSPHRASE or DEPIX_WALLET_PASSPHRASE, and no unlock key for this wallet was found in " +
        "the OS keychain (`npx -y @depixapp/mcp init` is what puts it there). Serving anyway, with the API-backed " +
        "tools erroring. Run `npx -y @depixapp/mcp account status` to see which credential is stuck.\n",
    );
  } else if (!apiKeyConfigured) {
    stderr(
      "depix-mcp: no DEPIX_API_KEY, no stored account and no owner login. Serving anyway — the tools that call the " +
        "DePix App API return a missing_api_key error until you set a key, run `npx -y @depixapp/mcp login`, or " +
        "create an account with the register_account tool.\n",
    );
  } else if (credentials.bothPersonasPresent() || credentials.selectionUnavailable() || credentials.hasEnvOverride()) {
    // More than one credential on this machine: never leave which one is acting
    // implicit. The sentence comes from the SAME ladder that picks the
    // credential, so the boot line cannot contradict `account status`.
    const verdict = credentials.verdict();
    stderr(
      `depix-mcp: acting as ${personaLabel(verdict)} — ${verdict.reason}. ` +
        "Run `npx -y @depixapp/mcp account status` for the full picture.\n",
    );
  }
  if (!walletConfigured) {
    stderr(
      `depix-mcp: no wallet in ${walletDir}. Serving anyway — the 29 wallet_* tools are listed and return ` +
        `wallet_not_configured until you run \`${UNIFIED_INIT_COMMAND}\` in a terminal.\n`,
    );
  }

  // The wallet — and with it the LWK wasm engine — is loaded ONLY on the first
  // wallet tool call: `DepixWallet` arrives through a dynamic import inside the
  // resolver, so a gateway-only operator pays nothing for the wallet half. Both
  // auto-resumes are disabled so the runtime runs them explicitly and can surface
  // their summaries through wallet_status, exactly as the engine's own bin does.
  // The wallet authenticates with the SAME ladder as the gateway half (env >
  // `account use` > the agent's own stored key), minus the owner login — see
  // walletApiKey. The engine reads it on every request, so a key created or
  // switched mid-session is in force on the next call — no re-open.
  const apiBase = resolveApiBase();
  if (!isAllowedApiOrigin(apiBase)) {
    stderr(
      "depix-mcp: DEPIX_API_BASE points to an origin that is not allowlisted. The API-backed tools refuse every " +
        "request before any network call, and the wallet is given no credential at all — stored or from the " +
        "environment.\n",
    );
  }
  const walletCredential = () => walletApiKey(credentials.resolveCredential());
  const runtime = createWalletRuntime({
    open: createWalletOpener({ resolveApiKey: walletCredential, apiBase }),
    onError: (event, err) => logger.error(event, { name: err instanceof Error ? err.name : "unknown" }),
  });

  const version = resolveServerVersion();
  const { server } = createUnifiedServer({
    // A resolver, not a value: register_account can write a key mid-session and it
    // takes effect on the very next request (§3.1) — no restart.
    apiKey: credentials.asFunction(),
    // An owner session's access token is short-lived: on a 401 the client renews
    // it ONCE and replays. An sk_ key never reaches this hook.
    onUnauthorized: buildOwnerRefreshHook(credentials),
    lockedCredentials,
    apiBase,
    maxWaitSeconds: resolveMaxWaitSeconds(),
    version,
    walletConfigured,
    wallet: {
      getWallet: () => runtime.getWallet(),
      // Boot facts are thunks, not values: the wallet opens later, so a snapshot
      // frozen here would make wallet_status lie for the whole session. They read
      // the RESOLVER so a key created mid-session is reflected too.
      keyMode: () => resolveKeyMode(credentials.resolve()),
      // The WALLET's credential, not the resolver's: under the owner login the
      // resolver has a token the wallet does not take, and reporting it as
      // configured would route wallet_create_deposit past the didactic
      // api_key_required into the engine's generic message.
      apiKeyConfigured: () => walletCredential() !== undefined,
      bootResume: () => runtime.bootResume(),
      bootConversions: () => runtime.bootConversions(),
      maxWaitSeconds: resolveWalletMaxWaitSeconds(),
    },
    agentTools: buildAgentToolDeps({ resolver: credentials, apiBase, getWallet: () => runtime.getWallet() }),
  });

  const shutdown = createShutdownHandler({
    close: async () => {
      // server.close() also disposes the wallet tools' open SideSwap quote streams
      // (the engine wraps close() on whichever server it mounts onto).
      await server.close();
      await runtime.close();
    },
    exit: (code) => process.exit(code),
    logger: engineLogger,
  });

  const transport = sanitizeOutgoingSchemas(new StdioServerTransport());
  await server.connect(transport);
  // The host closing our stdin closes the transport → onclose → clean shutdown.
  server.server.onclose = () => shutdown(0);
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  logger.info("stdio_started", {
    version,
    tools: UNIFIED_TOOL_COUNT,
    api_key: apiKeyConfigured,
    wallet: walletConfigured,
    // "locked" vs "none": a support log has to separate "the operator never
    // logged in" from "the login is right here and this server could not open
    // it", which `api_key: false` alone reports as the same thing.
    owner_session: ownerVault,
    agent_credentials: agentVault,
  });
}

async function init(opts: { restore: boolean }): Promise<void> {
  // Loaded lazily: the ceremony pulls the whole wallet engine (seed store, LWK),
  // which the serve path must not pay for before a wallet tool is actually called.
  const { runWalletInit } = await import("./wallet-engine/mcp/init-flow.js");
  await runWalletInit({ restore: opts.restore, packageName: UNIFIED_PACKAGE_NAME });
}

async function backup(): Promise<void> {
  const { runWalletBackup } = await import("./wallet-engine/mcp/backup-flow.js");
  await runWalletBackup({ packageName: UNIFIED_PACKAGE_NAME });
}

/** The operator's own DePix login — an operator act at a terminal, not a tool. */
function login(opts: { provider?: "google" | "github" }): Promise<number> {
  return runOwnerLogin(buildOwnerLoginDeps({ write: stderr, ...(opts.provider ? { provider: opts.provider } : {}) }));
}

function logout(): Promise<number> {
  return runOwnerLogout(buildOwnerLogoutDeps(stderr));
}

function account(argv: readonly string[]): Promise<number> {
  return runAccountCommand(argv, buildAccountDeps(stderr));
}

runCli(process.argv.slice(2), {
  init,
  backup,
  login,
  logout,
  account,
  serve,
  write: stderr,
  version: resolveServerVersion(),
})
  .then((code) => {
    // serve() resolves only on shutdown, which exits through its own path; every
    // other command is finished here. Code 0 lets the process end naturally.
    if (code !== 0) process.exit(code);
  })
  .catch((err: unknown) => {
    // Redact defensively — a fatal error must never carry the key, the passphrase
    // or seed material.
    const message = err instanceof Error ? err.message : String(err);
    stderr(`depix-mcp: fatal error: ${message}\n`);
    process.exit(1);
  });
