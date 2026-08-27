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
