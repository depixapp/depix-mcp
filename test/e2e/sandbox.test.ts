// End-to-end against the REAL sandbox API (spec §8.3). Skipped unless
// DEPIX_TEST_KEY (an sk_test_ key) is set. Proves the DoD flow without touching
// production: get_account → create_checkout → simulate → wait = completed, and a
// sandbox_* deposit read = depix_sent.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiClient } from "../../src/apiClient.js";
import { createServer } from "../../src/server.js";
import { resolveApiBase } from "../../src/config.js";

const TEST_KEY = process.env.DEPIX_TEST_KEY;
// Matches the quickstart CPF (spec §7.4) so docs and e2e cannot silently diverge.
const TEST_CPF = "52998224725";

describe.skipIf(!TEST_KEY)("e2e sandbox (real API)", () => {
  async function connect() {
    const apiClient = new ApiClient({ apiKey: TEST_KEY, apiBase: resolveApiBase() });
    const server = createServer({ apiBase: resolveApiBase(), maxWaitSeconds: 120, apiClient });
    const client = new Client({ name: "e2e", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("runs the DoD flow: account → checkout → simulate → wait completed", async () => {
    const client = await connect();

    const account = await client.callTool({ name: "get_account", arguments: {} });
    expect((account.structuredContent as { is_live: boolean }).is_live).toBe(false);

    const created = await client.callTool({
      name: "create_checkout",
      arguments: { amount: 1500, payer_tax_number: TEST_CPF },
    });
    const checkout = created.structuredContent as { id: string; is_live: boolean };
    expect(checkout.id).toMatch(/^chk_/);
    expect(checkout.is_live).toBe(false);

    await client.callTool({
      name: "simulate_checkout_payment",
      arguments: { checkout_id: checkout.id },
    });

    const waited = await client.callTool({
      name: "wait_for_checkout",
      arguments: { checkout_id: checkout.id, timeout_seconds: 60 },
    });
    const result = waited.structuredContent as { status: string; terminal: boolean };
    expect(result.status).toBe("completed");
    expect(result.terminal).toBe(true);
  }, 90_000);

  it("reads a sandbox_* deposit as depix_sent", { timeout: 30_000 }, async (ctx) => {
    const client = await connect();
    const dep = await client.callTool({
      name: "get_deposit_status",
      arguments: { deposit_id: "sandbox_deadbeef" },
    });
    if (dep.isError) {
      const text = JSON.stringify(dep.content);
      if (text.includes("insufficient_scope")) {
        // Explicit, visible skip — the test key lacks wallet_read. Any other
        // error is a REAL failure, never silently swallowed.
        ctx.skip();
        return;
      }
      throw new Error(`get_deposit_status failed: ${text}`);
    }
    const status = (dep.structuredContent as { status?: string } | undefined)?.status;
    expect(status).toBe("depix_sent");
  });
});
