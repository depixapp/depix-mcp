#!/usr/bin/env node
// The UNIFIED local bin — `npx -y @depixapp/mcp` (unified-MCP spec §1).
//
// One process, one server, 49 tools: the 22 gateway tools (a pure client of the
// public DePix App API) plus the 27 `wallet_*` tools of the non-custodial Liquid
// wallet, which signs HERE, in the operator's own environment. Custody is decided
// by who holds the seed, not by the transport — so this deployment is the one that
// can hold one, and mcp.depixapp.com structurally cannot (§2.1).
//
// THREE-STATE BOOT (§1(b)) — it never exits over missing configuration:
//   - no DEPIX_API_KEY: the API-backed tools return the typed `missing_api_key`.
//     (BEHAVIOUR CHANGE from 1.x, which exited 1: an operator running only the
//     wallet half has no gateway key, and refusing to boot would deny them all 27
//     wallet tools over a credential they do not need.)
//   - no wallet on the machine: every wallet_* tool returns the typed
//     `wallet_not_configured` naming `npx -y @depixapp/mcp init`.
//   - both present: all 49 work.
// The catalog is ALWAYS 49 — MCP hosts snapshot tools/list at connect and
// `list_changed` support is uneven, so a catalog that grew after `init` would mean
// "restart your client".
//
// STDOUT is the JSON-RPC channel; every human byte goes to STDERR, redacted.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCli } from "./cli.js";
import { resolveApiBase, resolveMaxWaitSeconds, resolveServerVersion } from "./config.js";
import { UNIFIED_INIT_COMMAND } from "./instructions.js";
import { logger, redact } from "./log.js";
import { sanitizeOutgoingSchemas } from "./schemaDialect.js";
import {
  UNIFIED_PACKAGE_NAME,
  UNIFIED_TOOL_COUNT,
  createUnifiedServer,
  createWalletRuntime,
  isWalletConfigured,
  resolveWalletDir,
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
  const apiKey = process.env.DEPIX_API_KEY;
  const apiKeyConfigured = Boolean(apiKey && apiKey.startsWith("sk_"));
  const walletDir = resolveWalletDir();
  const walletConfigured = await isWalletConfigured(walletDir);

  if (!apiKeyConfigured) {
    stderr(
      "depix-mcp: no DEPIX_API_KEY (sk_test_… sandbox / sk_live_… production). Serving anyway — the tools that call the " +
        "DePix App API return a missing_api_key error until it is set.\n",
    );
  }
  if (!walletConfigured) {
    stderr(
      `depix-mcp: no wallet in ${walletDir}. Serving anyway — the 27 wallet_* tools are listed and return ` +
        `wallet_not_configured until you run \`${UNIFIED_INIT_COMMAND}\` in a terminal.\n`,
    );
  }

  // The wallet — and with it the LWK wasm engine — is loaded ONLY on the first
  // wallet tool call: `DepixWallet` arrives through a dynamic import inside the
  // resolver, so a gateway-only operator pays nothing for the wallet half. Both
  // auto-resumes are disabled so the runtime runs them explicitly and can surface
  // their summaries through wallet_status, exactly as the engine's own bin does.
  const runtime = createWalletRuntime({
    open: async () => {
      const { DepixWallet } = await import("./wallet-engine/wallet.js");
      return DepixWallet.open({
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false,
      });
    },
    onError: (event, err) => logger.error(event, { name: err instanceof Error ? err.name : "unknown" }),
  });

  const version = resolveServerVersion();
  const { server } = createUnifiedServer({
    apiKey,
    apiBase: resolveApiBase(),
    maxWaitSeconds: resolveMaxWaitSeconds(),
    version,
    walletConfigured,
    wallet: {
      getWallet: () => runtime.getWallet(),
      // Boot facts are thunks, not values: the wallet opens later, so a snapshot
      // frozen here would make wallet_status lie for the whole session.
      keyMode: () => resolveKeyMode(apiKey),
      apiKeyConfigured: () => apiKeyConfigured,
      bootResume: () => runtime.bootResume(),
      bootConversions: () => runtime.bootConversions(),
      maxWaitSeconds: resolveWalletMaxWaitSeconds(),
    },
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
  });
}

async function init(opts: { restore: boolean }): Promise<void> {
  // Loaded lazily: the ceremony pulls the whole wallet engine (seed store, LWK),
  // which the serve path must not pay for before a wallet tool is actually called.
  const { runWalletInit } = await import("./wallet-engine/mcp/init-flow.js");
  await runWalletInit({ restore: opts.restore, packageName: UNIFIED_PACKAGE_NAME });
}

runCli(process.argv.slice(2), { init, serve, write: stderr, version: resolveServerVersion() })
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
