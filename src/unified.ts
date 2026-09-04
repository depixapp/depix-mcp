// The UNIFIED deployment: the 26 gateway tools AND the 29 `wallet_*` tools on ONE
// McpServer (unified-MCP spec §1). Reachable ONLY from the stdio bin — `api/mcp.ts`
// must never import this module, and scripts/check-hosted-isolation.mjs fails CI if
// it ever does, because everything below drags the wallet engine in.
//
// THREE-STATE, not binary (§1(b)). All 62 tools are mounted unconditionally:
//   - api key + seed   -> all 62 work;
//   - api key, no seed -> the 26 gateway tools work; each wallet_* answers with the
//                         typed `wallet_not_configured` error naming `init`;
//   - seed, no api key -> the wallet works; the API-backed tools answer with the
//                         typed `missing_api_key` error.
// Boot NEVER fails on a missing seed or a missing key. A catalog that grew after
// `init` would mean "restart your client": MCP hosts snapshot tools/list at connect
// and `list_changed` support is uneven, so a static 62 + typed errors is the design.
//
// The wallet is opened LAZILY, on the first wallet tool call, and the engine's
// registration single-flights concurrent resolutions so two parallel calls cannot
// race each other into the dataDir lock. Seedless operators therefore never pay the
// wasm/LWK load at all: `DepixWallet` arrives through a dynamic import inside the
// resolver, so `npx @depixapp/mcp` with only an API key boots as fast as before.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { UNIFIED_SERVER_TITLE, isAllowedApiOrigin } from "./config.js";
import { UNIFIED_INIT_COMMAND, UNIFIED_RUN_COMMAND, gatewaySentences } from "./instructions.js";
import { createServer, GATEWAY_TOOL_COUNT, type CreateServerOptions } from "./server.js";
import { AGENT_TOOL_NAMES, registerAgentTools, type AgentToolDeps } from "./agent-tools.js";
import {
  WALLET_TOOL_NAMES,
  registerWalletTools,
  walletMcpInstructions,
  type RegisterWalletToolsContext,
  type WalletToolsRegistration,
} from "./wallet-engine/mcp/server.js";
import { SeedStore } from "./wallet-engine/store/seed-store.js";
import type { ConversionResumeSummary, ResumeSummary } from "./wallet-engine/wallet.js";
import type { ResolvedCredential } from "./credentials.js";
import type { McpWalletFacade } from "./wallet-engine/mcp/tools.js";

/** npm package name the printed config block and the `init` guidance name. */
export const UNIFIED_PACKAGE_NAME = "@depixapp/mcp";

/**
 * The full unified catalog (§3.6): 26 gateway + 29 wallet + 7 agent-local = 62.
 * The closed-sum invariant: full = gateway + wallet + agent_local. Derived from
 * the three source-of-truth counts, never a bare literal, so adding a tool in one
 * place updates it here.
 */
export const UNIFIED_TOOL_COUNT = GATEWAY_TOOL_COUNT + WALLET_TOOL_NAMES.length + AGENT_TOOL_NAMES.length;

/**
 * The unified `instructions` (§1.6). Two things it must do that the hosted text
 * must not: describe 62 tools, and NEVER carry the hosted-only sentence "it never
 * signs, never holds funds, and never stores your key" — false the moment a
 * wallet_* tool exists on this server, and actively misleading to the model.
 *
 * The wallet half is the ENGINE's own text (walletMcpInstructions), so the
 * guardrail/custody wording stays authored in exactly one place; passing
 * `walletConfigured: false` appends the engine's "run init first" sentence.
 */
export function unifiedInstructions(opts: { walletConfigured: boolean }): string {
  return [
    ...gatewaySentences("unified"),
    "This deployment runs LOCALLY on the operator's own machine (`" +
      UNIFIED_RUN_COMMAND +
      "`). The 26 gateway tools are a pure client of the DePix App API; the 29 wallet_* tools are a NON-CUSTODIAL Liquid wallet " +
      "that signs in this process with a seed that never leaves this machine — the DePix App backend never sees it and cannot sign for it.",
    withoutEngineLede(walletMcpInstructions({ initCommand: UNIFIED_INIT_COMMAND, walletConfigured: opts.walletConfigured })),
  ].join(" ");
}

/**
 * The engine's instructions open by introducing THEMSELVES as a server: "DePix
 * Wallet MCP — a NON-CUSTODIAL Liquid wallet that signs locally, in the agent's
 * own environment." True when the engine serves its own `depix-wallet-mcp` bin;
 * wrong here. Spliced mid-paragraph it reads as a SECOND server the model should
 * go find, when the wallet tools are on the very server it is already talking to.
 *
 * The sentence immediately above already carries everything that lede says, so it
 * is DROPPED rather than reworded — and dropped by MATCHING it, so an engine bump
 * that rewrites the wording degrades to keeping one redundant sentence instead of
 * silently eating a different one.
 */
const ENGINE_LEDE_RE = /^DePix Wallet MCP\b[^.]*\.\s*/;

function withoutEngineLede(text: string): string {
  return text.replace(ENGINE_LEDE_RE, "");
}

