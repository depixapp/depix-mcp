// The 7 agent-local tools (§3.1/§3.2/§3.3), driven through a real McpServer +
// client. The load-bearing proofs (smoke S3.1–S3.5):
//   - register_account returns PUBLIC facts only — NO sk_, keypair or webhook
//     secret ever reaches the transcript;
//   - the minted key is persisted + activated so the next request uses it;
//   - an env key overriding the new one is reported LOUDLY (not operated silently);
//   - a persistence failure says "account created, keys lost" — never a false OK.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AGENT_TOOL_NAMES, registerAgentTools, type AgentLike, type AgentToolDeps, type KeyActivation } from "../src/agent-tools.js";
import type { RegisterResult } from "../src/wallet-engine/agent.js";

const REGISTER_RESULT: RegisterResult = {
  agent: { username: "agent_ab12", publicKey: "aa".repeat(32), accountType: "agent" },
  merchant: { id: "mrc_1", merchantSlug: "agent-ab12", liquidAddress: "lq1qpayout", webhookSecret: "whsec_TOPSECRET", defaultCallbackUrl: null },
  keys: {
    test: { id: "key_test_1", key: "sk_test_SECRETVALUE", scopes: "merchant_read merchant_write wallet_read" },
    liveStarter: { id: "key_live_1", key: "sk_live_SECRETVALUE", scopes: "wallet_read", starter: true },
  },
  graduation: { requires: "domain_proof", verify_domain_endpoint: "POST /api/agents/verify-domain", allowed_tlds_endpoint: "GET /api/agents/domain-tlds" },
  pacing: {
    first_deposit_max_cents: 10000,
    unverified_per_tx_max_cents: 10000,
    inter_deposit_delay_hours: 24,
    payer_velocity: { max_per_window: 2, window_minutes: 30 },
    verified_per_tx_deposit_max_cents: 600000,
    verified_per_tx_withdraw_send_max_cents: 600000,
    verified_per_tx_withdraw_receive_max_cents: 600000,
  },
};

class FakeAgent implements AgentLike {
  readonly publicKeyHex = "aa".repeat(32);
  registered?: unknown;
  /** Non-empty makes status() report a suspended account carrying this reason. */
  constructor(private readonly suspension?: string) {}
  async register(input: unknown): Promise<RegisterResult> {
    this.registered = input;
    return REGISTER_RESULT;
  }
  async status() {
    return {
      accountStatus: (this.suspension ? "suspended" : "active") as "active" | "suspended",
      graduated: false,
      graduationBlockedOn: "domain_proof",
      keys: this.statusKeys ?? [{ id: "key_test_1", prefix: "sk_test_ab", isLive: false, starter: false, scopes: "merchant_read", revokedAt: null }],
      ...(this.suspension ? { reason: this.suspension } : {}),
    };
  }
  /** Flip to false to exercise "proof recorded, account did not verify". */
  domainVerifies = true;
  /** Set to make the upgrade mint fail the way the backend refuses it. */
  createKeyError: (Error & { code?: string }) | null = null;
  /** Set to make the post-mint revoke fail (a stale key, never a lost account). */
  revokeKeyError: Error | null = null;
  statusKeys: Array<{ id: string; prefix: string; isLive: boolean; starter: boolean; scopes: string; revokedAt: string | null }> | null = null;
  createdKeys: Array<Record<string, unknown>> = [];
  revokedKeyIds: string[] = [];
  verifyDomain(domain: string): Promise<{ recordName: string; recordValue: string }>;
  verifyDomain(domain: string, options: { confirm: true }): Promise<{ verifiedDomain: string; verified: boolean }>;
  async verifyDomain(domain: string, options?: { confirm?: boolean }): Promise<{ recordName: string; recordValue: string } | { verifiedDomain: string; verified: boolean }> {
    if (options?.confirm) return { verifiedDomain: domain, verified: this.domainVerifies };
    return { recordName: `_depix-verify.${domain}`, recordValue: "depix-verify=abc123" };
  }
  async createKey(input: { live?: boolean; scopes?: string[]; label?: string } = {}) {
    if (this.createKeyError) throw this.createKeyError;
    this.createdKeys.push(input as Record<string, unknown>);
    const live = input.live === true;
    return {
      id: `key_new_${this.createdKeys.length}`,
      key: `${live ? "sk_live_" : "sk_test_"}minted${this.createdKeys.length}`,
      prefix: live ? "sk_live_" : "sk_test_",
      isLive: live,
      scopes: (input.scopes ?? ["wallet_read", "wallet_write"]).join(" "),
      perTxLimitCents: null,
      dailyLimitCents: null,
    };
  }
  async revokeKey(id: string) {
    if (this.revokeKeyError) throw this.revokeKeyError;
    this.revokedKeyIds.push(id);
    return { id, revoked: true };
  }
  configuredRail?: Record<string, unknown>;
  configureDepixRail(input: { enabled: true; address: string; blindingKey: string; derivationIndex?: number | null }): Promise<{ enabled: true; address: string; derivationIndex: number | null; discountPct: number }>;
  configureDepixRail(input: { enabled: false }): Promise<{ enabled: false; viewKeyDeleted: boolean; pendingAddresses: number }>;
  async configureDepixRail(
    input:
      | { enabled: true; address: string; blindingKey: string; derivationIndex?: number | null }
      | { enabled: false },
  ) {
    this.configuredRail = { ...input };
    if (!input.enabled) return { enabled: false as const, viewKeyDeleted: true, pendingAddresses: 0 };
    return { enabled: true as const, address: input.address.toLowerCase(), derivationIndex: input.derivationIndex ?? null, discountPct: 1.5 };
  }
}

