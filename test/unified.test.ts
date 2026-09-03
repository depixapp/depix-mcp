// The UNIFIED deployment (unified-MCP spec §1, §1.6): 60 tools on ONE server, the
// three-state seedless behaviour, and per-deployment `instructions`.
//
// The load-bearing assertions here are the ones a reviewer cannot check by reading:
//   - the unified catalog is EXACTLY 26 + 29 + 4, and the 26 gateway are byte-identical to the
//     hosted catalog (the frontend's check-mcp-tool-count.mjs guard depends on the
//     hosted count staying at its pinned value, so the wallet mount must not touch it);
//   - a wallet_* call with NO wallet returns the typed `wallet_not_configured`
//     naming `init` — not a crash, not a missing tool;
//   - the hosted instructions carry the Level-2 signpost, and the unified ones can
//     NEVER carry "it never signs, never holds funds".

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiClient } from "../src/apiClient.js";
import { UNIFIED_SERVER_TITLE, SERVER_TITLE } from "../src/config.js";
import { HOSTED_ONLY_CUSTODY_SENTENCE, LEVEL_TWO_SIGNPOST, hostedInstructions } from "../src/instructions.js";
import { GATEWAY_TOOL_COUNT, createServer } from "../src/server.js";
import { UNIFIED_TOOL_COUNT, createUnifiedServer, createWalletRuntime, unifiedInstructions } from "../src/unified.js";
import { WALLET_TOOL_NAMES } from "../src/wallet-engine/mcp/server.js";
import { AGENT_TOOL_NAMES, type AgentToolDeps } from "../src/agent-tools.js";
import { makeFetch } from "./helpers/mockFetch.js";

/** A no-op agent-tools dependency set — the catalog tests never call them. */
const fakeAgentTools: AgentToolDeps = {
  getWallet: async () => null,
  openAgent: async () => null,
  createAgent: async () => {
    throw new Error("not used in catalog tests");
  },
  persistKeys: async () => ({ activeMode: "test", source: "store", envOverride: false }),
  activateKey: async (mode) => ({ activeMode: mode, source: "store" as const, envOverride: false }),
};

const BASE = "https://api.depixapp.com";
const KEY = "sk_test_ABC";

function apiClient() {
  const { fetchImpl } = makeFetch([]);
  return new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl });
}

/** Connect a client to a server over the in-memory pair. */
async function connect(server: Parameters<typeof link>[0]) {
  return link(server);
}

async function link(server: { connect(t: unknown): Promise<void> }) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

/** A seedless unified server: the wallet resolver always answers "no wallet". */
async function seedlessUnified() {
  const runtime = createWalletRuntime({ open: () => Promise.reject(Object.assign(new Error("no wallet"), { code: "WALLET_NOT_FOUND" })) });
  const { server } = createUnifiedServer({
    apiBase: BASE,
    maxWaitSeconds: 120,
    apiClient: apiClient(),
    version: "0.0.0-test",
    walletConfigured: false,
    wallet: {
      getWallet: () => runtime.getWallet(),
      keyMode: () => "test",
      apiKeyConfigured: () => true,
      bootResume: () => runtime.bootResume(),
      bootConversions: () => runtime.bootConversions(),
    },
    agentTools: fakeAgentTools,
  });
  return connect(server);
}