/**
 * Wallet dir the engine itself would use. Mirrors the engine's own resolveDataDir
 * EXACTLY — `??`, not a truthiness/trim check, and `join`, not string concat — so
 * the boot-time "is a wallet configured?" probe can never look somewhere other
 * than where the wallet will actually open (which would serve the wrong
 * `instructions` for the whole session).
 */
export function resolveWalletDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEPIX_WALLET_DIR ?? join(homedir(), ".depix-wallet");
}

/**
 * Is a wallet already set up on this machine? Reads only the PLAINTEXT metadata of
 * the seed file (no passphrase, no decryption) — enough to pick the right
 * `instructions` at boot without opening anything or touching the LWK engine.
 */
export async function isWalletConfigured(dataDir: string): Promise<boolean> {
  try {
    return (await new SeedStore(dataDir).read()) !== null;
  } catch {
    // An unreadable/corrupt store is NOT "configured": the seedless instructions
    // point at `init`, which is also the right advice for a broken dataDir.
    return false;
  }
}

export interface CreateUnifiedServerOptions extends CreateServerOptions {
  /** Lazy wallet resolution + the per-call boot facts (see RegisterWalletToolsContext). */
  wallet: Omit<RegisterWalletToolsContext, "initCommand">;
  /** Whether a wallet exists on this machine — decides which `instructions` ship. */
  walletConfigured: boolean;
  /** Dependencies for the 7 agent-local tools (register_account/agent_status/verify_domain/configure_depix_rail/activate_key/create_key/revoke_key). */
  agentTools: AgentToolDeps;
}

export interface UnifiedServer {
  server: McpServer;
  wallet: WalletToolsRegistration;
}

/**
 * Build the unified server: the gateway catalog plus the mounted wallet catalog,
 * carrying the unified title and instructions.
 */
export function createUnifiedServer(opts: CreateUnifiedServerOptions): UnifiedServer {
  const { wallet, walletConfigured, agentTools, ...serverOptions } = opts;
  const server = createServer({
    ...serverOptions,
    // This IS the local deployment: a missing key resolves to register_account,
    // not "reconnect with a header" (§5.1).
    deployment: "local",
    title: UNIFIED_SERVER_TITLE,
    instructions: unifiedInstructions({ walletConfigured }),
  });
  const registration = registerWalletTools(server, { ...wallet, initCommand: UNIFIED_INIT_COMMAND });
  // The 7 agent-local tools are mounted HERE, never in createServer — the hosted
  // catalog must never offer a registration tool (D4).
  registerAgentTools(server, agentTools);
  return { server, wallet: registration };
}

/** What the lazy resolver needs to report through `wallet_status` after an open. */
export interface WalletBootFacts {
  bootResume: ResumeSummary;
  bootConversions: ConversionResumeSummary;
}

const EMPTY_RESUME: ResumeSummary = { resumed: 0, rebroadcast: 0, reposted: 0, discarded: 0, failed: 0 };
const EMPTY_CONVERSIONS: ConversionResumeSummary = {
  boltz: null,
  pegin: { pending: 0, cleared: 0, failed: 0 },
  sideshift: { checked: 0, refreshed: 0, failed: 0 },
  plans: { checked: 0, advanced: 0, completed: 0, needsReview: 0, discarded: 0, failed: 0 },
};

/**
 * What the bin actually opens: the tool facade plus the two crash-resume passes
 * and close(). `DepixWallet` satisfies this structurally; the tests fake it.
 * `McpWalletFacade` alone is not enough — it is the surface the TOOLS need, not
 * the surface the BOOT needs.
 */
export interface OpenedWallet extends McpWalletFacade {
  resumePendingWithdrawals(): Promise<ResumeSummary>;
  resumePendingConversions(): Promise<ConversionResumeSummary>;
  close(): Promise<void>;
}

export interface WalletRuntime {
  /** The engine's `getWallet` resolver: null when no wallet exists on this machine. */
  getWallet(): Promise<McpWalletFacade | null>;
  /** Crash-resume summary captured at the (single) open. */
  bootResume(): ResumeSummary;
  bootConversions(): ConversionResumeSummary;
  /** Close an opened wallet (releases the dataDir lock). No-op when never opened. */
  close(): Promise<void>;
}

/**
 * The lazy wallet resolver for the bin.
 *
 * WALLET_NOT_FOUND is mapped to `null` — "no wallet here", which the engine turns
 * into the typed `wallet_not_configured` pointing at `init`. EVERY other failure
 * (WRONG_PASSPHRASE, a missing passphrase, a locked dataDir) is RETHROWN: those are
 * an operator-fixable misconfiguration, and swallowing them into "run init" would
 * send someone whose passphrase has a typo off to create a second wallet.
 *
 * The engine's registration memoizes the in-flight resolution, so this may be
 * called concurrently. The crash-resume passes run exactly once, right after the
 * open, mirroring the engine's own stdio bin so `wallet_status` reports real
 * numbers instead of a frozen zero.
 */
