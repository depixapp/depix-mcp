// The four AGENT-LOCAL tools (§3.1/§3.2/§3.3): register_account, agent_status,
// verify_domain, configure_depix_rail. Thin wrappers over DepixAgent (which already exists) — no new
// protocol. They live in their OWN module, NOT src/server.ts, because §3.6's
// tool-count classifier counts every registerTool in server.ts as a gateway tool,
// and these are neither hosted nor gateway (D4: the hosted catalog NEVER offers a
// registration tool). This module is mounted only from unified.ts (the local bin).
//
// SECRETS NEVER LEAVE: register_account persists the minted sk_ keys ENCRYPTED
// (AgentCredentialStore) and returns only PUBLIC facts (username, slug, limits,
// key IDs) — never the sk_ itself, never the webhook secret, never the keypair.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolError, mapToolError, walletNotConfiguredError } from "./wallet-engine/mcp/errors.js";
import { OPERATOR_START_URL, withNextAction } from "./next-action.js";
import { UNIFIED_INIT_COMMAND } from "./instructions.js";
import type {
  AgentStatus,
  DepixRailDisabledResult,
  DepixRailEnabledResult,
  DomainChallenge,
  DomainVerification,
  RegisterInput,
  RegisterResult,
} from "./wallet-engine/agent.js";
import type { DepixPayCredential } from "./wallet-engine/wallet.js";
import type { ActiveKeyMode } from "./wallet-engine/agent/credential-store.js";

/** The agent-local catalog (§3.6). Exported for the count invariant + tests. */
export const AGENT_TOOL_NAMES = ["register_account", "agent_status", "verify_domain", "configure_depix_rail"] as const;

/** The DepixAgent surface these tools use (a subset; a fake satisfies it in tests). */
export interface AgentLike {
  readonly publicKeyHex: string;
  register(input: RegisterInput): Promise<RegisterResult>;
  status(): Promise<AgentStatus>;
  verifyDomain(domain: string): Promise<DomainChallenge>;
  verifyDomain(domain: string, options: { confirm: true }): Promise<DomainVerification>;
  configureDepixRail(input: { enabled: true; address: string; blindingKey: string; derivationIndex?: number | null }): Promise<DepixRailEnabledResult>;
  configureDepixRail(input: { enabled: false }): Promise<DepixRailDisabledResult>;
}

/** What persisting the minted keys reports back (§3.1 precedence "achado m4"). */
export interface KeyActivation {
  /** Which key the resolver serves now. */
  activeMode: ActiveKeyMode;
  /**
   * WHICH credential actually authenticates now — "store" (the key just
   * created), "env" (DEPIX_API_KEY shadows it), or "owner" (the operator
   * selected their own login with `account use owner`, so the new key is
   * stored but idle). Reporting "store" for the last case would be a lie the
   * agent could not detect.
   */
  source: "env" | "store" | "owner";
  /** true when a DEPIX_API_KEY env var is overriding the just-registered key. */
  envOverride: boolean;
}

/** The wallet surface the agent tools need: the payout address + the DePix-rail credential. */
export interface AgentWalletLike {
  getReceiveAddress(options?: { index?: number }): Promise<string>;
  /** Derive the DePix-rail dedicated address + its per-script SLIP-77 view key (§3.9). */
  deriveDepixPayCredential(options?: { index?: number }): Promise<DepixPayCredential>;
}

/** Injected dependencies (defaults built in stdio.ts; tests pass fakes). */
export interface AgentToolDeps {
  /** Resolve the local wallet for the payout address; null = no wallet configured. */
  getWallet: () => Promise<AgentWalletLike | null>;
  /** Open the existing agent identity, or null when none exists yet. */
  openAgent: () => Promise<AgentLike | null>;
  /** Create a fresh agent identity (called only when openAgent returned null). */
  createAgent: () => Promise<AgentLike>;
  /** Persist the minted keys encrypted + choose the active one; reports what won. */
  persistKeys: (input: { testKey: string; liveKey?: string; prefer: ActiveKeyMode }) => Promise<KeyActivation>;
}

