/*
 * Copyright 2026 DePix App
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at http://www.apache.org/licenses/LICENSE-2.0 — see LICENSE.
 *
 * VENDORED ENGINE SOURCE — DO NOT EDIT HERE.
 * Origin:    https://github.com/depixapp/depix-sdk
 * Commit:    20b0765ca529f9e38b0de20b0c3265a5c9a8dc58
 * Path:      src/mcp/index.ts
 * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)
 *
 * DePix App owns this code and distributes THIS copy under Apache-2.0. The
 * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing
 * from that published tarball is reused here (spec §2.2).
 */
// Local wallet MCP facade (spec §6) — public surface for programmatic embedding.
// The stdio bin (`depix-wallet-mcp`) is src/mcp/stdio.ts; this barrel lets a host
// build the same server in-process (e.g. to mount it on its own transport), MOUNT
// the 27 tools on a server it already owns (registerWalletTools — the unified
// `@depixapp/mcp` bin, §1.5), and run the first-run ceremony (runWalletInit).

export {
  createWalletMcpServer,
  registerWalletTools,
  walletMcpInstructions,
  WALLET_TOOL_NAMES,
  WALLET_MCP_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_TITLE,
  DEFAULT_SERVER_VERSION,
  type CreateWalletMcpServerOptions,
  type MountedValue,
  type RegisterWalletToolsContext,
  type WalletResolver,
  type WalletToolsRegistration,
} from "./server.js";

export {
  ToolError,
  mapToolError,
  missingApiKeyError,
  resolveInitCommand,
  walletNotConfiguredError,
  AUTO_RETRY_CODES,
  DEFAULT_WALLET_INIT_COMMAND,
  SCOPES,
  type Scope,
} from "./errors.js";

// ─── first-run ceremony (§1.5) — `init`, a human act, never an MCP tool ──────
export {
  runWalletInit,
  renderWalletMcpConfigBlock,
  createTtyInitIo,
  defaultInitWalletBackend,
  detectSharedTerminalMarkers,
  generateStrongPassphrase,
  DEFAULT_MCP_PACKAGE,
  DEFAULT_MCP_SERVER_KEY,
  PASSPHRASE_PLACEHOLDER,
  type InitWallet,
  type InitWalletBackend,
  type RunWalletInitOptions,
  type WalletInitAction,
  type WalletInitIo,
  type WalletInitResult,
} from "./init-flow.js";

export {
  type McpWalletFacade,
  type McpConvertFacade,
  type McpBoltzFacade,
  type McpGiftcardsFacade,
  type ToolContext,
} from "./tools.js";

export {
  SwapStreamRegistry,
  ABANDON_GRACE_MS,
  type McpSwapFacade,
  type McpSwapQuoteStream,
} from "./swap-streams.js";

export {
  MAX_WAIT_SECONDS_CEILING,
  DEFAULT_WAIT_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  SEND_ASSETS,
  SWAP_QUOTE_DEFAULT_WAIT_SECONDS,
  SWAP_QUOTE_MAX_WAIT_SECONDS,
  STABLECOIN_ASSETS,
  STABLECOIN_NETWORK_IDS,
} from "./schemas.js";

export {
  resolveKeyMode,
  resolveMaxWaitSeconds,
  createShutdownHandler,
} from "./runtime.js";