/** A sentinel view key the tool must NEVER echo back into the transcript or a log. */
const SECRET_BLINDING_KEY = "SENTINEL_BLINDING_KEY_DEADBEEFCAFE";

function baseDeps(over: Partial<AgentToolDeps> = {}): AgentToolDeps {
  const activation: KeyActivation = { activeMode: "test", source: "store", envOverride: false };
  return {
    getWallet: async () => ({
      getReceiveAddress: async () => "lq1qpayout",
      deriveDepixPayCredential: async (opts?: { index?: number }) => ({
        address: "lq1qdedicated",
        blindingKey: SECRET_BLINDING_KEY,
        derivationIndex: opts?.index ?? 12,
      }),
    }),
    keyState: async () => ({ active: "test" as const, hasLive: false }),
    replaceKey: async ({ mode }) => ({ activeMode: mode, source: "store" as const, envOverride: false }),
    openAgent: async () => new FakeAgent(),
    createAgent: async () => new FakeAgent(),
    persistKeys: async () => activation,
    activateKey: async (mode) => ({ ...activation, activeMode: mode }),
    ...over,
  };
}

async function connect(deps: AgentToolDeps): Promise<Client> {
  const server = new McpServer({ name: "test", title: "t", version: "1.0.0" });
  registerAgentTools(server, deps);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function payloadText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content.map((c) => c.text).join(" ");
}
function structured(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;
}