function ok(out: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(out) }],
    structuredContent: out as Record<string, unknown>,
  };
}

function fail(err: ToolError): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: err.message },
      { type: "text", text: JSON.stringify({ error: { code: err.code, retryable: err.retryable, ...err.data } }) },
    ],
  };
}

function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  return (async () => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(mapToolError(err));
    }
  })();
}

/** No agent identity yet → a typed error that points at register_account. */
function agentNotInitialized(): ToolError {
  return new ToolError(
    "No agent account exists on this machine yet. Create one with register_account (it needs the operator's op_ code).",
    "agent_not_initialized",
    { data: withNextAction({}, "agent_not_initialized") },
  );
}

/** Keep only primitive fields off a server-provided info block (never echo secrets). */
function primitivesOnly(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── handlers ──

async function registerAccount(
  deps: AgentToolDeps,
  args: {
    name: string;
    operator_token?: string;
    operator_email: string;
    username?: string;
    default_callback_url?: string;
    ref?: string;
    activate?: ActiveKeyMode;
  },
) {
  const wallet = await deps.getWallet();
  if (!wallet) throw walletNotConfiguredError();

  // The op_ code can come from the tool arg (pasted in chat) or from
  // DEPIX_OPERATOR_TOKEN in the host config — what `init`'s "connect now" writes
  // (§3.7 #7). A missing token is a typed step, not a crash, and it is resolved
  // BEFORE deriving the payout address so a fresh receive index is not burned on
  // a call that cannot proceed.
  const operatorToken = args.operator_token ?? process.env.DEPIX_OPERATOR_TOKEN;
  if (operatorToken === undefined || operatorToken === "") {
    throw new ToolError(
      "This account needs the operator's op_ code. Paste it here, or set DEPIX_OPERATOR_TOKEN in the host config.",
      "operator_token_required",
      { data: withNextAction({}, "operator_token_required") },
    );
  }

  // Payout is the wallet's OWN address; the server fixes it at registration.
  const liquidAddress = await wallet.getReceiveAddress();

  const agent = (await deps.openAgent()) ?? (await deps.createAgent());
  const result = await agent.register({
    name: args.name,
    operatorToken,
    operatorEmail: args.operator_email,
    liquidAddress,
    ...(args.username !== undefined ? { username: args.username } : {}),
    ...(args.default_callback_url !== undefined ? { defaultCallbackUrl: args.default_callback_url } : {}),
    ...(args.ref !== undefined ? { ref: args.ref } : {}),
  });

  // DURABLE BEFORE SUCCESS (§3.1): the sk_ comes back from the backend ONCE, so
  // persist + verify BEFORE reporting success. If the write fails, say plainly
  // that the account exists but the keys are lost — never report a false success.
  let activation: KeyActivation;
  try {
    activation = await deps.persistKeys({
      testKey: result.keys.test.key,
      liveKey: result.keys.liveStarter.key,
      prefer: args.activate ?? "test",
    });
  } catch {
    throw new ToolError(
      `Your account "${result.agent.username}" was created, but its API keys could NOT be saved on this machine — ` +
        "and the backend returns them only once, so they are lost. Contact support with your username to issue a new key.",
      "credentials_persist_failed",
      { data: withNextAction({ username: result.agent.username }, "credentials_persist_failed"), retryable: false },
    );
  }

  const warning = activation.envOverride
    ? "A DEPIX_API_KEY environment variable is set and OVERRIDES the key just created — every request keeps using " +
      "the env key's account, NOT this new account. Unset DEPIX_API_KEY (and restart) to operate the account you " +
      "just registered."
    : null;

  // PUBLIC facts only — never the sk_, the webhook secret, or the keypair.
  return {
    username: result.agent.username,
    public_key: result.agent.publicKey,
    account_type: result.agent.accountType,
    merchant_id: result.merchant.id,
    merchant_slug: result.merchant.merchantSlug,
    liquid_address: result.merchant.liquidAddress,
    active_key_mode: activation.activeMode,
    active_key_source: activation.source,
    env_override: activation.envOverride,
    test_key_id: result.keys.test.id,
    live_starter_key_id: result.keys.liveStarter.id,
    graduation: primitivesOnly(result.graduation) ?? null,
    limits: primitivesOnly(result.limits) ?? null,
    warning,
  };
}

async function agentStatus(deps: AgentToolDeps) {
  const agent = await deps.openAgent();
  if (!agent) throw agentNotInitialized();
  const status = await agent.status();
  return {
    account_status: status.accountStatus,
    settled_personal_deposits: status.settledPersonalDeposits,
    graduated: status.graduated,
    graduation_blocked_on: status.graduationBlockedOn,
    keys: status.keys.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      is_live: k.isLive,
      starter: k.starter,
      scopes: k.scopes,
      revoked_at: k.revokedAt,
    })),
    ...(status.reason !== undefined ? { reason: status.reason } : {}),
  };
}

