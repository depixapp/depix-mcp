// Anthropic's MCP clients validate tool schemas with a 2020-12-only validator
// and refuse any other declared dialect, and the SDK's zod-v3 converter stamps
// draft-07 on every schema it emits — so an UNSANITIZED transport ships a
// catalog those clients reject at call time (src/schemaDialect.ts).
//
// The load-bearing assertions:
//   - the control PROVES the stamp is still emitted by the SDK on a bare
//     transport. If this one ever fails, the SDK stopped stamping draft-07 and
//     the sanitizer is dead code to remove — that failure is the signal, not a
//     regression;
//   - the sanitized path carries ZERO `$schema` anywhere in the catalog (deep
//     scan, not just the roots the converter is known to stamp today);
//   - a tools/call still round-trips through the patched transport.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiClient } from "../src/apiClient.js";
import { createServer } from "../src/server.js";
import { sanitizeOutgoingSchemas, stripToolSchemaDialects } from "../src/schemaDialect.js";
import { makeFetch } from "./helpers/mockFetch.js";

const BASE = "https://api.depixapp.com";
const KEY = "sk_test_ABC";
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

function gatewayServer(routes: Parameters<typeof makeFetch>[0] = []) {
  const { fetchImpl } = makeFetch(routes);
  return createServer({
    apiBase: BASE,
    maxWaitSeconds: 120,
    apiClient: new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl }),
    version: "0.0.0-test",
  });
}

async function connect(server: { connect(t: unknown): Promise<void> }, sanitize: boolean) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sanitize ? sanitizeOutgoingSchemas(a) : a), client.connect(b)]);
  return client;
}

/** Every `$schema` value found anywhere in the object tree. */
function collectDialects(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectDialects(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" && typeof value === "string") found.push(value);
      collectDialects(value, found);
    }
  }
  return found;
}

describe("schema dialect on the wire", () => {
  it("control: a bare transport still ships the SDK's draft-07 stamp (when this fails, delete the sanitizer)", async () => {
    const { tools } = await (await connect(gatewayServer(), false)).listTools();
    expect(tools.length).toBeGreaterThan(0);
    const dialects = collectDialects(tools);
    expect(dialects.length).toBeGreaterThan(0);
    expect(new Set(dialects)).toEqual(new Set([DRAFT_07]));
  });

  it("sanitized: the catalog carries no $schema anywhere, and schema bodies survive", async () => {
    const { tools } = await (await connect(gatewayServer(), true)).listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(collectDialects(tools)).toEqual([]);
    // The stamp is the ONLY thing removed — the schema itself must survive.
    const checkout = tools.find((t) => t.name === "create_checkout");
    expect(checkout?.inputSchema?.properties).toHaveProperty("amount");
    expect(checkout && "outputSchema" in checkout && checkout.outputSchema).toBeTruthy();
  });

  it("sanitized: tools/call still round-trips through the patched transport", async () => {
    const client = await connect(
      gatewayServer([
        {
          status: 200,
          json: {
            merchant_id: "mrc_1",
            name: "T",
            username: "t",
            merchant_slug: "t",
            is_live: false,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        },
      ]),
      true,
    );
    const res = (await client.callTool({ name: "get_account", arguments: {} })) as { isError?: boolean };
    expect(res.isError ?? false).toBe(false);
  });

  it("sanitized: the UNIFIED 62-tool catalog is clean too — the wallet half is where the bug was reported", async () => {
    const { createUnifiedServer, createWalletRuntime } = await import("../src/unified.js");
    const runtime = createWalletRuntime({
      open: () => Promise.reject(Object.assign(new Error("no wallet"), { code: "WALLET_NOT_FOUND" })),
    });
    const { fetchImpl } = makeFetch([]);
    const { server } = createUnifiedServer({
      apiBase: BASE,
      maxWaitSeconds: 120,
      apiClient: new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl }),
      version: "0.0.0-test",
      walletConfigured: false,
      wallet: {
        getWallet: () => runtime.getWallet(),
        keyMode: () => "test",
        apiKeyConfigured: () => true,
        bootResume: () => runtime.bootResume(),
        bootConversions: () => runtime.bootConversions(),
      },
      agentTools: {
        getWallet: async () => null,
        openAgent: async () => null,
        createAgent: async () => {
          throw new Error("not used");
        },
        persistKeys: async () => ({ activeMode: "test" as const, source: "store" as const, envOverride: false }),
        activateKey: async (mode) => ({ activeMode: mode, source: "store" as const, envOverride: false }),
        keyState: async () => ({ active: "test" as const, hasLive: false }),
        replaceKey: async ({ mode }) => ({ activeMode: mode, source: "store" as const, envOverride: false }),
      },
    });
    const { tools } = await (await connect(server, true)).listTools();
    expect(tools.length).toBe(62);
    expect(tools.filter((t) => t.name.startsWith("wallet_")).length).toBe(29);
    expect(collectDialects(tools)).toEqual([]);
  });

  it("stripToolSchemaDialects leaves non-tools messages untouched", () => {
    const message = { jsonrpc: "2.0" as const, id: 1, result: { ok: true } };
    expect(stripToolSchemaDialects(message)).toBe(message);
  });
});
