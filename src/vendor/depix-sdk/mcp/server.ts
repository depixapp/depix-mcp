/*
 * Copyright 2026 DePix App
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at http://www.apache.org/licenses/LICENSE-2.0 — see LICENSE.
 *
 * VENDORED ENGINE SOURCE — DO NOT EDIT HERE.
 * Origin:    https://github.com/depixapp/depix-sdk
 * Commit:    6216f6ca88104ad1c2e5d3ae45b357a59d315312
 * Path:      src/mcp/server.ts
 * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)
 *
 * DePix App owns this code and distributes THIS copy under Apache-2.0. The
 * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing
 * from that published tarball is reused here (spec §2.2).
 */
// Local wallet MCP server factory (spec §6). Registers the MVP catalog of
// `wallet_*` tools (§6.2) on an McpServer bound to a single DepixWallet running
// in the AGENT's environment — the seed never leaves the machine (§6.1). Every
// tool call routes to the SAME wallet facade, so guardrails (§4), typed errors
// (§7) and persistence are shared; there is ZERO money logic in this layer.
//
// Naming (G10): every tool is prefixed `wallet_`, a set disjoint from the 16
// unprefixed tools of the remote @depixapp/mcp (F2), so a host can mount both
// servers side by side without collision — remote = receive/merchant/status
// reads, local = pay/sign.
//
// The catalog deliberately has NO tool that exports the mnemonic/seed/descriptor
// -with-keys, mutates guardrails, edits liquid_address/split_address, or pays a
// checkout QR (§6.2): no tool call — not even from a fully injected LLM — can
// reach the seed or raise a ceiling.
//
// TWO entry points (unified-MCP spec §1.5):
//   - registerWalletTools(server, ctx) mounts the 27 tools on an EXTERNALLY
//     provided McpServer — the unified `@depixapp/mcp` bin passes the gateway's
//     server so ONE server serves gateway + wallet. The wallet is resolved
//     LAZILY per call: with no wallet on the machine the tools stay MOUNTED and
//     every call returns the typed `wallet_not_configured` error naming the
//     `init` ceremony (§1(b) — a static catalog, never one that grows after
//     first-run: hosts snapshot tools/list at connect).
//   - createWalletMcpServer(opts) is the thin wrapper that builds THIS package's
//     own server (the published `depix-wallet-mcp` bin) on top of it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ConversionResumeSummary, ResumeSummary } from "../wallet.js";
import {
  ToolError,
  mapToolError,
  missingApiKeyError,
  resolveInitCommand,
  walletNotConfiguredError,
} from "./errors.js";
import { defaultLogger as logger } from "../logger.js";
import * as s from "./schemas.js";
import { MAX_WAIT_SECONDS_CEILING } from "./schemas.js";
import {
  buyGiftcardTool,
  convertTool,
  createDepositTool,
  createWithdrawalTool,
  diagnosticsTool,
  getAddressTool,
  getBalancesTool,
  getGiftcardOrderStatusTool,
  getGuardrailsTool,
  giftcardPriceTool,
  listGiftcardOrdersTool,
  listGiftcardProductsTool,
  listGiftcardsTool,
  listTransactionsTool,
  payLightningInvoiceTool,
  pendingTool,
  quoteTool,
  receiveLightningTool,
  recoverTool,
  sendTool,
  shiftUsdtTool,
  statusTool,
  swapExecuteTool,
  swapQuoteTool,
  toStablecoinTool,
  waitDepositTool,
  waitWithdrawalTool,
  type McpIntentArgs,
  type McpWalletFacade,
  type ToolContext,
} from "./tools.js";
import { SwapStreamRegistry } from "./swap-streams.js";
import type { StablecoinAsset } from "../convert/boltz/stablecoin.js";
import type { AssetKey } from "../assets.js";

export const SERVER_NAME = "com.depixapp/wallet";
export const SERVER_TITLE = "DePix Wallet";
export const DEFAULT_SERVER_VERSION = "1.0.0";

/**
 * The full catalog (§6.2), prefixed `wallet_` (G10). Exported for tests/docs.
 * The MVP 10 (PR8) plus the intent layer (wallet_quote / wallet_convert —
 * PR-B/PR-C, the PRIMARY conversion surface) plus the fast-follow conversions
 * + gift cards (PR8b) plus SideShift (PR5c) plus the recovery pair
 * (wallet_recover / wallet_pending — fund-safety wiring) plus
 * wallet_diagnostics (PR-D — read-only support snapshot) plus the gift-card
 * discovery reads (catalog / products / range-price / live order status) — 27
 * tools. wallet_shift_usdt (§5.4/G4) is the ONE all-custodial tool;
 * wallet_convert FLAGS custodial routes per call (G4 = documentation-signalled,
 * no gate).
 */
export const WALLET_TOOL_NAMES = [
  "wallet_status",
  "wallet_get_address",
  "wallet_get_balances",
  "wallet_list_transactions",
  "wallet_send",
  "wallet_create_deposit",
  "wallet_wait_deposit",
  "wallet_create_withdrawal",
  "wallet_wait_withdrawal",
  "wallet_get_guardrails",
  "wallet_quote",
  "wallet_convert",
  "wallet_swap_quote",
  "wallet_swap_execute",
  "wallet_pay_lightning_invoice",
  "wallet_receive_lightning",
  "wallet_to_stablecoin",
  "wallet_list_giftcards",
  "wallet_list_giftcard_products",
  "wallet_giftcard_price",
  "wallet_buy_giftcard",
  "wallet_list_giftcard_orders",
  "wallet_get_giftcard_order_status",
  "wallet_shift_usdt",
  "wallet_recover",
  "wallet_pending",
  "wallet_diagnostics",
] as const;