async function verifyDomain(deps: AgentToolDeps, args: { domain: string; confirm?: boolean }) {
  const agent = await deps.openAgent();
  if (!agent) throw agentNotInitialized();
  if (args.confirm === true) {
    const r = await agent.verifyDomain(args.domain, { confirm: true });
    return { phase: "confirm" as const, verified_domain: r.verifiedDomain };
  }
  const c = await agent.verifyDomain(args.domain);
  return {
    phase: "challenge" as const,
    record_name: c.recordName,
    record_value: c.recordValue,
    instruction: {
      pt: `Crie um registro DNS do tipo TXT com nome "${c.recordName}" e valor "${c.recordValue}", espere a propagação (alguns minutos) e então chame verify_domain de novo com confirm: true.`,
      en: `Create a DNS TXT record named "${c.recordName}" with value "${c.recordValue}", wait for it to propagate (a few minutes), then call verify_domain again with confirm: true.`,
    },
  };
}

async function configureDepixRail(deps: AgentToolDeps, args: { enabled: boolean; derivation_index?: number }) {
  // The rail is signed by the agent identity, so an account must already exist —
  // this tool never creates one (that is register_account).
  const agent = await deps.openAgent();
  if (!agent) throw agentNotInitialized();

  if (!args.enabled) {
    // Turning OFF needs no wallet and no key — revoking a grant is never harder
    // than granting it.
    const result = await agent.configureDepixRail({ enabled: false });
    return {
      enabled: false as const,
      depix_pay_enabled: false,
      view_key_deleted: result.viewKeyDeleted,
      pending_addresses: result.pendingAddresses,
    };
  }

  // Turning ON derives the dedicated address AND the per-script SLIP-77 view key
  // from THIS wallet. The blinding key is a secret: it is passed straight to the
  // signed backend call and is NEVER placed in the return value or a log.
  const wallet = await deps.getWallet();
  if (!wallet) throw walletNotConfiguredError();
  const cred = await wallet.deriveDepixPayCredential(
    args.derivation_index !== undefined ? { index: args.derivation_index } : {},
  );
  const result = await agent.configureDepixRail({
    enabled: true,
    address: cred.address,
    blindingKey: cred.blindingKey,
    derivationIndex: cred.derivationIndex,
  });

  // PUBLIC facts only — the address and the state of the rail, never the key.
  return {
    enabled: true as const,
    depix_pay_enabled: true,
    depix_pay_address: result.address,
    derivation_index: cred.derivationIndex,
    discount_pct: result.discountPct,
  };
}

// ── registration ──

const write: ToolAnnotations = { readOnlyHint: false, openWorldHint: true };
const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

/**
 * Mount register_account / agent_status / verify_domain on the unified server.
 * Called ONLY from unified.ts (the local bin) — never from the hosted path.
 */
