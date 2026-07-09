// Verifies the server registers EXACTLY the 16 tools of Appendix A and that a
// tool call flows through the McpServer to an isError result on an API error,
// with the key never leaking.

import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiClient } from "../src/apiClient.js";
import { createServer } from "../src/server.js";
import { makeFetch, errorEnvelope } from "./helpers/mockFetch.js";

const BASE = "https://api.depixapp.com";
const KEY = "sk_test_ABC";

const EXPECTED_TOOLS = [
  "create_checkout",
  "get_checkout",
  "list_checkouts",
  "simulate_checkout_payment",
  "wait_for_checkout",
  "create_product",
  "list_products",
  "get_product",
  "update_product",
  "activate_product",
  "deactivate_product",
  "set_featured_products",
  "list_product_checkouts",
  "get_account",
  "get_deposit_status",
  "get_withdrawal_status",
].sort();

async function connect(apiClient: ApiClient) {
  const server = createServer({ apiBase: BASE, maxWaitSeconds: 120, apiClient, version: "1.0.0" });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

describe("tool catalog (Appendix A — 16 tools, no cancel_checkout)", () => {
  it("registers exactly the 16 tools", async () => {
    const { fetchImpl } = makeFetch([]);
    const { client } = await connect(new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
    expect(names).not.toContain("cancel_checkout");
    expect(names.length).toBe(16);
  });

  it("advertises structured output schemas", async () => {
    const { fetchImpl } = makeFetch([]);
    const { client } = await connect(new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl }));
    const { tools } = await client.listTools();
    const getAccount = tools.find((t) => t.name === "get_account");
    expect(getAccount?.outputSchema).toBeDefined();
  });

  it("advertises NO $ref anywhere in the tool schemas (hosts may not resolve them)", async () => {
    const { fetchImpl } = makeFetch([]);
    const { client } = await connect(new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl }));
    const { tools } = await client.listTools();
    const serialized = JSON.stringify(tools);
    expect(serialized).not.toContain('"$ref"');
    // Both money aliases keep their own inline schema + description.
    const create = tools.find((t) => t.name === "create_checkout");
    const props = (create?.inputSchema as { properties: Record<string, { type?: string }> })
      .properties;
    expect(props.amount.type).toBe("integer");
    expect(props.amount_cents.type).toBe("integer");
  });
});

describe("tool call error surfacing", () => {
  it("returns an isError result (not a thrown protocol error) on an API error", async () => {
    const { fetchImpl } = makeFetch([
      { status: 403, json: errorEnvelope("insufficient_scope", { details: { required_scope: "merchant_read" } }) },
    ]);
    const { client } = await connect(new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl, sleep: async () => {} }));
    const result = await client.callTool({ name: "get_account", arguments: {} });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("merchant_read");
  });

  it("text block carries the FULL JSON (no truncation), matching structuredContent", async () => {
    const bigDescription = "x".repeat(5000);
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        json: {
          checkout: {
            id: "chk_big",
            status: "pending",
            amount: 1500,
            description: bigDescription,
            image_url: null,
            pix_payload: "00020126",
            callback_url: null,
            redirect_url: null,
            metadata: null,
            expires_at: "2026-07-01 12:20:00",
            is_live: 0,
            created_at: "2026-07-01 12:00:00",
            processing_at: null,
            approved_at: null,
            completed_at: null,
            cancelled_at: null,
            blockchain_tx_id: null,
            rejection_reasons: [],
          },
        },
      },
    ]);
    const { client } = await connect(new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl }));
    const result = await client.callTool({ name: "get_checkout", arguments: { checkout_id: "chk_big" } });
    const textBlock = (result.content as Array<{ type: string; text: string }>)[0];
    const parsed = JSON.parse(textBlock.text); // valid JSON — would throw if truncated
    expect(parsed).toEqual(result.structuredContent);
    expect(parsed.description.length).toBe(5000);
  });

  it("get_account success returns structured content", async () => {
    const { fetchImpl } = makeFetch([
      { status: 200, json: { merchant_id: "mrc_1", name: "L", username: null, merchant_slug: "l", is_live: false, created_at: "2026-01-01 00:00:00" } },
    ]);
    const { client } = await connect(new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl }));
    const result = await client.callTool({ name: "get_account", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { is_live: boolean }).is_live).toBe(false);
  });

  it("never leaks the API key through the server path", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    const { fetchImpl } = makeFetch([
      { status: 200, json: { merchant_id: "mrc_1", name: "L", username: null, merchant_slug: "l", is_live: false, created_at: "x" }, headers: { "x-request-id": "req_1" } },
    ]);
    const { client } = await connect(new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl }));
    await client.callTool({ name: "get_account", arguments: {} });
    spy.mockRestore();
    expect(writes.join("")).not.toContain(KEY);
  });
});