describe("register_account (§3.1)", () => {
  it("S3.1: returns PUBLIC facts only — no sk_, keypair, or webhook secret in the transcript", async () => {
    const client = await connect(baseDeps());
    const result = await client.callTool({
      name: "register_account",
      arguments: { name: "Acme", operator_token: "op_xyz", operator_email: "op@acme.com" },
    });
    expect(result.isError).toBeFalsy();
    const text = payloadText(result);
    // The whole transcript (message + structured JSON) must not carry any secret.
    expect(text).not.toContain("sk_test_SECRETVALUE");
    expect(text).not.toContain("sk_live_SECRETVALUE");
    expect(text).not.toContain("whsec_TOPSECRET");
    // …but it DOES carry the public facts + the key IDs.
    const out = structured(result);
    expect(out.username).toBe("agent_ab12");
    expect(out.merchant_slug).toBe("agent-ab12");
    expect(out.test_key_id).toBe("key_test_1");
    expect(out.active_key_mode).toBe("test");
    expect(out.warning).toBeNull();
  });

  it("surfaces the server's pacing block, nested payer_velocity included", async () => {
    const client = await connect(baseDeps());
    const result = await client.callTool({
      name: "register_account",
      arguments: { name: "Acme", operator_token: "op_xyz", operator_email: "op@acme.com" },
    });
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    // payer_velocity is the only nested value here, and the one an agent has no
    // other way to learn (see pacingOnly).
    expect(out.pacing).toEqual({
      first_deposit_max_cents: 10000,
      unverified_per_tx_max_cents: 10000,
      inter_deposit_delay_hours: 24,
      payer_velocity: { max_per_window: 2, window_minutes: 30 },
      verified_per_tx_deposit_max_cents: 600000,
      verified_per_tx_withdraw_send_max_cents: 600000,
      verified_per_tx_withdraw_receive_max_cents: 600000,
    });
    expect(out).not.toHaveProperty("limits");
  });

  it("R6: an owner login selected on this machine leaves the new key IDLE, and says so", async () => {
    // Persisting a key is not the same as USING it. `account use owner` shadows
    // it just as an env key does — reporting only the env case left this one
    // silent, and the agent went on believing it operated the account it had
    // just created.
    const client = await connect(
      baseDeps({ persistKeys: async () => ({ activeMode: "test", source: "owner", envOverride: false }) }),
    );
    const out = structured(
      await client.callTool({
        name: "register_account",
        arguments: { name: "Acme", operator_token: "op_xyz", operator_email: "op@acme.com" },
      }),
    );
    expect(out.active_key_source).toBe("owner");
    expect(out.env_override).toBe(false);
    expect(String(out.warning)).toMatch(/IDLE/);
    expect(String(out.warning)).toContain("account use agent");
  });

  it("S3.4: an env key overriding the new one is reported LOUDLY", async () => {
    const client = await connect(
      baseDeps({ persistKeys: async () => ({ activeMode: "test", source: "env", envOverride: true }) }),
    );
    const result = await client.callTool({
      name: "register_account",
      arguments: { name: "Acme", operator_token: "op_xyz", operator_email: "op@acme.com" },
    });
    const out = structured(result);
    expect(out.env_override).toBe(true);
    expect(out.active_key_source).toBe("env");
    expect(String(out.warning)).toMatch(/OVERRIDES/);
  });

  it("S3.5: a persistence failure says the keys are lost — never a false success", async () => {
    const client = await connect(
      baseDeps({
        persistKeys: async () => {
          throw new Error("disk full");
        },
      }),
    );
    const result = await client.callTool({
      name: "register_account",
      arguments: { name: "Acme", operator_token: "op_xyz", operator_email: "op@acme.com" },
    });
    expect(result.isError).toBe(true);
    const text = payloadText(result);
    expect(text).toContain("credentials_persist_failed");
    expect(text).toMatch(/created/i);
    expect(text).toMatch(/lost/i);
    // Still no secret leaked on the failure path.
    expect(text).not.toContain("sk_test_SECRETVALUE");
  });

  it("fails with wallet_not_configured when no wallet exists (payout address needed)", async () => {
    const client = await connect(baseDeps({ getWallet: async () => null }));
    const result = await client.callTool({
      name: "register_account",
      arguments: { name: "Acme", operator_token: "op_xyz", operator_email: "op@acme.com" },
    });
    expect(result.isError).toBe(true);
    expect(payloadText(result)).toContain("wallet_not_configured");
  });

  it("falls back to DEPIX_OPERATOR_TOKEN when the tool arg is omitted (§3.7 #7)", async () => {
    const agent = new FakeAgent();
    process.env.DEPIX_OPERATOR_TOKEN = "op_from_env";
    try {
      const client = await connect(baseDeps({ openAgent: async () => agent }));
      // No operator_token arg — init's "connect now" wrote it to the config env.
      const result = await client.callTool({
        name: "register_account",
        arguments: { name: "Acme", operator_email: "op@acme.com" },
      });
      expect(result.isError).toBeFalsy();
      expect((agent.registered as { operatorToken: string }).operatorToken).toBe("op_from_env");
    } finally {
      delete process.env.DEPIX_OPERATOR_TOKEN;
    }
  });

  it("returns a typed operator_token_required step when neither the arg nor the env is set", async () => {
    delete process.env.DEPIX_OPERATOR_TOKEN;
    const client = await connect(baseDeps());
    const result = await client.callTool({
      name: "register_account",
      arguments: { name: "Acme", operator_email: "op@acme.com" },
    });
    expect(result.isError).toBe(true);
    expect(payloadText(result)).toContain("operator_token_required");
  });
});