export function registerAgentTools(server: McpServer, deps: AgentToolDeps): { toolNames: readonly string[] } {
  server.registerTool(
    "register_account",
    {
      title: "Register a DePix account",
      description:
        "Create a DePix agent account and its API keys IN THIS PROCESS, on the operator's machine. " +
        "THREE THINGS ARE NEEDED FIRST — check them before calling, and relay whichever is missing to the human: " +
        "(1) a wallet on this machine — the operator runs `" +
        UNIFIED_INIT_COMMAND +
        "` in a terminal, which also sets the passphrase that seals the account's keys; " +
        `(2) the operator's op_ code — send them ${OPERATOR_START_URL}, they sign in with Google or GitHub and read the ` +
        "code back to you (it reappears on every sign-in), or they set DEPIX_OPERATOR_TOKEN in the host config; " +
        "(3) their notification email, for `operator_email`. " +
        "The account's keys are saved ENCRYPTED on this machine and used immediately — no restart, nothing " +
        "pasted into a config. The response carries only PUBLIC facts (username, store slug, limits, key IDs): the " +
        "secret keys are NEVER shown here. Activates the sandbox (sk_test_) key by default. If DEPIX_API_KEY is set " +
        "in the environment, it OVERRIDES the new key and the response says so.",
      inputSchema: {
        name: z.string().min(2).max(100).describe("Human-readable name for the account/store (2–100 chars)."),
        operator_token: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The op_ authorization code from the human operator. They get it by signing in at " +
              `${OPERATOR_START_URL} (Google/GitHub; the code re-appears on every sign-in). ` +
              "Relay that link to your operator and ask them to paste the code here — do not send them to the " +
              "dashboard or to API settings, it is not there. Optional when DEPIX_OPERATOR_TOKEN is set in the host " +
              "config (init's \"connect now\" writes it there).",
          ),
        operator_email: z.string().min(1).describe("Operator notification email (never becomes the account login)."),
        username: z.string().min(1).optional().describe("Optional username (defaults server-side to agent_<pubkey-prefix>)."),
        default_callback_url: z.string().min(1).optional().describe("Optional default webhook callback URL."),
        ref: z.string().min(1).optional().describe("Optional referral code (an existing username) — attribution is preserved."),
        activate: z
          .enum(["test", "live"])
          .optional()
          .describe("Which minted key to make active: test (sandbox, default) or live (production starter)."),
      },
      outputSchema: {
        username: z.string(),
        public_key: z.string().describe("The account's Ed25519 public key (its stable identifier)."),
        account_type: z.string(),
        merchant_id: z.string(),
        merchant_slug: z.string().describe("The store's public URL slug."),
        liquid_address: z.string().describe("The settlement address (the wallet's own), fixed at registration."),
        active_key_mode: z.enum(["test", "live"]).describe("Which key is now active."),
        active_key_source: z
          .enum(["env", "store", "owner"])
          .describe(
            "Which credential the server actually authenticates with now: \"store\" = the key just created, \"env\" = " +
              "DEPIX_API_KEY, \"owner\" = the operator's own login (they selected it with `account use owner`).",
          ),
        env_override: z.boolean().describe("true when DEPIX_API_KEY shadows the just-created key."),
        test_key_id: z.string().describe("Id of the sandbox key (the secret itself is never returned)."),
        live_starter_key_id: z.string().describe("Id of the live starter key (the secret itself is never returned)."),
        graduation: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
        limits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
        warning: z.string().nullable().describe("A loud note when the env key overrides the new one, else null."),
      },
      annotations: write,
    },
    (args) =>
      run(() =>
        registerAccount(deps, args as {
          name: string;
          operator_token?: string;
          operator_email: string;
          username?: string;
          default_callback_url?: string;
          ref?: string;
          activate?: ActiveKeyMode;
        }),
      ),
  );

  server.registerTool(
    "agent_status",
    {
      title: "Agent account status",
      description:
        "Read the agent account's onboarding progress: whether it is active/suspended, how many personal deposits " +
        "have settled, whether it has graduated to live keys (and what is still blocking), and its keys (id/prefix/" +
        "scopes/revoked — never the secret). Read-only; narrates what the server reports, never recomputes the rule. " +
        "Requires an account already registered here — if there is none, call `register_account` first. Whatever " +
        "`graduation_blocked_on` names is a HUMAN step: relay it to the operator rather than retrying.",
      inputSchema: {},
      outputSchema: {
        account_status: z.enum(["active", "suspended"]),
        settled_personal_deposits: z.number().int(),
        graduated: z.boolean(),
        graduation_blocked_on: z.string().nullable(),
        keys: z.array(
          z.object({
            id: z.string(),
            prefix: z.string(),
            is_live: z.boolean(),
            starter: z.boolean(),
            scopes: z.string(),
            revoked_at: z.string().nullable(),
          }),
        ),
        reason: z.string().optional().describe("Present only when suspended."),
      },
      annotations: read,
    },
    () => run(() => agentStatus(deps)),
  );

  server.registerTool(
    "verify_domain",
    {
      title: "Verify a domain (agent)",
      description:
        "Prove control of a domain via a DNS TXT challenge, in two phases. Phase 1 (omit confirm): returns the TXT " +
        "record NAME and VALUE to create — relay it to the human to add at their DNS provider (only they can: it is " +
        "their DNS panel, and propagation takes minutes). Phase 2 (confirm: true, after propagation): the server " +
        "resolves the record and, on a match, records the domain as verified. A verified domain lifts " +
        "domain_required on the merchant scopes.",
      inputSchema: {
        domain: z.string().min(1).describe("The domain to verify (e.g. acme.com)."),
        confirm: z
          .boolean()
          .optional()
          .describe("false/omitted = phase 1 (get the TXT challenge); true = phase 2 (confirm after the record propagates)."),
      },
      outputSchema: {
        phase: z.enum(["challenge", "confirm"]),
        record_name: z.string().optional().describe("Phase 1: the DNS TXT record name to create."),
        record_value: z.string().optional().describe("Phase 1: the exact DNS TXT record value."),
        instruction: z
          .object({ pt: z.string(), en: z.string() })
          .optional()
          .describe("Phase 1: plain PT+EN steps to relay to the human."),
        verified_domain: z.string().optional().describe("Phase 2: the registrable domain now recorded as verified."),
      },
      annotations: write,
    },
    (args) => run(() => verifyDomain(deps, args as { domain: string; confirm?: boolean })),
  );

  server.registerTool(
    "configure_depix_rail",
    {
      title: "Turn the DePix direct rail on/off",
      description:
        "Let this merchant be paid in DePix sent DIRECTLY on Liquid, not only by Pix. Enabling derives a dedicated " +
        "receiving address from THIS wallet and registers it with the backend so incoming DePix is credited; " +
        "disabling turns it off. Needs an initialized wallet (to derive the address — the operator runs `" +
        UNIFIED_INIT_COMMAND +
        "`) and a registered agent account (the call is signed — call `register_account` first). You pass only `enabled` (and, optionally, a `derivation_index` to re-derive a specific " +
        "address) — the tool derives the address and its private viewing key itself and sends them in-process. The " +
        "response carries only PUBLIC facts (the address, the rail state): the viewing key is NEVER shown here.",
      inputSchema: {
        enabled: z.boolean().describe("true = turn the DePix direct rail ON (derive + register a dedicated address); false = turn it OFF."),
        derivation_index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Optional: derive the dedicated address at this exact index (e.g. to re-register a known one). Omit to allocate a fresh one."),
      },
      outputSchema: {
        enabled: z.boolean().describe("Echo of the requested state."),
        depix_pay_enabled: z.boolean().describe("Whether the rail is now ON for this merchant."),
        depix_pay_address: z.string().optional().describe("ON only: the dedicated confidential (lq1…) address now receiving DePix."),
        derivation_index: z.number().int().optional().describe("ON only: the derivation index the address was taken at."),
        discount_pct: z.number().optional().describe("ON only: the DePix-payment discount the merchant offers, in percent."),
        view_key_deleted: z.boolean().optional().describe("OFF only: true when the viewing key was deleted (no in-flight checkout kept it)."),
        pending_addresses: z.number().int().optional().describe("OFF only: addresses whose key was retained because a checkout there is still open."),
      },
      annotations: write,
    },
    (args) => run(() => configureDepixRail(deps, args as { enabled: boolean; derivation_index?: number })),
  );

  return { toolNames: AGENT_TOOL_NAMES };
}