const WALLET_INSTRUCTION_SENTENCES = [
  "DePix Wallet MCP — a NON-CUSTODIAL Liquid wallet that signs locally, in the agent's own environment.",
  "The seed never leaves this machine: keys, passphrase and dataDir are configured via environment variables (DEPIX_API_KEY, DEPIX_WALLET_PASSPHRASE, DEPIX_WALLET_DIR, DEPIX_GUARDRAIL_*), never via tools.",
  "Money-moving tools (wallet_send, wallet_create_withdrawal, wallet_convert) pass through the owner's guardrails (per-tx + rolling-24h BRL caps, optional allowlist) BEFORE signing — the facade never bypasses them.",
  "wallet_convert is the PRIMARY conversion surface (asset/network conversions end to end, single- and multi-hop); wallet_quote enumerates the candidate routes with estimates. The provider-level tools (wallet_swap_*, wallet_to_stablecoin, wallet_shift_usdt, …) are the low-level escape hatch.",
  "Amounts carry their unit in the field name: amount_cents is BRL cents; amount_sats is the asset's base units (1 DePix cent = 1,000,000 sats). Never mix them.",
  "There is no tool to export the seed, change guardrails, or pay a merchant checkout QR — by design.",
  "wallet_create_deposit returns a Pix copy-and-paste the human OWNER pays; the agent has no bank.",
] as const;

/**
 * The wallet server's own MCP `instructions`, for a deployment that HAS a wallet.
 * Exported so a host that MOUNTS the wallet tools on its own server can merge
 * this text into its per-deployment instructions (unified spec §1.6).
 */
export const WALLET_MCP_INSTRUCTIONS = WALLET_INSTRUCTION_SENTENCES.join(" ");

/**
 * Build the wallet `instructions` for a specific deployment (§1.6). Every
 * sentence above is TRUE only once a wallet exists; the unified bin mounts the
 * tools before first-run, so `walletConfigured: false` appends the one sentence
 * that keeps the text honest — the tools are listed, they answer
 * `wallet_not_configured`, and the fix is a human running `init` at a terminal.
 */
export function walletMcpInstructions(
  opts: { initCommand?: string; walletConfigured?: boolean } = {},
): string {
  if (opts.walletConfigured === false) {
    return [
      ...WALLET_INSTRUCTION_SENTENCES,
      `NO wallet is configured on this deployment yet: every wallet_* tool is listed but returns the typed ` +
        `wallet_not_configured error until the human OPERATOR runs \`${resolveInitCommand(opts.initCommand)}\` ` +
        "in a terminal on this machine and restarts the server. That is a human ceremony, never a tool call — " +
        "the 12-word seed backup must never enter this conversation.",
    ].join(" ");
  }
  return WALLET_MCP_INSTRUCTIONS;
}

function ok(out: unknown): CallToolResult {
  return {
    // Full JSON in the text block, matching structuredContent — truncating would
    // hand hosts that only render `content` an invalid, cut-off document.
    content: [{ type: "text", text: JSON.stringify(out) }],
    structuredContent: out as Record<string, unknown>,
  };
}

function fail(err: ToolError): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: err.message },
      {
        type: "text",
        text: JSON.stringify({ error: { code: err.code, retryable: err.retryable, ...err.data } }),
      },
    ],
  };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const toolError = mapToolError(err);
    // Log only the code (never the raw message — it may echo untrusted upstream
    // text) so a bug surfaces without breaking the redaction boundary.
    if (toolError.code === "internal_error") {
      logger.error("tool_unexpected_error", { name: err instanceof Error ? err.name : "unknown" });
    }
    return fail(toolError);
  }
}

export interface CreateWalletMcpServerOptions {
  /** The wallet every tool calls (DepixWallet in prod; a fake in tests). */
  wallet: McpWalletFacade;
  /** Key mode derived from the sk_ prefix at boot (§6.2). "unknown" when no key. */
  keyMode?: "live" | "test" | "unknown";
  /** Whether an API key is configured (deposit/withdraw/wait need one). */
  apiKeyConfigured?: boolean;
  /** Crash-resume summary captured at boot (§3.2.9) — surfaced by wallet_status. */
  bootResume?: ResumeSummary;
  /** Conversion crash-resume summary captured at boot (§5) — surfaced by wallet_status. */
  bootConversions?: ConversionResumeSummary;
  /** Hard ceiling for the wait tools' timeout_seconds (§6.2d). Default 900. */
  maxWaitSeconds?: number;
  version?: string;
}

const EMPTY_RESUME: ResumeSummary = {
  resumed: 0,
  rebroadcast: 0,
  reposted: 0,
  discarded: 0,
  failed: 0,
};

const EMPTY_CONVERSIONS: ConversionResumeSummary = {
  boltz: null,
  pegin: { pending: 0, cleared: 0, failed: 0 },
  sideshift: { checked: 0, refreshed: 0, failed: 0 },
  plans: { checked: 0, advanced: 0, completed: 0, needsReview: 0, discarded: 0, failed: 0 },
};