describe("agent_status / verify_domain (§3.2/§3.3)", () => {
  it("agent_status narrates the server's report", async () => {
    const client = await connect(baseDeps());
    const result = await client.callTool({ name: "agent_status", arguments: {} });
    // A schema mismatch returns isError with NO structuredContent, and every
    // assertion below would then read an empty object and pass on nothing.
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.account_status).toBe("active");
    expect(out.graduated).toBe(false);
    expect(out.graduation_blocked_on).toBe("domain_proof");
    // A required field the server stopped sending fails output validation on
    // every call, so the deposit counter API 0.23.0 dropped must stay gone.
    expect(out).not.toHaveProperty("settled_personal_deposits");
  });

  it("agent_status carries a suspension reason", async () => {
    const client = await connect(baseDeps({ openAgent: async () => new FakeAgent("Paused by the platform.") }));
    const result = await client.callTool({ name: "agent_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.account_status).toBe("suspended");
    expect(out.reason).toBe("Paused by the platform.");
  });

  it("agent_status without an identity points at register_account", async () => {
    const client = await connect(baseDeps({ openAgent: async () => null }));
    const result = await client.callTool({ name: "agent_status", arguments: {} });
    expect(result.isError).toBe(true);
    const text = payloadText(result);
    expect(text).toContain("agent_not_initialized");
    // The next_action tells the agent how to fix it.
    expect(text).toContain("register_account");
  });

  it("verify_domain phase 1 returns the TXT challenge to relay; phase 2 confirms", async () => {
    const client = await connect(baseDeps());
    const p1 = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com" } }));
    expect(p1.phase).toBe("challenge");
    expect(p1.record_name).toBe("_depix-verify.acme.com");
    expect(p1.record_value).toBe("depix-verify=abc123");
    expect((p1.instruction as { pt: string }).pt).toContain("_depix-verify.acme.com");

    const p2 = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));
    expect(p2.phase).toBe("confirm");
    expect(p2.verified_domain).toBe("acme.com");
  });
});

