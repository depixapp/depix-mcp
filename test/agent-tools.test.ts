// The 3 agent-local tools (§3.1/§3.2/§3.3), driven through a real McpServer +
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
import { registerAgentTools, type AgentLike, type AgentToolDeps, type KeyActivation } from "../src/agent-tools.js";
import type { RegisterResult } from "../src/wallet-engine/agent.js";

const REGISTER_RESULT: RegisterResult = {
  agent: { username: "agent_ab12", publicKey: "aa".repeat(32), accountType: "agent" },
  merchant: { id: "mrc_1", merchantSlug: "agent-ab12", liquidAddress: "lq1qpayout", webhookSecret: "whsec_TOPSECRET", defaultCallbackUrl: null },
  keys: {
    test: { id: "key_test_1", key: "sk_test_SECRETVALUE", scopes: "merchant_read merchant_write wallet_read" },
    liveStarter: { id: "key_live_1", key: "sk_live_SECRETVALUE", scopes: "wallet_read", starter: true },
  },
  graduation: { blocked_on: "deposits", settled: 0 },
  limits: { per_tx_cents: 10000, daily_cents: 50000 },
};

class FakeAgent implements AgentLike {
  readonly publicKeyHex = "aa".repeat(32);
  registered?: unknown;
  async register(input: unknown): Promise<RegisterResult> {
    this.registered = input;
    return REGISTER_RESULT;
  }
  async status() {
    return {
      accountStatus: "active" as const,
      settledPersonalDeposits: 3,
      graduated: false,
      graduationBlockedOn: "deposits",
      keys: [{ id: "key_test_1", prefix: "sk_test_ab", isLive: false, starter: false, scopes: "merchant_read", revokedAt: null }],
    };
  }
  verifyDomain(domain: string): Promise<{ recordName: string; recordValue: string }>;
  verifyDomain(domain: string, options: { confirm: true }): Promise<{ verifiedDomain: string }>;
  async verifyDomain(domain: string, options?: { confirm?: boolean }): Promise<{ recordName: string; recordValue: string } | { verifiedDomain: string }> {
    if (options?.confirm) return { verifiedDomain: domain };
    return { recordName: `_depix-verify.${domain}`, recordValue: "depix-verify=abc123" };
  }
}

function baseDeps(over: Partial<AgentToolDeps> = {}): AgentToolDeps {
  const activation: KeyActivation = { activeMode: "test", source: "store", envOverride: false };
  return {
    getWallet: async () => ({ getReceiveAddress: async () => "lq1qpayout" }),
    openAgent: async () => new FakeAgent(),
    createAgent: async () => new FakeAgent(),
    persistKeys: async () => activation,
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
});

describe("agent_status / verify_domain (§3.2/§3.3)", () => {
  it("agent_status narrates the server's report", async () => {
    const client = await connect(baseDeps());
    const out = structured(await client.callTool({ name: "agent_status", arguments: {} }));
    expect(out.account_status).toBe("active");
    expect(out.settled_personal_deposits).toBe(3);
    expect(out.graduated).toBe(false);
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