describe("unified catalog — 26 gateway + 29 wallet + 5 agent-local = 60", () => {
  it("mounts exactly 60 tools", async () => {
    const client = await seedlessUnified();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(60);
    expect(tools.length).toBe(UNIFIED_TOOL_COUNT);
  });

  it("keeps the hosted 26 EXACTLY as they are — the wallet + agent mounts add, never edit", async () => {
    const hosted = await connect(createServer({ apiBase: BASE, maxWaitSeconds: 120, apiClient: apiClient(), version: "0.0.0-test" }));
    const hostedNames = (await hosted.listTools()).tools.map((t) => t.name).sort();
    expect(hostedNames.length).toBe(26);

    const unified = await seedlessUnified();
    const unifiedNames = (await unified.listTools()).tools.map((t) => t.name).sort();
    // The gateway half = everything that is neither a wallet_* tool nor one of the
    // 5 agent-local tools. It must be byte-identical to the hosted catalog.
    const agentSet = new Set<string>(AGENT_TOOL_NAMES);
    const gatewayHalf = unifiedNames.filter((n) => !n.startsWith("wallet_") && !agentSet.has(n));
    expect(gatewayHalf).toEqual(hostedNames);
  });

  it("adds the 29 wallet_* tools", async () => {
    const client = await seedlessUnified();
    const names = (await client.listTools()).tools.map((t) => t.name);
    const wallet = names.filter((n) => n.startsWith("wallet_")).sort();
    expect(wallet).toEqual([...WALLET_TOOL_NAMES].sort());
    expect(wallet.length).toBe(29);
  });

  it("adds the 5 agent-local tools, mounted only on the unified server", async () => {
    const client = await seedlessUnified();
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const name of AGENT_TOOL_NAMES) expect(names.has(name)).toBe(true);
    expect(AGENT_TOOL_NAMES.length).toBe(5);
  });

  it("the HOSTED catalog offers NO registration tool (D4)", async () => {
    const hosted = await connect(createServer({ apiBase: BASE, maxWaitSeconds: 120, apiClient: apiClient(), version: "0.0.0-test" }));
    const hostedNames = (await hosted.listTools()).tools.map((t) => t.name);
    expect(hostedNames.filter((n) => n.includes("register"))).toEqual([]);
    for (const name of AGENT_TOOL_NAMES) expect(hostedNames).not.toContain(name);
  });

  it("has NO name collision between the halves", async () => {
    const client = await seedlessUnified();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("introduces itself with the unified title, never as a Gateway", async () => {
    const client = await seedlessUnified();
    const info = client.getServerVersion();
    expect(info?.title).toBe(UNIFIED_SERVER_TITLE);
    expect(info?.title).not.toMatch(/gateway/i);
    // The registry identity is NOT per-deployment: both answer to the same name.
    expect(info?.name).toBe("io.github.depixapp/depix-mcp");
  });

  it("the hosted deployment keeps the gateway title", async () => {
    const hosted = await connect(createServer({ apiBase: BASE, maxWaitSeconds: 120, apiClient: apiClient(), version: "0.0.0-test" }));
    expect(hosted.getServerVersion()?.title).toBe(SERVER_TITLE);
  });
});

describe("three-state: seedless wallet tools answer, they do not vanish or crash", () => {
  it("wallet_status with no wallet returns the typed wallet_not_configured naming init", async () => {
    const client = await seedlessUnified();
    const result = await client.callTool({ name: "wallet_status", arguments: {} });
    expect(result.isError).toBe(true);
    const payload = (result.content as { type: string; text: string }[]).map((c) => c.text).join(" ");
    expect(payload).toContain("wallet_not_configured");
    expect(payload).toContain("npx -y @depixapp/mcp init");
  });

  it("a money-moving wallet tool fails the same way — no wallet, no signing path", async () => {
    const client = await seedlessUnified();
    const result = await client.callTool({
      name: "wallet_send",
      arguments: { asset: "DEPIX", address: "lq1qqtest", amount_sats: "1000" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("wallet_not_configured");
  });

  it("the gateway half still works while the wallet half is unconfigured", async () => {
    const client = await seedlessUnified();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "get_account")).toBeDefined();
  });
});

describe("per-deployment instructions (§1.6)", () => {
  it("hosted: keeps the honest custody sentence AND signposts the local level", () => {
    const text = hostedInstructions();
    expect(text).toContain(HOSTED_ONLY_CUSTODY_SENTENCE);
    expect(text).toContain("npx -y @depixapp/mcp");
    expect(text).toContain("npx -y @depixapp/mcp init");
    expect(text).toContain("26 tools total");
    expect(text).toMatch(/seed never leaves|never leaves the operator|never leaves that machine/i);
  });

  // The handshake is what a host shows the model BEFORE it reads any tool
  // description — and it listed "checkouts/products", so an agent whose user
  // asked for a cobrança had no signal from it that dated charges exist at all.
  // Both deployments serve the same 26 gateway tools, so both must say it.
  it("both deployments announce dated charges, and name the tool that makes one", () => {
    const texts = [
      hostedInstructions(),
      unifiedInstructions({ walletConfigured: true }),
      unifiedInstructions({ walletConfigured: false }),
    ];
    for (const text of texts) {
      expect(text).toMatch(/charges/i);
      expect(text).toMatch(/cobran[çc]a/i);
      expect(text).toContain('kind="charge"');
      expect(text).toContain("create_product");
      // The gotcha that silently returns an empty list to an agent looking for
      // the charge it just created.
      expect(text).toMatch(/list_products/);
    }
  });

  it("hosted: does NOT describe wallet tools it does not have", () => {
    const text = hostedInstructions();
    expect(text).not.toContain("60 tools");
    expect(text).not.toMatch(/\bwallet_[a-z_]+\b/);
  });

  it("unified: NEVER carries the hosted-only 'never signs, never holds funds' sentence", () => {
    for (const walletConfigured of [true, false]) {
      const text = unifiedInstructions({ walletConfigured });
      expect(text).not.toContain(HOSTED_ONLY_CUSTODY_SENTENCE);
      expect(text).not.toContain("never signs");
      expect(text).not.toContain("never holds funds");
    }
  });

  it("unified: describes 60 tools and local signing", () => {
    const text = unifiedInstructions({ walletConfigured: true });
    expect(text).toContain("60 tools total");
    expect(text).toMatch(/signs (locally|in this process)/i);
    expect(text).toContain("wallet_send");
  });

  it("unified: drops the engine's self-introduction — ONE server, not two", () => {
    for (const walletConfigured of [true, false]) {
      const text = unifiedInstructions({ walletConfigured });
      // The engine's own lede ("DePix Wallet MCP — a NON-CUSTODIAL Liquid wallet
      // that signs locally…") is true when the engine serves its own bin. Spliced
      // mid-paragraph here it tells the model to go find a SECOND server, when the
      // wallet tools are on the very server it is already connected to.
      expect(text).not.toContain("DePix Wallet MCP");
      // …while every substantive sentence that lede introduced is still present.
      expect(text).toContain("The seed never leaves this machine");
      expect(text).toContain("guardrails");
      expect(text).toContain("wallet_convert is the PRIMARY conversion surface");
      expect(text).toContain("There is no tool to export the seed");
    }
  });

  it("unified + no wallet: tells the model the tools answer wallet_not_configured until init", () => {
    const text = unifiedInstructions({ walletConfigured: false });
    expect(text).toContain("wallet_not_configured");
    expect(text).toContain("npx -y @depixapp/mcp init");
  });

  it("the server actually SERVES the right text per deployment", async () => {
    const hosted = await connect(createServer({ apiBase: BASE, maxWaitSeconds: 120, apiClient: apiClient(), version: "0.0.0-test" }));
    expect(hosted.getInstructions()).toBe(hostedInstructions());

    const unified = await seedlessUnified();
    expect(unified.getInstructions()).toBe(unifiedInstructions({ walletConfigured: false }));
    expect(unified.getInstructions()).not.toContain("never signs");
  });
});

describe("lazy wallet runtime", () => {
  it("maps WALLET_NOT_FOUND to null (no wallet) and rethrows everything else", async () => {
    const notFound = createWalletRuntime({ open: () => Promise.reject(Object.assign(new Error("x"), { code: "WALLET_NOT_FOUND" })) });
    await expect(notFound.getWallet()).resolves.toBeNull();

    const wrongPass = createWalletRuntime({ open: () => Promise.reject(Object.assign(new Error("bad passphrase"), { code: "WRONG_PASSPHRASE" })) });
    await expect(wrongPass.getWallet()).rejects.toThrow("bad passphrase");
  });

  it("opens at most once and reports the boot resume summaries it captured", async () => {
    let opens = 0;
    const resume = { resumed: 2, rebroadcast: 1, reposted: 0, discarded: 0, failed: 0 };
    const runtime = createWalletRuntime({
      open: async () => {
        opens += 1;
        return {
          resumePendingWithdrawals: async () => resume,
          resumePendingConversions: async () => ({
            boltz: null,
            pegin: { pending: 1, cleared: 0, failed: 0 },
            sideshift: { checked: 0, refreshed: 0, failed: 0 },
            plans: { checked: 0, advanced: 0, completed: 0, needsReview: 0, discarded: 0, failed: 0 },
          }),
          close: async () => {},
        } as never;
      },
    });
    expect(runtime.bootResume().resumed).toBe(0); // before any open
    await runtime.getWallet();
    await runtime.getWallet();
    expect(opens).toBe(1);
    expect(runtime.bootResume()).toEqual(resume);
    expect(runtime.bootConversions().pegin.pending).toBe(1);
  });

  it("a failing crash-resume does not deny access to the wallet", async () => {
    const events: string[] = [];
    const runtime = createWalletRuntime({
      open: async () =>
        ({
          resumePendingWithdrawals: async () => {
            throw new Error("esplora down");
          },
          resumePendingConversions: async () => {
            throw new Error("boltz down");
          },
          close: async () => {},
        }) as never,
      onError: (event) => events.push(event),
    });
    await expect(runtime.getWallet()).resolves.not.toBeNull();
    expect(events).toEqual(["boot_resume_failed", "boot_conversion_resume_failed"]);
    expect(runtime.bootResume().resumed).toBe(0);
  });

  it("close() is safe when the wallet was never opened", async () => {
    const runtime = createWalletRuntime({ open: () => Promise.reject(Object.assign(new Error("x"), { code: "WALLET_NOT_FOUND" })) });
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

describe("served counts follow the catalog", () => {
  it("the hosted signpost's 'N more tools' is full minus hosted", () => {
    expect(LEVEL_TWO_SIGNPOST).toContain(`${UNIFIED_TOOL_COUNT - GATEWAY_TOOL_COUNT} more tools`);
  });
});