describe("configure_depix_rail (§3.9)", () => {
  it("S3.9a: the tool is one of the agent-local catalog (now 7)", () => {
    expect(AGENT_TOOL_NAMES).toContain("configure_depix_rail");
    expect(AGENT_TOOL_NAMES).toContain("activate_key");
    expect(AGENT_TOOL_NAMES).toContain("create_key");
    expect(AGENT_TOOL_NAMES).toContain("revoke_key");
    expect(AGENT_TOOL_NAMES.length).toBe(7);
  });

  it("S3.9b: enable returns PUBLIC facts only — the blinding key NEVER reaches the transcript", async () => {
    const agent = new FakeAgent();
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const result = await client.callTool({ name: "configure_depix_rail", arguments: { enabled: true } });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.enabled).toBe(true);
    expect(out.depix_pay_enabled).toBe(true);
    expect(out.depix_pay_address).toBe("lq1qdedicated");
    expect(out.derivation_index).toBe(12);
    expect(out.discount_pct).toBe(1.5);

    // THE proof: the whole serialized result (message text + structured JSON)
    // carries no trace of the derived view key.
    const whole = payloadText(result) + JSON.stringify(out);
    expect(whole).not.toContain(SECRET_BLINDING_KEY);
    expect(whole).not.toMatch(/blinding/i);

    // …and yet the key DID reach the signed backend call (it transits by design).
    expect(agent.configuredRail).toMatchObject({ enabled: true, address: "lq1qdedicated", blindingKey: SECRET_BLINDING_KEY, derivationIndex: 12 });
  });

  it("S3.9c: forwards an explicit derivation_index to the derivation", async () => {
    const agent = new FakeAgent();
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "configure_depix_rail", arguments: { enabled: true, derivation_index: 5 } }));
    expect(out.derivation_index).toBe(5);
    expect(agent.configuredRail).toMatchObject({ derivationIndex: 5 });
  });

  it("S3.9d: disable needs no wallet and sends no key", async () => {
    const agent = new FakeAgent();
    const client = await connect(baseDeps({ openAgent: async () => agent, getWallet: async () => null }));
    const out = structured(await client.callTool({ name: "configure_depix_rail", arguments: { enabled: false } }));
    expect(out.enabled).toBe(false);
    expect(out.depix_pay_enabled).toBe(false);
    expect(out.view_key_deleted).toBe(true);
    expect(out.pending_addresses).toBe(0);
    expect(agent.configuredRail).toEqual({ enabled: false });
  });

  it("S3.9e: enable without a wallet → wallet_not_configured", async () => {
    const client = await connect(baseDeps({ getWallet: async () => null }));
    const result = await client.callTool({ name: "configure_depix_rail", arguments: { enabled: true } });
    expect(result.isError).toBe(true);
    expect(payloadText(result)).toContain("wallet_not_configured");
  });

  it("S3.9f: no agent account → agent_not_initialized pointing at register_account", async () => {
    const client = await connect(baseDeps({ openAgent: async () => null }));
    const result = await client.callTool({ name: "configure_depix_rail", arguments: { enabled: true } });
    expect(result.isError).toBe(true);
    const text = payloadText(result);
    expect(text).toContain("agent_not_initialized");
    expect(text).toContain("register_account");
  });
});

