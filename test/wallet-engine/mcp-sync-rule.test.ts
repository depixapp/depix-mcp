// The sync RULE, end to end through the wallet MCP server (§3.8): a balance read
// syncs BEFORE, a spend syncs BEFORE and AFTER, a deposit settlement syncs AFTER,
// and — the dangerous part — the money semantics when sync FAILS:
//   reads are fail-soft (snapshot + stale:true, never an error);
//   a spend proceeds and carries the warning, and a post-broadcast sync failure
//   NEVER turns the successful spend into an error.

import { describe, expect, it } from "vitest";
import { FakeWallet, connectWallet } from "./support/mcp.js";

/** The method-call trace of a FakeWallet, names only, in order. */
function trace(wallet: FakeWallet): string[] {
  return wallet.calls.map((c) => c.method as string);
}

function structured(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;
}

describe("sync rule — reads (§3.8)", () => {
  it("wallet_get_balances syncs BEFORE reading the balance", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({ name: "wallet_get_balances", arguments: {} });
    expect(result.isError).toBeFalsy();
    // sync happened, and it happened BEFORE getBalances.
    const t = trace(wallet);
    expect(t.indexOf("sync")).toBeGreaterThanOrEqual(0);
    expect(t.indexOf("sync")).toBeLessThan(t.indexOf("getBalances"));
    // A healthy sync leaves no stale flag.
    expect(structured(result).stale).toBeUndefined();
  });

  it("wallet_list_utxos syncs before and returns the UTXO view", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({ name: "wallet_list_utxos", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(trace(wallet)).toContain("sync");
    const utxos = structured(result).utxos as Array<Record<string, unknown>>;
    expect(utxos[0]).toMatchObject({ asset: "DEPIX", amount_sats: "1500000", vout: 0, confirmations: 12 });
  });

  it("esplora DOWN: a read is FAIL-SOFT — snapshot served with stale:true, NOT an error", async () => {
    const wallet = new FakeWallet();
    wallet.syncError = new Error("esplora unreachable");
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({ name: "wallet_get_balances", arguments: {} });
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.stale).toBe(true);
    // The snapshot is still served.
    expect((out.balances as Record<string, string>).depix_sats).toBe("1500000");
  });

  it("dedup: two reads in one turn pay for at most one scan", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    await client.callTool({ name: "wallet_get_balances", arguments: {} });
    await client.callTool({ name: "wallet_list_transactions", arguments: {} });
    expect(wallet.syncCalls.length).toBe(1);
  });
});

describe("sync rule — spends (§3.8)", () => {
  it("wallet_send syncs BEFORE and AFTER, so the next read reflects the spend", async () => {
    const wallet = new FakeWallet();
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({
      name: "wallet_send",
      arguments: { asset: "DEPIX", amount_sats: "1000", address: "lq1qdest" },
    });
    expect(result.isError).toBeFalsy();
    const t = trace(wallet);
    const send = t.indexOf("send");
    expect(t.slice(0, send)).toContain("sync"); // sync before the spend
    expect(t.slice(send + 1)).toContain("sync"); // sync after the spend
    expect(structured(result).txid).toBe("bb".repeat(32));
  });

  it("post-broadcast sync failure NEVER turns a successful spend into an error", async () => {
    const wallet = new FakeWallet();
    // Both the pre- and post-spend syncs fail (esplora outage across the call).
    wallet.syncError = new Error("esplora unreachable");
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({
      name: "wallet_send",
      arguments: { asset: "DEPIX", amount_sats: "1000", address: "lq1qdest" },
    });
    // The money moved: txid present, result is NOT an error.
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.txid).toBe("bb".repeat(32));
    expect(out.stale).toBe(true); // pre-spend refresh warned
    expect(out.post_sync_failed).toBe(true); // post-broadcast refresh failed, reported not raised
  });

  it("a spend that FAILS (guardrail block) does not run the after-sync", async () => {
    const wallet = new FakeWallet();
    wallet.throws.send = Object.assign(new Error("blocked"), { code: "GUARDRAIL_PER_TX_LIMIT" });
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({
      name: "wallet_send",
      arguments: { asset: "DEPIX", amount_sats: "1000", address: "lq1qdest" },
    });
    expect(result.isError).toBe(true);
    // Exactly one sync (the pre-spend one); no after-sync since no money moved.
    expect(wallet.syncCalls.length).toBe(1);
  });
});

describe("sync rule — inflow settlement (§3.8)", () => {
  it("wallet_wait_deposit syncs AFTER when the deposit settles (depix_sent)", async () => {
    const wallet = new FakeWallet(); // depositStatus.status === "depix_sent"
    const { client } = await connectWallet({ wallet });
    const result = await client.callTool({ name: "wallet_wait_deposit", arguments: { id: "dep_1" } });
    expect(result.isError).toBeFalsy();
    const t = trace(wallet);
    // sync came AFTER the wait resolved terminal.
    expect(t.indexOf("sync")).toBeGreaterThan(t.indexOf("waitForDeposit"));
  });

  it("wallet_wait_deposit does NOT sync when the deposit has not settled", async () => {
    const wallet = new FakeWallet();
    wallet.depositStatus = { ...wallet.depositStatus, status: "pending" };
    const { client } = await connectWallet({ wallet });
    await client.callTool({ name: "wallet_wait_deposit", arguments: { id: "dep_1" } });
    expect(wallet.syncCalls.length).toBe(0);
  });
});
