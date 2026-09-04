// The five AGENT-LOCAL tools (§3.1/§3.2/§3.3): register_account, agent_status,
// verify_domain, configure_depix_rail, activate_key. Thin wrappers over DepixAgent (which already exists) — no new
// protocol. They live in their OWN module, NOT src/server.ts, because §3.6's
// tool-count classifier counts every registerTool in server.ts as a gateway tool,
// and these are neither hosted nor gateway (D4: the hosted catalog NEVER offers a
// registration tool). This module is mounted only from unified.ts (the local bin).
//
// SECRETS NEVER LEAVE: register_account persists the minted sk_ keys ENCRYPTED
// (AgentCredentialStore) and returns only PUBLIC facts (username, slug, pacing,
// key IDs) — never the sk_ itself, never the webhook secret, never the keypair.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolError, mapToolError, walletNotConfiguredError } from "./wallet-engine/mcp/errors.js";
import { OPERATOR_START_URL, withNextAction } from "./next-action.js";
import { UNIFIED_INIT_COMMAND } from "./instructions.js";
import type {
  AgentStatus,
  CreatedKey,
  CreateKeyInput,
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
export const AGENT_TOOL_NAMES = ["register_account", "agent_status", "verify_domain", "configure_depix_rail", "activate_key", "create_key", "revoke_key"] as const;

/** The DepixAgent surface these tools use (a subset; a fake satisfies it in tests). */
export interface AgentLike {
  readonly publicKeyHex: string;
  register(input: RegisterInput): Promise<RegisterResult>;
  status(): Promise<AgentStatus>;
  verifyDomain(domain: string): Promise<DomainChallenge>;
  verifyDomain(domain: string, options: { confirm: true }): Promise<DomainVerification>;
  configureDepixRail(input: { enabled: true; address: string; blindingKey: string; derivationIndex?: number | null }): Promise<DepixRailEnabledResult>;
  configureDepixRail(input: { enabled: false }): Promise<DepixRailDisabledResult>;
  createKey(input?: CreateKeyInput): Promise<CreatedKey>;
  revokeKey(id: string): Promise<{ id: string; revoked: boolean }>;
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
  /**
   * Re-point the vault's active key at one of the two ALREADY-minted keys and
   * activate it in-session. Throws agent_not_initialized (no vault) or
   * live_key_missing (the vault holds no live key).
   */
  activateKey: (mode: ActiveKeyMode) => Promise<KeyActivation>;
  /** Which key the vault currently serves, and whether a live one exists at all. */
  keyState: () => Promise<{ active: ActiveKeyMode; hasLive: boolean }>;
  /**
   * Seal a freshly minted key into ONE slot of the vault, keeping the other
   * mode's key, and optionally point the resolver at it.
   */
  replaceKey: (input: { key: string; mode: ActiveKeyMode; activate: boolean }) => Promise<KeyActivation>;
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
export function agentNotInitialized(): ToolError {
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

const PACING_NUMBER_FIELDS = [
  "first_deposit_max_cents",
  "unverified_per_tx_max_cents",
  "inter_deposit_delay_hours",
  "verified_per_tx_deposit_max_cents",
  "verified_per_tx_withdraw_send_max_cents",
  "verified_per_tx_withdraw_receive_max_cents",
] as const;
const PAYER_VELOCITY_FIELDS = ["max_per_window", "window_minutes"] as const;

function numberFields(value: unknown, fields: readonly string[]): Record<string, number> {
  const src = (value ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const f of fields) if (Number.isFinite(src[f])) out[f] = src[f] as number;
  return out;
}

/**
 * The pacing block, kept to the shape declared below — `primitivesOnly` would
 * drop `payer_velocity` for being an object, and that pair is the only place the
 * payer rule is published. Ill-typed or unknown fields are dropped rather than
 * failed on: this response is returned once, after the account already exists,
 * so refusing it over a server-side field change would strand a live account.
 */
function pacingOnly(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = numberFields(value, PACING_NUMBER_FIELDS);
  const velocity = numberFields((value as Record<string, unknown>).payer_velocity, PAYER_VELOCITY_FIELDS);
  if (Object.keys(velocity).length > 0) out.payer_velocity = velocity;
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

  // The key was saved, but "saved" is not "in use". Both things that can shadow
  // it have to say so here: an env key, and the operator having selected their
  // own login with `account use owner`. Reporting only the first left the second
  // silent — the agent would go on believing it was operating the account it
  // had just created.
  const warning = activationWarning(activation);

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
    pacing: pacingOnly(result.pacing) ?? null,
    warning,
  };
}

async function agentStatus(deps: AgentToolDeps) {
  const agent = await deps.openAgent();
  if (!agent) throw agentNotInitialized();
  const status = await agent.status();
  return {
    account_status: status.accountStatus,
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

/** What a proven domain unlocks: receiving from third parties, plus the wallet. */
const UPGRADE_SCOPES = ["merchant_read", "merchant_write", "wallet_read", "wallet_write"];
/** The only set that needs no domain and no graduation — safe as a default. */
const STARTER_SCOPES = ["wallet_read", "wallet_write"];

/** PUBLIC facts about a minted key. The sk_ itself never appears in a result. */
function keyFacts(k: CreatedKey) {
  return {
    key_id: k.id,
    prefix: k.prefix,
    is_live: k.isLive,
    scopes: k.scopes,
    per_tx_limit_cents: k.perTxLimitCents ?? null,
    daily_limit_cents: k.dailyLimitCents ?? null,
  };
}

/**
 * A backend refusal carries a code; a local failure (a locked vault, a disk
 * that would not take the write) carries only a message. Falling back to
 * "unknown_error" would make the most likely failure the least actionable one.
 */
function errCode(err: unknown): string {
  const e = err as { code?: string; message?: string } | undefined;
  return e?.code ?? e?.message ?? "unknown_error";
}

/**
 * Trade the starter key for one that can also receive from third parties.
 *
 * Mint FIRST, revoke second: the reverse order would leave an account with no
 * usable key whenever the mint is refused. A refused mint costs nothing — the
 * domain proof stands and the old key keeps working — so every failure here is
 * REPORTED, never thrown.
 */
async function upgradeToMerchantKey(deps: AgentToolDeps, agent: AgentLike) {
  const state = await deps.keyState();
  const mode = state.active;
  const isLive = mode === "live";

  // The key being superseded is whatever the vault held for this mode, and the
  // vault stores the SECRET, not the id — so it can only be named by taking the
  // census BEFORE minting. `starter` cannot stand in for it: the backend sets
  // that column on the sk_live_ key alone, so in test mode (the default after
  // register_account) nothing would ever match.
  let priorIds: string[] = [];
  let censusOk = false;
  try {
    const before = await agent.status();
    priorIds = before.keys.filter((k) => k.isLive === isLive && k.revokedAt === null).map((k) => k.id);
    censusOk = true;
  } catch {
    // A failed census is NOT "there was nothing there" — saying so would send
    // the agent away from a live full-scope key. Reported as its own case.
  }

  const minted = await agent.createKey({ live: isLive, scopes: [...UPGRADE_SCOPES] });
  const activation = await deps.replaceKey({ key: minted.key, mode, activate: true });

  // Only now is the old key redundant. Losing this step costs a stale key, not
  // access, so it is reported rather than unwound.
  const superseded = priorIds.filter((id) => id !== minted.id);
  let previousKeyId: string | null = null;
  let previousKeyRevoked = false;
  let ambiguous = false;
  if (superseded.length === 1) {
    previousKeyId = superseded[0]!;
    try {
      previousKeyRevoked = (await agent.revokeKey(previousKeyId)).revoked;
    } catch {
      // previousKeyRevoked stays false — the caller says so out loud.
    }
  } else if (superseded.length > 1) {
    // Several keys of this mode were live. Only one of them was in the vault
    // and there is no way to tell which, so killing one would be a coin flip on
    // a key the operator minted on purpose.
    ambiguous = true;
  }
  return {
    merchant_key: keyFacts(minted),
    previous_key_id: previousKeyId,
    previous_key_revoked: previousKeyRevoked,
    previous_key_note: previousKeyRevoked
      ? null
      : ambiguous
        ? `This account had several live ${mode} keys, so none was revoked — the superseded one cannot be told apart. Read agent_status and revoke it with revoke_key.`
        : !censusOk
          ? `The key census failed, so none was revoked — the superseded ${mode} key may still be live. Read agent_status and revoke it with revoke_key.`
          : superseded.length === 0
            ? `No earlier ${mode} key was live, so none was revoked.`
            : `The superseded key ${previousKeyId} is STILL VALID — revoking it failed. Retry with revoke_key.`,
    active_key_mode: activation.activeMode,
    active_key_source: activation.source,
    env_override: activation.envOverride,
    warning: activationWarning(activation, "activated"),
  };
}

const NO_UPGRADE = {
  merchant_key: null,
  previous_key_id: null,
  previous_key_revoked: false,
  previous_key_note: null,
  active_key_mode: null,
  active_key_source: null,
  env_override: false,
  warning: null,
};

async function verifyDomain(deps: AgentToolDeps, args: { domain: string; confirm?: boolean }) {
  const agent = await deps.openAgent();
  if (!agent) throw agentNotInitialized();
  if (args.confirm === true) {
    const r = await agent.verifyDomain(args.domain, { confirm: true });
    const base = { phase: "confirm" as const, verified_domain: r.verifiedDomain, verified: r.verified };
    if (!r.verified) {
      return {
        ...base,
        ...NO_UPGRADE,
        upgrade_note:
          "The domain is proven and stored, but the account did not verify, so no merchant key was minted. " +
          "Read agent_status for the reason (a suspended account never verifies).",
      };
    }
    try {
      return { ...base, ...(await upgradeToMerchantKey(deps, agent)), upgrade_note: null };
    } catch (err) {
      return {
        ...base,
        ...NO_UPGRADE,
        upgrade_note:
          `The domain is proven and the account is verified, but minting the merchant key failed (${errCode(err)}). ` +
          "The existing key still works; call create_key to retry.",
      };
    }
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
 * The one sentence an agent cannot infer from the codes alone: whether the
 * key it just chose is the one this server ACTUALLY authenticates with.
 * register_account's wording is relayed to humans and pinned by tests; the
 * switch only changes the verbs, never the meaning.
 */
export function activationWarning(activation: KeyActivation, subject: "created" | "activated" = "created"): string | null {
  const justDid = subject === "created" ? "just created" : "just activated";
  const thisNew = subject === "created" ? "this new account" : "this account";
  const thisNewOne = subject === "created" ? "this new one" : "this one";
  const account = subject === "created" ? "the account you just registered" : "this account";
  if (activation.source === "env") {
    return (
      `A DEPIX_API_KEY environment variable is set and OVERRIDES the key ${justDid} — every request keeps using ` +
      `the env key's account, NOT ${thisNew}. Unset DEPIX_API_KEY (and restart) to operate ${account}.`
    );
  }
  if (activation.source === "owner") {
    return (
      "The key was saved but is IDLE: this server is set to act as the operator's own DePix login " +
      `(\`npx -y @depixapp/mcp account use owner\`), so requests keep using THEIR account, not ${thisNewOne}. Ask ` +
      `the operator to run \`npx -y @depixapp/mcp account use agent\` to operate ${account}.`
    );
  }
  return null;
}

async function createKey(
  deps: AgentToolDeps,
  args: {
    live?: boolean;
    scopes?: string[];
    label?: string;
    per_tx_limit_cents?: number;
    daily_limit_cents?: number;
    activate?: boolean;
  },
) {
  const agent = await deps.openAgent();
  if (!agent) throw agentNotInitialized();
  const mode: ActiveKeyMode = args.live === true ? "live" : "test";
  // Open the vault BEFORE minting. A key minted into a vault that will not take
  // it is lost — the plaintext is returned once — and it still burns one of the
  // five slots that mode allows.
  await deps.keyState();
  const minted = await agent.createKey({
    live: args.live === true,
    scopes: args.scopes ?? [...STARTER_SCOPES],
    ...(args.label !== undefined ? { label: args.label } : {}),
    ...(args.per_tx_limit_cents !== undefined ? { perTxLimitCents: args.per_tx_limit_cents } : {}),
    ...(args.daily_limit_cents !== undefined ? { dailyLimitCents: args.daily_limit_cents } : {}),
  });
  const activate = args.activate !== false;
  const activation = await deps.replaceKey({ key: minted.key, mode, activate });
  return {
    ...keyFacts(minted),
    active_key_mode: activation.activeMode,
    active_key_source: activation.source,
    env_override: activation.envOverride,
    warning: activationWarning(activation, "activated"),
  };
}

async function revokeKey(deps: AgentToolDeps, args: { key_id: string; confirm?: boolean }) {
  const agent = await deps.openAgent();
  if (!agent) throw agentNotInitialized();
  if (args.confirm !== true) {
    // Dry run. Revoking is instant and irreversible, and the operator cannot see
    // this call, so the agent has to state WHAT it is about to kill first.
    const status = await agent.status();
    const target = status.keys.find((k) => k.id === args.key_id) ?? null;
    return {
      phase: "confirm_required" as const,
      key_id: args.key_id,
      revoked: false,
      found: target !== null,
      prefix: target?.prefix ?? null,
      is_live: target?.isLive ?? null,
      starter: target?.starter ?? null,
      scopes: target?.scopes ?? null,
      already_revoked: target ? target.revokedAt !== null : null,
      instruction: {
        pt: target
          ? `Confirme com o operador humano que a chave ${args.key_id} (${target.prefix}, escopos: ${target.scopes}) deve ser revogada, e então chame revoke_key de novo com confirm: true. A revogação é imediata e não tem volta.`
          : `Esta conta não tem chave com id ${args.key_id}. Leia agent_status para ver os ids reais.`,
        en: target
          ? `Confirm with the human operator that key ${args.key_id} (${target.prefix}, scopes: ${target.scopes}) should be revoked, then call revoke_key again with confirm: true. Revocation is immediate and cannot be undone.`
          : `This account has no key with id ${args.key_id}. Read agent_status for the real ids.`,
      },
    };
  }
  const r = await agent.revokeKey(args.key_id);
  return {
    phase: "revoked" as const,
    key_id: r.id,
    revoked: r.revoked,
    found: true,
    prefix: null,
    is_live: null,
    starter: null,
    scopes: null,
    already_revoked: null,
    instruction: null,
  };
}

export async function activateKey(deps: AgentToolDeps, mode: ActiveKeyMode) {
  const activation = await deps.activateKey(mode);
  return {
    active_key_mode: activation.activeMode,
    active_key_source: activation.source,
    env_override: activation.envOverride,
    warning: activationWarning(activation, "activated"),
  };
}

/**
 * Mount the seven agent-local tools on the unified server.
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
        "pasted into a config. The response carries only PUBLIC facts (username, store slug, pacing caps, key IDs): " +
        "the secret keys are NEVER shown here. Activates the sandbox (sk_test_) key by default. If DEPIX_API_KEY is set " +
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
        pacing: z
          .object({
            first_deposit_max_cents: z.number().optional(),
            unverified_per_tx_max_cents: z.number().optional(),
            inter_deposit_delay_hours: z
              .number()
              .optional()
              .describe(
                "A minimum, not a schedule: a deposit above the per-transaction ceiling takes the account's trust-level " +
                  "hold instead, which is far longer. Read `vault_window_hours` (get_vault_status) for the live number " +
                  "before promising anyone a release time.",
              ),
            payer_velocity: z
              .object({ max_per_window: z.number().optional(), window_minutes: z.number().optional() })
              .optional()
              .describe("How often one payer may pay this account: max_per_window payments per window_minutes."),
            verified_per_tx_deposit_max_cents: z
              .number()
              .optional()
              .describe("Cap on `amountInCents` — what the payer sends on a deposit."),
            verified_per_tx_withdraw_send_max_cents: z
              .number()
              .optional()
              .describe("Cap on `depositAmountInCents` — the DePix the wallet sends."),
            verified_per_tx_withdraw_receive_max_cents: z
              .number()
              .optional()
              .describe(
                "Cap on `payoutAmountInCents` — what lands in the destination account, net of fees. The provider bounds " +
                  "each request field at the same figure, so this equals the send cap; do not derive a lower one from the fees.",
              ),
          })
          .nullable()
          .describe(
            "The ceilings and delays this account is paced by, as the server reports them — the unverified ones " +
              "apply now, the verified ones after it verifies. Every field is optional: read what is there, and do " +
              "not assume a missing one is unlimited.",
          ),
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
        "Read the agent account's onboarding progress: whether it is active/suspended, whether it has graduated to " +
        "live keys and what is still blocking that, and its keys (id/prefix/scopes/revoked — never the secret). " +
        "Read-only; narrates what the server reports, never recomputes the rule. " +
        "Requires an account already registered here — if there is none, call `register_account` first. " +
        "`graduation_blocked_on` says whose move it is: \"domain_proof\" is yours — call `verify_domain`, then relay " +
        "its DNS record to the operator, who alone can add it; \"gate_review\" is ours — poll, there is nothing to " +
        "do; null once graduated. Deposits do not graduate an account.",
      inputSchema: {},
      outputSchema: {
        account_status: z.enum(["active", "suspended"]),
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
        "domain_required on the merchant scopes, so phase 2 ALSO trades this account's starter key for one that " +
        "carries them (merchant_read + merchant_write + the wallet scopes), activates it, and revokes the starter. " +
        "That upgrade is minted BEFORE the old key is revoked, so a refused mint costs nothing: the domain still " +
        "counts, the old key still works, and `upgrade_note` says what happened. No secret is ever shown.",
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
        verified: z.boolean().optional().describe("Phase 2: did the proof also verify the ACCOUNT (unlocking the merchant tools)?"),
        merchant_key: z
          .object({
            key_id: z.string(),
            prefix: z.string(),
            is_live: z.boolean(),
            scopes: z.string(),
            per_tx_limit_cents: z.number().nullable(),
            daily_limit_cents: z.number().nullable(),
          })
          .nullable()
          .optional()
          .describe("Phase 2: PUBLIC facts about the upgraded key, or null when none was minted. Never the key itself."),
        previous_key_id: z.string().nullable().optional().describe("Phase 2: the starter key the upgrade superseded."),
        previous_key_revoked: z
          .boolean()
          .optional()
          .describe("Phase 2: false means the OLD key is still live — say so; it is a stale credential, not a broken account."),
        previous_key_note: z
          .string()
          .nullable()
          .optional()
          .describe("Phase 2: why the superseded key was not revoked, or null when it was. Relay it — a live stray key is the operator's business."),
        active_key_mode: z.enum(["test", "live"]).nullable().optional().describe("Phase 2: which key the server authenticates with now."),
        active_key_source: z.enum(["env", "store", "owner"]).nullable().optional().describe("Phase 2: which credential actually wins."),
        env_override: z.boolean().optional().describe("Phase 2: true when DEPIX_API_KEY shadows the upgraded key."),
        warning: z.string().nullable().optional().describe("Phase 2: a loud note when the upgraded key is not the one in use."),
        upgrade_note: z.string().nullable().optional().describe("Phase 2: why no merchant key was minted, or null when one was."),
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

  server.registerTool(
    "activate_key",
    {
      title: "Activate the sandbox or live key",
      description:
        "Choose which of this account's two API keys the server authenticates with from now on: test (sandbox — " +
        "no real money) or live (the production starter: wallet_read + wallet_write, i.e. the wallet tools). Both " +
        "keys already belong to the account register_account created on this machine — nothing is minted and no " +
        "secret is shown; the choice is saved and survives restarts, and the wallet picks it up on its next call. " +
        "Under live, wallet_create_deposit produces REAL Pix charges and wallet_create_withdrawal moves real money: " +
        "confirm with the operator before switching. If DEPIX_API_KEY is set in the environment it still OVERRIDES " +
        "the choice, and the response says so.",
      inputSchema: {
        mode: z.enum(["test", "live"]).describe("Which key to activate: test (sandbox) or live (production starter)."),
      },
      outputSchema: {
        active_key_mode: z.enum(["test", "live"]).describe("Which key is active now."),
        active_key_source: z
          .enum(["env", "store", "owner"])
          .describe(
            "Which credential the server actually authenticates with now: \"store\" = the key just activated, " +
              "\"env\" = DEPIX_API_KEY, \"owner\" = the operator's own login (selected with `account use owner`).",
          ),
        env_override: z.boolean().describe("true when DEPIX_API_KEY shadows the activated key."),
        warning: z.string().nullable().describe("A loud note when the activated key is not the one in use, else null."),
      },
      annotations: write,
    },
    (args) => run(() => activateKey(deps, (args as { mode: ActiveKeyMode }).mode)),
  );

  server.registerTool(
    "create_key",
    {
      title: "Mint an API key for this account",
      description:
        "Mint a NEW API key for the account registered on this machine and start using it. The key is sealed in the " +
        "local encrypted vault and NEVER shown — the response carries only public facts (id, prefix, scopes, limits). " +
        "Defaults to a sandbox key with the wallet scopes, the only set that always works. `merchant_read`/" +
        "`merchant_write` (being paid by third parties) need a VERIFIED DOMAIN — call `verify_domain` first, which " +
        "mints that key for you; asking for them without one is refused with domain_required. `live: true` needs the " +
        "account to be graduated, else graduation_pending. Minting replaces the vault's key for that mode, so the " +
        "OLD one keeps working at the server until you revoke it with revoke_key — and its local copy is gone, so revoke it or " +
        "note the id from agent_status. Five keys per mode is the ceiling.",
      inputSchema: {
        live: z.boolean().optional().describe("true = production sk_live_ (requires graduation); omitted/false = sandbox sk_test_."),
        scopes: z
          .array(z.enum(["merchant_read", "merchant_write", "wallet_read", "wallet_write"]))
          .min(1)
          .optional()
          .describe("Scope set. Omitted = wallet_read + wallet_write. merchant_* requires a verified domain."),
        label: z.string().max(100).optional().describe("Human-readable label, for the operator's own key list."),
        per_tx_limit_cents: z.number().int().min(100).optional().describe("Per-transaction ceiling in cents. wallet_write keys get a default if unset."),
        daily_limit_cents: z.number().int().min(100).optional().describe("Daily ceiling in cents. wallet_write keys get a default if unset."),
        activate: z
          .boolean()
          .optional()
          .describe(
            "Whether to make this MODE the active one. Omitted/true = yes. It cannot keep an older key of the SAME mode in use: " +
              "the vault holds one key per mode, so minting into a mode always supersedes what was there. Use false only to mint " +
              "for the other mode without leaving the one you are on.",
          ),
      },
      outputSchema: {
        key_id: z.string().describe("The new key's id — what revoke_key takes."),
        prefix: z.string().describe("sk_test_ or sk_live_."),
        is_live: z.boolean(),
        scopes: z.string().describe("Space-separated scopes actually granted."),
        per_tx_limit_cents: z.number().nullable(),
        daily_limit_cents: z.number().nullable(),
        active_key_mode: z.enum(["test", "live"]).describe("Which key the server authenticates with now."),
        active_key_source: z.enum(["env", "store", "owner"]).describe("Which credential actually wins."),
        env_override: z.boolean().describe("true when DEPIX_API_KEY shadows the new key."),
        warning: z.string().nullable().describe("A loud note when the new key is not the one in use, else null."),
      },
      annotations: write,
    },
    (args) =>
      run(() =>
        createKey(
          deps,
          args as {
            live?: boolean;
            scopes?: string[];
            label?: string;
            per_tx_limit_cents?: number;
            daily_limit_cents?: number;
            activate?: boolean;
          },
        ),
      ),
  );

  server.registerTool(
    "revoke_key",
    {
      title: "Revoke one of this account's API keys",
      description:
        "Kill an API key, in two phases. Phase 1 (omit confirm): nothing is written — it returns what that key IS " +
        "(prefix, scopes, whether it is the starter) so you can tell the human exactly what is about to die. " +
        "Phase 2 (confirm: true): the key stops working immediately and cannot be restored. ASK THE OPERATOR " +
        "between the two phases. If you revoke the key this server is authenticating with, the next call fails " +
        "until you mint another (create_key) or switch to the other mode (activate_key) — get the id from " +
        "agent_status and be sure which one it is.",
      inputSchema: {
        key_id: z.string().min(1).describe("Id of the key to revoke, as listed by agent_status."),
        confirm: z.boolean().optional().describe("false/omitted = phase 1 (describe it, write nothing); true = phase 2 (revoke it)."),
      },
      outputSchema: {
        phase: z.enum(["confirm_required", "revoked"]),
        key_id: z.string(),
        revoked: z.boolean().describe("true only after phase 2 succeeded."),
        found: z.boolean().describe("Phase 1: does the account own a key with this id?"),
        prefix: z.string().nullable(),
        is_live: z.boolean().nullable(),
        starter: z.boolean().nullable().describe("Phase 1: is this the key registration issued?"),
        scopes: z.string().nullable(),
        already_revoked: z.boolean().nullable(),
        instruction: z.object({ pt: z.string(), en: z.string() }).nullable().describe("Phase 1: what to relay to the human."),
      },
      annotations: write,
    },
    (args) => run(() => revokeKey(deps, args as { key_id: string; confirm?: boolean })),
  );

  return { toolNames: AGENT_TOOL_NAMES };
}