describe("activate_key", () => {
  it("A1: switches to the live key and reports it as the one in use", async () => {
    const seen: string[] = [];
    const client = await connect(
      baseDeps({
        activateKey: async (mode) => {
          seen.push(mode);
          return { activeMode: mode, source: "store", envOverride: false };
        },
      }),
    );
    const result = await client.callTool({ name: "activate_key", arguments: { mode: "live" } });
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual(["live"]);
    const out = structured(result);
    expect(out.active_key_mode).toBe("live");
    expect(out.active_key_source).toBe("store");
    expect(out.env_override).toBe(false);
    expect(out.warning).toBeNull();
    // Never a secret in the transcript — the tool only moves a pointer.
    expect(payloadText(result)).not.toMatch(/sk_(test|live)_/);
  });

  it("A2: an env key still OVERRIDES the choice, and the tool says so LOUDLY", async () => {
    const client = await connect(
      baseDeps({ activateKey: async (mode) => ({ activeMode: mode, source: "env", envOverride: true }) }),
    );
    const out = structured(await client.callTool({ name: "activate_key", arguments: { mode: "live" } }));
    expect(out.env_override).toBe(true);
    expect(out.active_key_source).toBe("env");
    expect(String(out.warning)).toMatch(/OVERRIDES/);
  });

  it("A3: the owner login selected on this machine leaves the activated key IDLE, and says so", async () => {
    const client = await connect(
      baseDeps({ activateKey: async (mode) => ({ activeMode: mode, source: "owner", envOverride: false }) }),
    );
    const out = structured(await client.callTool({ name: "activate_key", arguments: { mode: "live" } }));
    expect(out.active_key_source).toBe("owner");
    expect(String(out.warning)).toMatch(/IDLE/);
    expect(String(out.warning)).toContain("account use agent");
  });

  it("A4: a vault without a live key is a typed live_key_missing, not a silent sandbox", async () => {
    const { ToolError } = await import("../src/wallet-engine/mcp/errors.js");
    const client = await connect(
      baseDeps({
        activateKey: async () => {
          throw new ToolError("no live key", "live_key_missing");
        },
      }),
    );
    const result = await client.callTool({ name: "activate_key", arguments: { mode: "live" } });
    expect(result.isError).toBe(true);
    expect(payloadText(result)).toContain("live_key_missing");
  });

  it("A5: rejects anything but test|live at the schema — the deps are never reached", async () => {
    let invoked = 0;
    const client = await connect(
      baseDeps({
        activateKey: async (mode) => {
          invoked += 1;
          return { activeMode: mode, source: "store", envOverride: false };
        },
      }),
    );
    const result = await client.callTool({ name: "activate_key", arguments: { mode: "prod" } });
    expect(result.isError).toBe(true);
    expect(payloadText(result)).toMatch(/Input validation error/);
    expect(invoked).toBe(0);
  });

  it("A6: the env-override warning speaks of the key just ACTIVATED, not one just created", async () => {
    const client = await connect(
      baseDeps({ activateKey: async (mode) => ({ activeMode: mode, source: "env", envOverride: true }) }),
    );
    const out = structured(await client.callTool({ name: "activate_key", arguments: { mode: "live" } }));
    expect(String(out.warning)).toContain("just activated");
    expect(String(out.warning)).not.toContain("just registered");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// create_key / revoke_key (§3.10) and the verify_domain upgrade
// ────────────────────────────────────────────────────────────────────────────

describe("create_key", () => {
  it("returns PUBLIC facts only — the minted sk_ NEVER reaches the transcript", async () => {
    const agent = new FakeAgent();
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const result = await client.callTool({ name: "create_key", arguments: {} });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.key_id).toBe("key_new_1");
    expect(out.prefix).toBe("sk_test_");
    expect(out.scopes).toBe("wallet_read wallet_write");
    expect(JSON.stringify(result)).not.toContain("sk_test_minted1");
  });

  it("defaults to the scopes that need neither a domain nor graduation", async () => {
    const agent = new FakeAgent();
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    await client.callTool({ name: "create_key", arguments: {} });
    expect(agent.createdKeys[0]).toMatchObject({ live: false, scopes: ["wallet_read", "wallet_write"] });
  });

  it("seals the key in the requested slot and activates it unless told otherwise", async () => {
    const agent = new FakeAgent();
    const seen: Array<Record<string, unknown>> = [];
    const client = await connect(
      baseDeps({
        openAgent: async () => agent,
        replaceKey: async (input) => {
          seen.push(input as unknown as Record<string, unknown>);
          return { activeMode: input.mode, source: "store" as const, envOverride: false };
        },
      }),
    );
    await client.callTool({ name: "create_key", arguments: { live: true, activate: false } });
    expect(seen[0]).toMatchObject({ key: "sk_live_minted1", mode: "live", activate: false });
  });
});

describe("revoke_key", () => {
  it("phase 1 writes NOTHING and describes what is about to die", async () => {
    const agent = new FakeAgent();
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "revoke_key", arguments: { key_id: "key_test_1" } }));

    expect(out.phase).toBe("confirm_required");
    expect(out.revoked).toBe(false);
    expect(out.found).toBe(true);
    expect(out.scopes).toBe("merchant_read");
    expect(agent.revokedKeyIds).toEqual([]);
  });

  it("phase 1 says so when the account owns no such key", async () => {
    const agent = new FakeAgent();
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "revoke_key", arguments: { key_id: "nope" } }));
    expect(out.found).toBe(false);
    expect(agent.revokedKeyIds).toEqual([]);
  });

  it("phase 2 revokes only with confirm: true", async () => {
    const agent = new FakeAgent();
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(
      await client.callTool({ name: "revoke_key", arguments: { key_id: "key_test_1", confirm: true } }),
    );
    expect(out.phase).toBe("revoked");
    expect(out.revoked).toBe(true);
    expect(agent.revokedKeyIds).toEqual(["key_test_1"]);
  });
});