/** The engine module, as the opener needs it — derived from the real signature so the two cannot drift. */
export type WalletOpenOptions = Parameters<(typeof import("./wallet-engine/wallet.js"))["DepixWallet"]["open"]>[0];
export interface WalletEngineModule {
  DepixWallet: { open: (options: WalletOpenOptions) => Promise<OpenedWallet> };
}

/**
 * The credential the WALLET may authenticate with, out of what the resolver
 * chose: an API key, never an owner login's OAuth access token. An access
 * token is short-lived and its renewal lives in the gateway client's 401 hook,
 * which the wallet's client has no path to; handing the wallet an expiring
 * token would trade a clear API_KEY_REQUIRED for an opaque 401 minutes later,
 * so under the owner persona the wallet stays keyless and its own error speaks.
 */
export function walletApiKey(credential: ResolvedCredential | undefined): string | undefined {
  return credential?.kind === "api_key" ? credential.token : undefined;
}

/**
 * The wallet's `open` thunk, with the resolved credential wired in.
 *
 * Extracted (rather than inlined at the call site) so the WIRING is testable:
 * `DepixWallet.open()` silently falls back to $DEPIX_API_KEY alone, so an agent
 * that self-registered — its sk_ living ENCRYPTED in the credential store and
 * never in the environment — used to get API_KEY_REQUIRED on deposit()/
 * withdraw() while every gateway tool worked, because only the gateway half
 * consulted the resolver.
 *
 * The credential travels only to an allowlisted origin: the engine's client
 * has no gate of its own, and the gateway promises a misconfigured
 * DEPIX_API_BASE can never receive a key (config.ts). Off the allowlist the
 * function answers undefined, and the engine applies no $DEPIX_API_KEY
 * fallback to a function source — so no key, stored or from the environment,
 * reaches a non-allowlisted host.
 */
export function createWalletOpener(deps: {
  resolveApiKey: () => string | undefined;
  /** The same base the engine's client will use ($DEPIX_API_BASE, defaulted). */
  apiBase: string;
  /** Injectable for tests; production loads the engine lazily (LWK wasm). */
  load?: () => Promise<WalletEngineModule>;
}): () => Promise<OpenedWallet> {
  const load = deps.load ?? (() => import("./wallet-engine/wallet.js"));
  const credentialAllowed = isAllowedApiOrigin(deps.apiBase);
  return async () => {
    const { DepixWallet } = await load();
    return DepixWallet.open({
      // A function, read by the engine on EVERY request: a key that appears or
      // changes mid-session (register_account, activate_key) is used on the
      // next call, with no re-open. Off the allowlist it answers undefined —
      // and a function source has no $DEPIX_API_KEY fallback behind it.
      apiKey: () => (credentialAllowed ? deps.resolveApiKey() : undefined),
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
  };
}

/**
 * Opens the wallet ONCE per process and serializes concurrent first calls. The
 * credential is a function the engine reads on every request
 * (createWalletOpener), so a key that appears or changes mid-session needs no
 * re-open. Crash-resume runs at that single open: a "requested" withdrawal
 * held for another key (or for lack of one) is re-driven by `wallet_recover`
 * or by the next boot under its own key.
 */
export function createWalletRuntime(deps: {
  open: () => Promise<OpenedWallet>;
  onError?: (event: string, err: unknown) => void;
}): WalletRuntime {
  let opened: OpenedWallet | null = null;
  let facts: WalletBootFacts = { bootResume: EMPTY_RESUME, bootConversions: EMPTY_CONVERSIONS };
  // One open at a time: concurrent first calls must not race two engines onto
  // one dataDir (the dir lock would refuse the second, as a confusing error).
  let inFlight: Promise<OpenedWallet | null> | null = null;

  // The wallet is opened ONCE per process. Its credential is a function the
  // engine reads on every request (createWalletOpener), so a key that changes
  // mid-session needs no re-open and never strands a caller on a closed instance.
  async function openOnce(): Promise<OpenedWallet | null> {
    if (opened !== null) return opened;
    let wallet: OpenedWallet;
    try {
      wallet = await deps.open();
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code === "WALLET_NOT_FOUND") return null;
      throw err;
    }
    // Crash-resume once, exactly as the engine's own bin does. A failure here
    // must not deny access to the wallet: it is reported and the summary stays
    // empty, so wallet_status is honest rather than absent.
    try {
      facts = {
        bootResume: await wallet.resumePendingWithdrawals(),
        bootConversions: facts.bootConversions,
      };
    } catch (err) {
      deps.onError?.("boot_resume_failed", err);
    }
    try {
      facts = { bootResume: facts.bootResume, bootConversions: await wallet.resumePendingConversions() };
    } catch (err) {
      deps.onError?.("boot_conversion_resume_failed", err);
    }
    opened = wallet;
    return wallet;
  }

  return {
    getWallet() {
      if (inFlight === null) {
        inFlight = openOnce().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    bootResume: () => facts.bootResume,
    bootConversions: () => facts.bootConversions,
    async close() {
      const wallet = opened;
      opened = null;
      if (wallet !== null) await wallet.close();
    },
  };
}