/**
 * Lazy wallet resolution (unified spec §1.5).
 *
 * CONTRACT: called per tool invocation — never once at boot — so the mount is
 * legal before any wallet exists on the machine, and a wallet opened later is
 * picked up without re-registering anything. The registration MEMOIZES the
 * in-flight resolution: concurrent tool calls share ONE resolver run (two
 * parallel `DepixWallet.open()`s would race the dataDir lock and surface a
 * spurious WALLET_DIR_LOCKED). The memo is cleared as soon as it settles, so it
 * is a single-flight gate, not a cache — the host stays free to hand back a
 * different wallet on the next call. Returning null/undefined means "no wallet
 * here": the call answers with the typed `wallet_not_configured` error.
 */
export type WalletResolver = () =>
  | McpWalletFacade
  | null
  | undefined
  | Promise<McpWalletFacade | null | undefined>;

/**
 * A boot fact that is either FIXED at mount time or resolved per call. The
 * unified bin mounts before the wallet exists, so its resume summaries and key
 * state only become real after a later open(): passing a thunk keeps
 * wallet_status honest instead of freezing "nothing resumed" forever.
 */
export type MountedValue<T> = T | (() => T);

/** What registerWalletTools() needs: the wallet (eager OR lazy) + boot facts. */
export interface RegisterWalletToolsContext {
  /** A ready wallet, as the single-wallet stdio bin has. Mutually exclusive with `getWallet`. */
  wallet?: McpWalletFacade | null;
  /**
   * Lazy resolver — the unified/seedless path (§1(b)): the tools mount now and
   * this decides, per call, whether a wallet exists yet.
   * Mutually exclusive with `wallet`.
   */
  getWallet?: WalletResolver;
  /** Key mode derived from the sk_ prefix at boot (§6.2). "unknown" when no key. */
  keyMode?: MountedValue<"live" | "test" | "unknown">;
  /** Whether an API key is configured (deposit/withdraw/wait need one). */
  apiKeyConfigured?: MountedValue<boolean>;
  /** Crash-resume summary captured at boot (§3.2.9) — surfaced by wallet_status. */
  bootResume?: MountedValue<ResumeSummary>;
  /** Conversion crash-resume summary captured at boot (§5) — surfaced by wallet_status. */
  bootConversions?: MountedValue<ConversionResumeSummary>;
  /** Hard ceiling for the wait tools' timeout_seconds (§6.2d). Default 900. */
  maxWaitSeconds?: number;
  /**
   * The first-run command `wallet_not_configured` tells the model to ask the
   * operator for. Default `npx -y @depixapp/mcp init` — the unified bin passes
   * its own package name.
   */
  initCommand?: string;
}

/** Handle returned by registerWalletTools() for the MCP-layer teardown. */
export interface WalletToolsRegistration {
  /** The names registered on the server — WALLET_TOOL_NAMES, all 27. */
  readonly toolNames: readonly string[];
  /**
   * Dispose the MCP-layer resources these tools own (the open SideSwap quote
   * streams). Synchronous + idempotent. `server.close()` calls it too — this is
   * the explicit handle for a host that tears the mount down another way.
   */
  dispose(): void;
}

/**
 * Mount the 27 `wallet_*` tools on an EXISTING McpServer (unified spec §1.5).
 *
 * The tools are ALWAYS mounted, wallet or not: MCP hosts snapshot `tools/list`
 * at connect and `list_changed` support is uneven, so a catalog that grew after
 * `init` would mean "restart your client". A static catalog whose calls answer
 * with a typed, actionable `wallet_not_configured` is self-documenting to the
 * model instead (§1(b)).
 */