describe("verify_domain phase 2 — the merchant-key upgrade", () => {
  /**
   * What registration actually leaves behind. `starter` is set on the sk_live_
   * key ALONE (depix-backend routes/agents.js) — a sk_test_ key never carries
   * it, so a fixture that fabricates one hides the default path.
   */
  function withStarter(agent: FakeAgent) {
    agent.statusKeys = [
      { id: "key_test_starter", prefix: "sk_test_", isLive: false, starter: false, scopes: "wallet_read wallet_write", revokedAt: null },
      { id: "key_live_starter", prefix: "sk_live_", isLive: true, starter: true, scopes: "wallet_read wallet_write", revokedAt: null },
    ];
    return agent;
  }

  it("mints the merchant scopes, activates them, and only THEN revokes the starter", async () => {
    const agent = withStarter(new FakeAgent());
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));

    expect(out.verified).toBe(true);
    expect((out.merchant_key as Record<string, unknown>).scopes).toBe(
      "merchant_read merchant_write wallet_read wallet_write",
    );
    expect(out.previous_key_id).toBe("key_test_starter");
    expect(out.previous_key_revoked).toBe(true);
    expect(out.upgrade_note).toBeNull();
    // The order IS the safety property: a revoke that ran first would leave an
    // account with no usable key whenever the mint is refused.
    expect(agent.createdKeys.length).toBe(1);
    expect(agent.revokedKeyIds).toEqual(["key_test_starter"]);
    // And the secret never rides along.
    expect(JSON.stringify(out)).not.toContain("sk_test_minted1");
  });

  it("a REFUSED mint costs nothing: the domain stands and the old key is untouched", async () => {
    const agent = withStarter(new FakeAgent());
    agent.createKeyError = Object.assign(new Error("no domain"), { code: "domain_required" });
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));

    expect(out.verified_domain).toBe("acme.com");
    expect(out.merchant_key).toBeNull();
    expect(out.previous_key_revoked).toBe(false);
    expect(String(out.upgrade_note)).toContain("domain_required");
    expect(agent.revokedKeyIds).toEqual([]);
  });

  it("never mints when the proof did not verify the account", async () => {
    const agent = withStarter(new FakeAgent());
    agent.domainVerifies = false;
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));

    expect(out.verified).toBe(false);
    expect(out.merchant_key).toBeNull();
    expect(agent.createdKeys).toEqual([]);
    expect(agent.revokedKeyIds).toEqual([]);
  });

  it("a failed revoke leaves a stale key, not a broken account — and says so", async () => {
    const agent = withStarter(new FakeAgent());
    agent.revokeKeyError = new Error("network down");
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));

    expect((out.merchant_key as Record<string, unknown>).key_id).toBe("key_new_1");
    expect(out.previous_key_revoked).toBe(false);
  });
});

