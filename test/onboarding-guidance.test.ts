// GUIDANCE IN THE SCHEMA, NOT ONLY IN THE ERROR.
//
// A model reads a tool's schema BEFORE calling it. Field evidence: an agent saw
// that `register_account` wants an `operator_token`, asked the human "where do I
// find that code?" WITHOUT ever calling the tool — so `operator_token_required`
// (which carries the URL in its next_action) never fired, and the agent invented
// wrong advice ("check the dashboard / API settings").
//
// The fix is that every human step is reachable from the DESCRIPTION. These
// tests are the regression lock on that copy: they assert the destinations, not
// the prose, so wording can still be improved.

import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAgentTools, type AgentToolDeps } from "../src/agent-tools.js";
import { NEXT_ACTION_KINDS, OPERATOR_START_URL, nextActionFor } from "../src/next-action.js";
import { gatewaySentences } from "../src/instructions.js";

const INIT_COMMAND = "npx -y @depixapp/mcp init";

const deps: AgentToolDeps = {
  getWallet: () => Promise.resolve(null),
  openAgent: () => Promise.resolve(null),
  createAgent: () => Promise.reject(new Error("not used")),
  persistKeys: () => Promise.reject(new Error("not used")),
};

async function toolCatalog(): Promise<Map<string, { description: string; schema: Record<string, unknown> }>> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAgentTools(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return new Map(
    tools.map((t) => [
      t.name,
      { description: t.description ?? "", schema: (t.inputSchema ?? {}) as Record<string, unknown> },
    ]),
  );
}

function propertyDescription(schema: Record<string, unknown>, field: string): string {
  const properties = (schema.properties ?? {}) as Record<string, { description?: string }>;
  return properties[field]?.description ?? "";
}

describe("register_account guides the human WITHOUT being called", () => {
  it("the operator_token description carries the URL the code actually comes from", async () => {
    const catalog = await toolCatalog();
    const description = propertyDescription(catalog.get("register_account")!.schema, "operator_token");
    expect(description).toContain(OPERATOR_START_URL);
    // The specific wrong answer the field evidence showed a model inventing.
    expect(description).toMatch(/do not send them to the dashboard/i);
    expect(description).toContain("DEPIX_OPERATOR_TOKEN");
  });

  it("the tool description names all three prerequisites, with their destinations", async () => {
    const description = (await toolCatalog()).get("register_account")!.description;
    expect(description).toContain(OPERATOR_START_URL);
    expect(description).toContain(INIT_COMMAND);
    expect(description).toContain("operator_email");
  });

  it("the sibling onboarding tools name their own precondition or human step", async () => {
    const catalog = await toolCatalog();
    expect(catalog.get("agent_status")!.description).toContain("register_account");
    // Only the human can create a DNS record, and the description has to say so.
    expect(catalog.get("verify_domain")!.description).toMatch(/DNS provider/i);
    const rail = catalog.get("configure_depix_rail")!.description;
    expect(rail).toContain(INIT_COMMAND);
    expect(rail).toContain("register_account");
  });
});

describe("the register preconditions all carry a next_action", () => {
  // Every code register_account can fail on BEFORE it reaches the API, plus the
  // server-side conflicts it can come back with. A missing entry here is an
  // agent left with `{"code": "...", "retryable": false}` and nothing to do.
  const codes = [
    "agent_key_unreadable",
    "agent_store_corrupted",
    "agent_not_initialized",
    "wallet_not_configured",
    "operator_token_required",
    "operator_token_missing",
    "invalid_operator_token",
    "operator_token_revoked",
    "operator_oauth_failed",
    "agent_pubkey_exists",
    "username_taken",
    "agents_disabled",
    "registration_blocked",
    "credentials_persist_failed",
    "owner_session_expired",
  ];

  it.each(codes)("%s has a next_action with a valid shape", (code) => {
    const action = nextActionFor(code);
    expect(action, `${code} has no next_action`).toBeDefined();
    expect(NEXT_ACTION_KINDS).toContain(action!.kind);
    // The catalog invariant: relay is present IFF the step belongs to a human.
    expect(action!.relay !== undefined).toBe(action!.kind === "human_step");
  });

  it("agent_key_unreadable names the passphrase AND the command that sets it", () => {
    const action = nextActionFor("agent_key_unreadable")!;
    expect(action.kind).toBe("human_step");
    expect(action.relay!.en).toContain("DEPIX_WALLET_PASSPHRASE");
    expect(action.relay!.en).toContain(INIT_COMMAND);
    expect(action.relay!.pt).toContain(INIT_COMMAND);
  });
});

describe("the handshake's missing-credential sentence branches by deployment", () => {
  it("the LOCAL text points at the tool and the commands that mint a credential", () => {
    const text = gatewaySentences("unified").join(" ");
    expect(text).toContain("register_account");
    expect(text).toContain(OPERATOR_START_URL);
    expect(text).toContain("account use agent|owner");
    // The old sentence told every caller to "reconnect with their key".
    expect(text).not.toContain("ask the user to reconnect with their key configured");
  });

  it("the HOSTED text tells an OAuth caller to reconnect, not to paste a key it has none of", () => {
    const text = gatewaySentences("hosted").join(" ");
    expect(text).toMatch(/OAuth/);
    expect(text).toContain("next_action");
    // A hosted caller cannot run local commands — they must not be advertised.
    expect(text).not.toContain(INIT_COMMAND);
    expect(text).not.toContain("register_account");
  });
});

describe("the local missing-key error names every door (R7)", () => {
  it("mentions register_account, login, DEPIX_API_KEY and the restart caveat", async () => {
    const { missingApiKeyError } = await import("../src/errors.js");
    const err = missingApiKeyError(undefined, "local");
    expect(err.message).toContain("register_account");
    expect(err.message).toContain("login");
    expect(err.message).toContain("DEPIX_API_KEY");
    // The trap: the owner session is seeded at boot, so a `login` run while the
    // server is up changes nothing until the host restarts it.
    expect(err.message).toMatch(/restart/i);
    // next_action stays the one step the AGENT can take by itself.
    expect(err.data.next_action).toEqual({ kind: "call_tool", tool: "register_account" });
  });

  it("the hosted error still says none of that — those doors do not exist there", async () => {
    const { missingApiKeyError } = await import("../src/errors.js");
    expect(missingApiKeyError(undefined, "hosted").message).not.toContain("register_account");
    expect(missingApiKeyError(undefined, "hosted").message).not.toContain("@depixapp/mcp login");
  });
});