export function registerWalletTools(
  server: McpServer,
  context: RegisterWalletToolsContext = {},
): WalletToolsRegistration {
  if (context.wallet != null && context.getWallet !== undefined) {
    throw new TypeError("registerWalletTools: pass `wallet` OR `getWallet`, not both");
  }
  const getWallet: WalletResolver = context.getWallet ?? (() => context.wallet ?? null);
  const maxWaitSeconds = clampCeiling(context.maxWaitSeconds);

  // Boot facts are read PER CALL: on the unified mount the wallet (and therefore
  // its resume summaries and key state) only exists after a later open(), so a
  // context frozen here would make wallet_status lie for the life of the process.
  const toolContext = (): ToolContext => ({
    keyMode: resolveMounted(context.keyMode, "unknown"),
    apiKeyConfigured: resolveMounted(context.apiKeyConfigured, false),
    bootResume: resolveMounted(context.bootResume, EMPTY_RESUME),
    bootConversions: resolveMounted(context.bootConversions, EMPTY_CONVERSIONS),
  });

  // Single-flight resolution (see WalletResolver): concurrent tool calls share
  // one resolver run so a lazy open() cannot race itself into the dataDir lock.
  // Cleared on settle — success OR failure — so this stays a concurrency gate,
  // never a cache: a wallet that appears (or is replaced) later is still picked
  // up, and a failed open is retried on the next call instead of being pinned.
  let inFlight: Promise<McpWalletFacade | null | undefined> | null = null;
  const resolveWallet = async (): Promise<McpWalletFacade> => {
    if (inFlight === null) {
      const pending = (async () => getWallet())();
      inFlight = pending;
      const clear = (): void => {
        if (inFlight === pending) inFlight = null;
      };
      pending.then(clear, clear);
    }
    const resolved = await inFlight;
    if (!resolved) throw walletNotConfiguredError(context.initCommand);
    return resolved;
  };

  const runWallet = (
    fn: (wallet: McpWalletFacade, ctx: ToolContext) => Promise<unknown>,
  ): Promise<CallToolResult> => run(async () => fn(await resolveWallet(), toolContext()));

  // The tools that hit the DePix API (deposit/withdraw + their waits) short-circuit
  // with an ACTIONABLE api_key_required error when DEPIX_API_KEY is absent, instead
  // of letting the api client surface a generic auth/internal error — the agent
  // cannot set the key itself, so it needs the one-line remediation (§6.1). The
  // wallet gate comes FIRST: with no wallet at all, "run init" is the one true
  // next step, and an api-key hint would just send the operator down a dead end.
  const runKeyedWallet = (fn: (wallet: McpWalletFacade) => Promise<unknown>): Promise<CallToolResult> =>
    run(async () => {
      const wallet = await resolveWallet();
      if (!toolContext().apiKeyConfigured) throw missingApiKeyError();
      return fn(wallet);
    });

  // Holds the OPEN SideSwap quote streams that wallet_swap_quote creates and
  // wallet_swap_execute runs on (the quote_id is socket-bound). Unlike the Boltz
  // watches — which wallet.close() disposes (§5.3) — these streams are owned by
  // the MCP layer, so server.close() must tear them down: we wrap close() to
  // disposeAll() FIRST, so a shutdown with a quote in flight leaves no live socket
  // (the deferral-critical guarantee, §6.1). disposeAll() is synchronous, so it
  // never makes shutdown hang; the runtime hard-exit watchdog is the backstop.
  //
  // Why wrap close() rather than a cleaner hook: McpServer exposes no shutdown
  // callback for registry teardown, and the transport `onclose` (which the stdio
  // bin already consumes to TRIGGER shutdown) fires only on a host disconnect — a
  // programmatic server.close() (the bin's own shutdown path) would bypass it and
  // leak the sockets. Wrapping close() is the single choke point that covers BOTH
  // entry points. It is safe: disposeAll() is synchronous + idempotent + per-stream
  // try/caught, so it cannot throw, cannot hang the close, and double-close is a
  // no-op — if the SDK ever reaches shutdown through a path other than close(),
  // teardown regresses to the runtime hard-exit watchdog backstop, never a hang.
  //
  // On a MOUNT (registerWalletTools on a host's own server) the same wrap applies
  // to THAT server: the host keeps its own close() semantics and gets the stream
  // teardown for free; `dispose()` on the returned handle is the explicit escape
  // hatch for a host that tears the mount down without closing the server.
  const swapStreams = new SwapStreamRegistry();
  const baseClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    swapStreams.disposeAll();
    await baseClose();
  };

  const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
  const write: ToolAnnotations = { readOnlyHint: false, openWorldHint: true };
  const money: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

  server.registerTool(
    "wallet_status",
    {
      title: "Wallet status",
      description:
        "Read wallet operational status: key mode (live/test, derived locally from the sk_ prefix — no API call), " +
        "whether an API key is configured, whether the seed backup is confirmed, the current guardrail budget " +
        "(rolling-24h + per-tx caps and usage), and the crash-resume summaries from boot (pending withdrawals + " +
        "pending conversions). Moves no money.",
      inputSchema: s.statusInput,
      outputSchema: s.statusOutput,
      annotations: read,
    },
    () => runWallet((wallet, ctx) => statusTool(wallet, ctx)),
  );

  server.registerTool(
    "wallet_get_address",
    {
      title: "Get receive address",
      description:
        "Return a FRESH, unused Liquid receive address for this wallet (no on-chain reuse across calls). " +
        "Blocked with BACKUP_REQUIRED until the seed backup is exported and confirmed (§2.9). Moves no money.",
      inputSchema: s.getAddressInput,
      outputSchema: s.getAddressOutput,
      annotations: read,
    },
    (args) => runWallet((wallet) => getAddressTool(wallet, args as { index?: number })),
  );

  server.registerTool(
    "wallet_get_balances",
    {
      title: "Get balances",
      description:
        "Return confirmed on-chain balances for DePix, L-BTC and USDt in base units (sats, as strings), plus a total " +
        "BRL-cent estimate (null if a needed quote is unavailable). Moves no money.",
      inputSchema: s.getBalancesInput,
      outputSchema: s.getBalancesOutput,
      annotations: read,
    },
    () => runWallet((wallet) => getBalancesTool(wallet)),
  );

  server.registerTool(
    "wallet_list_transactions",
    {
      title: "List transactions",
      description:
        "Return the wallet's transaction history (txid, height, timestamp, type, network fee and per-asset balance " +
        "deltas in base units). Moves no money.",
      inputSchema: s.listTransactionsInput,
      outputSchema: s.listTransactionsOutput,
      annotations: read,
    },
    () => runWallet((wallet) => listTransactionsTool(wallet)),
  );

  server.registerTool(
    "wallet_send",
    {
      title: "Send Liquid asset",
      description:
        "Sign and broadcast a Liquid send of DePix/L-BTC/USDt to an address. amount_sats is BASE UNITS. " +
        "MOVES MONEY: passes through the owner's guardrails (per-tx + rolling-24h BRL caps; allowlist if enabled) " +
        "BEFORE signing. Irreversible once broadcast.",
      inputSchema: s.sendInput,
      outputSchema: s.sendOutput,
      annotations: money,
    },
    (args) =>
      runWallet((wallet) => sendTool(wallet, args as { asset: "DEPIX" | "LBTC" | "USDT"; amount_sats: string; address: string })),
  );

  server.registerTool(
    "wallet_create_deposit",
    {
      title: "Create Pix deposit",
      description:
        "Create a Pix deposit charge, returning a copy-and-paste (BR Code) the human OWNER pays to fund this wallet " +
        "with DePix. amount_cents is BRL cents; payer_tax_number is the PAYER's CPF/CNPJ. Not a checkout QR. " +
        "Creates a charge but moves no money itself.",
      inputSchema: s.createDepositInput,
      outputSchema: s.createDepositOutput,
      annotations: write,
    },
    (args) => runKeyedWallet((wallet) => createDepositTool(wallet, args as { amount_cents: number; payer_tax_number: string })),
  );

  server.registerTool(
    "wallet_wait_deposit",
    {
      title: "Wait for deposit",
      description:
        "Poll a deposit until it reaches a terminal status (success is depix_sent). Bounded by timeout_seconds " +
        `(default ${s.DEFAULT_WAIT_SECONDS}, hard ceiling ${MAX_WAIT_SECONDS_CEILING}). Moves no money.`,
      inputSchema: s.waitInput(maxWaitSeconds),
      outputSchema: s.statusReadOutput,
      annotations: read,
    },
    (args) =>
      runKeyedWallet((wallet) =>
        waitDepositTool(
          wallet,
          args as { id: string; interval_seconds?: number; timeout_seconds?: number },
          maxWaitSeconds,
        ),
      ),
  );

  server.registerTool(
    "wallet_create_withdrawal",
    {
      title: "Create Pix withdrawal",
      description:
        "Withdraw to a Pix key: build ONE Liquid transaction (Eulen output + explicit fee output), sign and broadcast. " +
        "amount_cents is BRL cents; mode `send` = the DePix you send, `payout` = the BRL the recipient receives; " +
        "recipient_tax_number is the DESTINATION Pix key holder's CPF/CNPJ. MOVES MONEY: passes through guardrails on " +
        "the GROSS before signing. Irreversible once broadcast.",
      inputSchema: s.createWithdrawalInput,
      outputSchema: s.createWithdrawalOutput,
      annotations: money,
    },
    (args) =>
      runKeyedWallet((wallet) =>
        createWithdrawalTool(
          wallet,
          args as {
            pix_key: string;
            recipient_tax_number: string;
            amount_cents: number;
            mode: "send" | "payout";
          },
        ),
      ),
  );

  server.registerTool(
    "wallet_wait_withdrawal",
    {
      title: "Wait for withdrawal",
      description:
        "Poll a withdrawal until terminal (success is sent; sandbox is confirmed). Bounded by timeout_seconds " +
        `(default ${s.DEFAULT_WAIT_SECONDS}, hard ceiling ${MAX_WAIT_SECONDS_CEILING}). Moves no money.`,
      inputSchema: s.waitInput(maxWaitSeconds),
      outputSchema: s.statusReadOutput,
      annotations: read,
    },
    (args) =>
      runKeyedWallet((wallet) =>
        waitWithdrawalTool(
          wallet,
          args as { id: string; interval_seconds?: number; timeout_seconds?: number },
          maxWaitSeconds,
        ),
      ),
  );

  server.registerTool(
    "wallet_get_guardrails",
    {
      title: "Get guardrails",
      description:
        "Read the owner's guardrail config and current rolling-24h usage (caps in BRL cents, used, remaining, whether " +
        "the allowlist is on). Read-only — guardrails are immutable at runtime and no tool can change them (G9).",
      inputSchema: s.getGuardrailsInput,
      outputSchema: s.getGuardrailsOutput,
      annotations: read,
    },
    () => runWallet((wallet) => getGuardrailsTool(wallet)),
  );

  // ── intent layer (PR-B/PR-C): the PRIMARY conversion surface. Client-direct
  // providers — NOT gated on DEPIX_API_KEY. ──

  server.registerTool(
    "wallet_quote",
    {
      title: "Quote conversion routes",
      description:
        "Enumerate EVERY candidate conversion route for an intent — from/to asset (DEPIX, USDT, LBTC, BTC, USDC) " +
        "plus destination network — with per-leg fee/receipt estimates, single-hop AND multi-hop, custodial legs " +
        "flagged. The SDK never ranks or picks: compare the candidates and pass your chosen route id to " +
        "wallet_convert (the primary conversion surface). amount_sats is the FROM asset's BASE UNITS. Estimates " +
        "are best-effort (null + a note when a leg cannot be pre-estimated). Opens short-lived provider quote " +
        "streams but signs nothing — moves no money.",
      inputSchema: s.walletQuoteInput,
      outputSchema: s.walletQuoteOutput,
      annotations: write,
    },
    (args) => runWallet((wallet) => quoteTool(wallet, args as unknown as McpIntentArgs)),
  );

  server.registerTool(
    "wallet_convert",
    {
      title: "Convert (primary surface)",
      description:
        "THE PRIMARY conversion surface — converts between assets/networks end to end (e.g. DEPIX→LBTC, " +
        "LBTC→BTC@lightning, DEPIX→USDT@ethereum) in ONE call; prefer it over the low-level provider tools " +
        "(wallet_swap_*, wallet_to_stablecoin, wallet_shift_usdt). Executes exactly ONE route: single-hop " +
        "directly, multi-hop legs sequentially behind a crash-safe persisted plan (wallet_recover resumes after " +
        "any interruption). MOVES MONEY: every money-moving leg passes through the owner's guardrails BEFORE " +
        "signing; routes transiting a custodial provider return custodial:true. If several candidate routes " +
        "resolve the intent, the call fails with MULTIPLE_ROUTES_AVAILABLE and the candidates in " +
        "error.data.routes — call wallet_quote and pass `route`. Outbound cross-network routes need `address` " +
        "(or `invoice` for lightning). Waits for settlement by default; on timeout it returns status pending " +
        "with a next_step — funds in flight are never lost. amount_sats is the FROM asset's BASE UNITS.",
      inputSchema: s.walletConvertInput,
      outputSchema: s.walletConvertOutput,
      annotations: money,
    },
    (args) =>
      runWallet((wallet) =>
        convertTool(
          wallet,
          args as unknown as McpIntentArgs & {
            route?: string;
            address?: string;
            invoice?: string;
            refund_address?: string;
            wait?: boolean;
            timeout_seconds?: number;
          },
        ),
      ),
  );

  // ── fast-follow: conversions + gift cards (§6.2 fast-follow, §5). Client-direct
  // providers (SideSwap/Boltz/CryptoRefills) — NOT gated on DEPIX_API_KEY. ──

  server.registerTool(
    "wallet_swap_quote",
    {
      title: "Quote a SideSwap market swap",
      description:
        "Get a live SideSwap market-swap quote between DePix, L-BTC and USDt (NON-custodial — the swap pays back into " +
        "your OWN wallet). Returns a single-use swap_quote_id to pass to wallet_swap_execute before expires_at_ms. " +
        "amount_sats and the quoted amounts are BASE UNITS. Opens a short-lived quote socket held server-side until you " +
        "execute, it expires, or the server shuts down. Moves no money by itself.",
      inputSchema: s.swapQuoteInput,
      outputSchema: s.swapQuoteOutput,
      annotations: write,
    },
    (args) =>
      runWallet((wallet) =>
        swapQuoteTool(
          wallet,
          swapStreams,
          args as { from: AssetKey; to: AssetKey; amount_sats: string; timeout_seconds?: number },
        ),
      ),
  );

  server.registerTool(
    "wallet_swap_execute",
    {
      title: "Execute a SideSwap quote",
      description:
        "Execute a quote from wallet_swap_quote by its swap_quote_id (must run before the quote expires). MOVES MONEY: " +
        "validates the swap PSET pays your own receive address, signs, and lets SideSwap broadcast. Passes the SENT side " +
        "through the owner's value guardrails BEFORE signing (market swaps are allowlist-exempt — funds return to your " +
        "wallet). Irreversible once broadcast.",
      inputSchema: s.swapExecuteInput,
      outputSchema: s.swapExecuteOutput,
      annotations: money,
    },
    // Runs off the stream registry, not the wallet — but it is still gated on the
    // wallet: a swap_quote_id can only exist if a wallet was open when
    // wallet_swap_quote ran, so with no wallet the honest answer is the actionable
    // wallet_not_configured, not "unknown quote id".
    (args) => runWallet(() => swapExecuteTool(swapStreams, args as { swap_quote_id: string })),
  );

  server.registerTool(
    "wallet_pay_lightning_invoice",
    {
      title: "Pay a Lightning invoice",
      description:
        "Pay a BOLT11 Lightning invoice by locking L-BTC via a Boltz submarine swap (NON-custodial; L-BTC only, never " +
        "DePix). MOVES MONEY: the L-BTC lockup passes through the owner's guardrails (value caps; the Lightning payee is " +
        "checked against the allowlist when it is enabled) BEFORE signing. Returns once the lockup is broadcast; Boltz " +
        "then pays the invoice, or the lockup auto-refunds on failure (watched in the background, cancelled cleanly on " +
        "shutdown). Amounts are base units (sats).",
      inputSchema: s.payLightningInvoiceInput,
      outputSchema: s.payLightningInvoiceOutput,
      annotations: money,
    },
    (args) => runWallet((wallet) => payLightningInvoiceTool(wallet, args as { invoice: string })),
  );

  server.registerTool(
    "wallet_receive_lightning",
    {
      title: "Receive over Lightning",
      description:
        "Receive over Lightning INTO this wallet via a Boltz reverse swap (NON-custodial). Returns a BOLT11 invoice for " +
        "a payer to pay; once paid, the L-BTC is claimed into your wallet in the background (watched, cancelled cleanly " +
        "on shutdown). An INFLOW — no guardrail. amount_sats is base units.",
      inputSchema: s.receiveLightningInput,
      outputSchema: s.receiveLightningOutput,
      annotations: write,
    },
    (args) => runWallet((wallet) => receiveLightningTool(wallet, args as { amount_sats: string })),
  );

  server.registerTool(
    "wallet_to_stablecoin",
    {
      title: "Convert L-BTC to USDC/USDT",
      description:
        "Convert L-BTC to USDC/USDT delivered to an external EVM or Tron address via a Boltz chain swap (NON-custodial " +
        "on the Liquid side; the L-BTC lockup is refundable). MOVES MONEY: the L-BTC lockup passes through the owner's " +
        "guardrails (value caps; the destination claim_address is checked against the allowlist when it is enabled) " +
        "BEFORE signing. The EVM legs run in the background after funding. amount_sats is L-BTC base units.",
      inputSchema: s.toStablecoinInput,
      outputSchema: s.toStablecoinOutput,
      annotations: money,
    },
    (args) =>
      runWallet((wallet) =>
        toStablecoinTool(
          wallet,
          args as { asset: StablecoinAsset; network_id: string; amount_sats: string; claim_address: string },
        ),
      ),
  );

  server.registerTool(
    "wallet_list_giftcards",
    {
      title: "List gift-card brands (catalog)",
      description:
        "Browse the CryptoRefills catalog for a country: the fulfillable brands (gift cards + mobile top-ups), filtered " +
        "by `query` (brand/family name) and/or `category`, in-stock first, plus the popular picks and the category keys. " +
        "The first step of a purchase (brand discovery) — feed a brand into wallet_list_giftcard_products. Gated on the " +
        "operator's giftcardEnabled toggle (GIFTCARDS_DISABLED when off). Read-only, moves no money.",
      inputSchema: s.listGiftcardsInput,
      outputSchema: s.listGiftcardsOutput,
      annotations: read,
    },
    (args) => runWallet((wallet) => listGiftcardsTool(wallet, args as { country_code?: string; query?: string; category?: string })),
  );

  server.registerTool(
    "wallet_list_giftcard_products",
    {
      title: "List a brand's denominations/products",
      description:
        "List a brand's products/denominations so you can complete the selection: each entry says whether it is a FIXED " +
        "denomination (buy with its exact `denomination` string; `price_sats` is the BTC cost) or a DYNAMIC range " +
        "product (is_dynamic:true — buy with denomination \"range\" + a `product_value` within `min`..`max`; quote a " +
        "specific value with wallet_giftcard_price). Returns the FULL list (fixed AND range). Gated on giftcardEnabled. " +
        "Read-only, moves no money.",
      inputSchema: s.listGiftcardProductsInput,
      outputSchema: s.listGiftcardProductsOutput,
      annotations: read,
    },
    (args) => runWallet((wallet) => listGiftcardProductsTool(wallet, args as { brand_name: string; country_code?: string })),
  );

  server.registerTool(
    "wallet_giftcard_price",
    {
      title: "Price a custom gift-card value",
      description:
        "Quote the BTC cost (in sats) of a CUSTOM value for a DYNAMIC (range) product before buying — GET " +
        "/v4/products/price. Use for is_dynamic products (from wallet_list_giftcard_products) whose value you choose " +
        "within min..max; fixed products already carry their `price_sats`. Gated on giftcardEnabled. Read-only, moves " +
        "no money.",
      inputSchema: s.giftcardPriceInput,
      outputSchema: s.giftcardPriceOutput,
      annotations: read,
    },
    (args) =>
      runWallet((wallet) =>
        giftcardPriceTool(wallet, args as { brand_name: string; country_code?: string; face_value: string | number }),
      ),
  );

  server.registerTool(
    "wallet_buy_giftcard",
    {
      title: "Buy a gift card",
      description:
        "Buy a gift card or mobile top-up from CryptoRefills and pay it over Lightning via Boltz (NON-custodial). " +
        "Discover `brand_name` with wallet_list_giftcards, then `denomination` with wallet_list_giftcard_products: " +
        "pass the exact denomination string for a FIXED product, or \"range\" + `product_value` for a DYNAMIC one " +
        "(wallet_list_giftcard_products tells you which, plus the min/max; wallet_giftcard_price quotes a custom value). " +
        "MOVES MONEY: the L-BTC lockup passes through the owner's guardrails (value caps; with the allowlist on, BOTH the " +
        "Lightning payee AND the gift-card beneficiary must be opted in) BEFORE signing, plus a 1% DePix service fee. " +
        "Delivery goes to `email` (or beneficiary_account) — poll wallet_get_giftcard_order_status for the phase + " +
        "redemption code/URL. Returns once the lockup is broadcast; Boltz then pays the invoice in the background. " +
        "Amounts are base units (sats).",
      inputSchema: s.buyGiftcardInput,
      outputSchema: s.buyGiftcardOutput,
      annotations: money,
    },
    (args) =>
      runWallet((wallet) =>
        buyGiftcardTool(
          wallet,
          args as {
            brand_name: string;
            denomination: string;
            email: string;
            beneficiary_account?: string;
            country_code?: string;
            product_value?: string;
            quantity?: number;
            validate?: boolean;
          },
        ),
      ),
  );

  server.registerTool(
    "wallet_list_giftcard_orders",
    {
      title: "List gift-card orders",
      description:
        "List the locally tracked gift-card orders (newest first): order id, brand, denomination, beneficiary, amounts " +
        "and last-known phase. Read-only — no network, no config gate. Moves no money.",
      inputSchema: s.listGiftcardOrdersInput,
      outputSchema: s.listGiftcardOrdersOutput,
      annotations: read,
    },
    () => runWallet((wallet) => listGiftcardOrdersTool(wallet)),
  );

  server.registerTool(
    "wallet_get_giftcard_order_status",
    {
      title: "Get live gift-card order status",
      description:
        "Poll one order's LIVE status at CryptoRefills and fold it into the local log: returns the `phase`, a `terminal` " +
        "flag (stop polling once true), and the `delivery` — the redemption code or URL once the order reaches " +
        "'delivered'. Use after wallet_buy_giftcard to retrieve the gift card. Read-only, no config gate, moves no money.",
      inputSchema: s.getGiftcardOrderStatusInput,
      outputSchema: s.getGiftcardOrderStatusOutput,
      annotations: read,
    },
    (args) => runWallet((wallet) => getGiftcardOrderStatusTool(wallet, args as { order_id: string })),
  );

  server.registerTool(
    "wallet_shift_usdt",
    {
      title: "Shift USDt cross-network (SideShift — CUSTODIAL)",
      description:
        "Send USDt from Liquid to another network (Ethereum, Tron, BNB Smart Chain, Polygon, Solana) via SideShift. " +
        "*** CUSTODIAL ***: this is the ONE flow where funds LEAVE the non-custodial sphere — you send USDt to " +
        "SideShift's deposit address and THEY pay out from their reserve on the target network (escrow states, " +
        "possible review/refund). MOVES MONEY: the USDt send passes through the owner's guardrails (value caps; with " +
        "the allowlist on, BOTH the destination settle_address AND the refund_address must be opted in) BEFORE signing. " +
        "amount_sats is USDt BASE UNITS. Irreversible once broadcast; the result carries custodial:true.",
      inputSchema: s.shiftUsdtInput,
      outputSchema: s.shiftUsdtOutput,
      annotations: money,
    },
    (args) =>
      runWallet((wallet) =>
        shiftUsdtTool(
          wallet,
          args as { network: string; amount_sats: string; settle_address: string; refund_address?: string },
        ),
      ),
  );

  // ── recovery wiring (fund-safety): re-drive every rail + unified pending view ──

  server.registerTool(
    "wallet_recover",
    {
      title: "Recover everything pending",
      description:
        "Re-run crash recovery for EVERYTHING pending, across all rails: re-broadcast/re-POST pending Pix " +
        "withdrawals (SAME signed bytes / SAME Idempotency-Key — never a double-pay), reconcile in-flight Boltz " +
        "swaps (re-attach the watch, claim, or refund the L-BTC lockup), reconcile the tracked SideSwap peg-in, " +
        "and refresh non-terminal SideShift shifts. Idempotent and safe to call repeatedly; it also runs " +
        "automatically at boot. It only completes or refunds PREVIOUSLY authorized operations — it never starts " +
        "a new payment. Returns per-rail counts; see wallet_pending for what is currently in flight.",
      inputSchema: s.recoverInput,
      outputSchema: s.recoverOutput,
      annotations: write,
    },
    () => runWallet((wallet) => recoverTool(wallet)),
  );

  server.registerTool(
    "wallet_pending",
    {
      title: "List everything in flight",
      description:
        "List everything currently IN FLIGHT across the wallet's four durable stores: pending Pix withdrawals, " +
        "in-flight Boltz swaps (Lightning send/receive and stablecoin), the tracked SideSwap peg-in, and " +
        "non-terminal SideShift shifts. Each item carries rail, id, state and rail-specific fields. Read-only " +
        "and local (no network, no signing) — use wallet_recover to re-drive these items. Moves no money.",
      inputSchema: s.pendingInput,
      outputSchema: s.pendingOutput,
      annotations: read,
    },
    () => runWallet((wallet) => pendingTool(wallet)),
  );

  // ── maintenance/support: read-only health snapshot (PR-D) ──

  server.registerTool(
    "wallet_diagnostics",
    {
      title: "Wallet diagnostics",
      description:
        "Read a health snapshot for support/debugging: SDK + LWK versions, data dir, backup state, sync health " +
        "(last scan/success and the last update-persist failure), per-rail pending counters, and the guardrail " +
        "budget. Read-only and local (no network, no signing) and carries NO key material — never the seed, " +
        "mnemonic or descriptor. Moves no money.",
      inputSchema: s.diagnosticsInput,
      outputSchema: s.diagnosticsOutput,
      annotations: read,
    },
    () => runWallet((wallet) => diagnosticsTool(wallet)),
  );

  return {
    toolNames: WALLET_TOOL_NAMES,
    dispose: () => swapStreams.disposeAll(),
  };
}

/**
 * Build THIS package's own wallet MCP server (the published `depix-wallet-mcp`
 * bin, §6.1). Thin wrapper: it owns the server identity + instructions and
 * delegates every tool to registerWalletTools — behaviour is unchanged from
 * before the mount API existed.
 */
export function createWalletMcpServer(opts: CreateWalletMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: opts.version ?? DEFAULT_SERVER_VERSION },
    { instructions: WALLET_MCP_INSTRUCTIONS },
  );
  registerWalletTools(server, {
    wallet: opts.wallet,
    keyMode: opts.keyMode,
    apiKeyConfigured: opts.apiKeyConfigured,
    bootResume: opts.bootResume,
    bootConversions: opts.bootConversions,
    maxWaitSeconds: opts.maxWaitSeconds,
  });
  return server;
}

/** Read a mount-time-or-per-call boot fact (see MountedValue). */
function resolveMounted<T>(value: MountedValue<T> | undefined, fallback: T): T {
  if (typeof value === "function") return (value as () => T)();
  return value ?? fallback;
}

function clampCeiling(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return MAX_WAIT_SECONDS_CEILING;
  return Math.min(Math.floor(value), MAX_WAIT_SECONDS_CEILING);
}