describe("the upgrade names the superseded key by census, not by the `starter` flag", () => {
  it("retires the sk_test_ key even though the backend never flags it as starter", async () => {
    const agent = new FakeAgent();
    // Exactly the shape registration leaves: only the LIVE key is `starter`.
    agent.statusKeys = [
      { id: "key_test_1", prefix: "sk_test_", isLive: false, starter: false, scopes: "wallet_read wallet_write", revokedAt: null },
      { id: "key_live_1", prefix: "sk_live_", isLive: true, starter: true, scopes: "wallet_read wallet_write", revokedAt: null },
    ];
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));

    expect(out.previous_key_id).toBe("key_test_1");
    expect(out.previous_key_revoked).toBe(true);
    expect(out.previous_key_note).toBeNull();
    // The LIVE key is a different mode and must survive untouched.
    expect(agent.revokedKeyIds).toEqual(["key_test_1"]);
  });

  it("revokes NOTHING when several keys of the mode are live — it cannot tell which was in the vault", async () => {
    const agent = new FakeAgent();
    agent.statusKeys = [
      { id: "key_test_1", prefix: "sk_test_", isLive: false, starter: false, scopes: "wallet_read wallet_write", revokedAt: null },
      { id: "key_test_2", prefix: "sk_test_", isLive: false, starter: false, scopes: "merchant_read", revokedAt: null },
    ];
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));

    expect(agent.revokedKeyIds).toEqual([]);
    expect(out.previous_key_id).toBeNull();
    expect(String(out.previous_key_note)).toMatch(/several live test keys/);
  });

  it("seals the key in the vault BEFORE revoking — a mint that is never sealed must not cost the old key", async () => {
    const agent = new FakeAgent();
    agent.statusKeys = [
      { id: "key_test_1", prefix: "sk_test_", isLive: false, starter: false, scopes: "wallet_read wallet_write", revokedAt: null },
    ];
    const order: string[] = [];
    const client = await connect(
      baseDeps({
        openAgent: async () => agent,
        replaceKey: async ({ mode }) => {
          order.push("seal");
          return { activeMode: mode, source: "store" as const, envOverride: false };
        },
      }),
    );
    const originalRevoke = agent.revokeKey.bind(agent);
    agent.revokeKey = async (id: string) => {
      order.push("revoke");
      return originalRevoke(id);
    };
    await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } });
    expect(order).toEqual(["seal", "revoke"]);
  });

  it("a vault that will not seal the key revokes nothing", async () => {
    const agent = new FakeAgent();
    agent.statusKeys = [
      { id: "key_test_1", prefix: "sk_test_", isLive: false, starter: false, scopes: "wallet_read wallet_write", revokedAt: null },
    ];
    const client = await connect(
      baseDeps({
        openAgent: async () => agent,
        replaceKey: async () => {
          throw new Error("disk full");
        },
      }),
    );
    const out = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));
    expect(out.merchant_key).toBeNull();
    expect(agent.revokedKeyIds).toEqual([]);
  });
});

describe("the upgrade never claims a fact the census did not establish", () => {
  it("a census that FAILED says so, instead of 'no earlier key was live'", async () => {
    const agent = new FakeAgent();
    let calls = 0;
    agent.status = async () => {
      calls += 1;
      throw new Error("network down");
    };
    const client = await connect(baseDeps({ openAgent: async () => agent }));
    const out = structured(await client.callTool({ name: "verify_domain", arguments: { domain: "acme.com", confirm: true } }));

    expect(calls).toBeGreaterThan(0);
    expect(out.previous_key_revoked).toBe(false);
    // The superseded key may well be alive — the note must send the agent to look.
    expect(String(out.previous_key_note)).toMatch(/census failed/i);
    expect(String(out.previous_key_note)).not.toMatch(/no earlier/i);
  });
});

describe("create_key opens the vault before it mints", () => {
  it("a vault that will not open costs no key and no slot", async () => {
    const agent = new FakeAgent();
    const client = await connect(
      baseDeps({
        openAgent: async () => agent,
        keyState: async () => {
          throw Object.assign(new Error("locked"), { code: "credentials_locked" });
        },
      }),
    );
    const result = await client.callTool({ name: "create_key", arguments: {} });
    expect(result.isError).toBe(true);
    expect(agent.createdKeys).toEqual([]);
  });
});
