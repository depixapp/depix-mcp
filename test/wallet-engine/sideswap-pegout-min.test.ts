// P6 — a SideSwap peg-out below the server's minimum must NEVER be broadcast.
//
// SideSwap discovers the peg-out amount only from the on-chain L-BTC sent to the
// peg address; a deposit under the minimum settles as `InsufficientAmount` — a
// FINAL state that is "discarded" with NO refund. So the L-BTC would be burned.
// Blocking BEFORE the L-BTC is signed/broadcast is the only defense. These tests
// prove pegOut() reads the LIVE minimum (peg_quote.min_amount, then
// server_status.min_peg_out_amount, then a conservative floor) and refuses a
// below-minimum amount without ever creating an order, building, or broadcasting
// — on the direct call, through convert(), and as a multi-hop exit leg.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { base64 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDepixSdkError } from "../../src/wallet-engine/errors.js";
import type { ConvertWalletHooks } from "../../src/wallet-engine/convert/hooks.js";
import type { GuardrailIntent } from "../../src/wallet-engine/guardrails/guardrails.js";
import { PendingPegIn } from "../../src/wallet-engine/convert/pending-pegin.js";
import { SideSwapPeg } from "../../src/wallet-engine/convert/sideswap-peg.js";
import { convertIntent, type IntentDeps } from "../../src/wallet-engine/convert/intent.js";
import { enumerateRoutes } from "../../src/wallet-engine/convert/routes.js";
import { ConversionPlanStore } from "../../src/wallet-engine/convert/plan-store.js";
import type { SideSwapQuote, SwapExecuteResult } from "../../src/wallet-engine/convert/sideswap.js";
import { FakeSideSwapClient, type FakeClientScript } from "./support/sideswap-mock.js";

interface Spies {
  valuate: Array<[string, bigint]>;
  enforce: GuardrailIntent[];
  ensureWollet: number;
  broadcast: number;
}

// Hooks whose ensureWollet THROWS a `BUILD_REACHED` sentinel: reaching it proves
// the guard let the amount through to the L-BTC build; never reaching it (an
// INVALID_AMOUNT instead) proves the guard blocked before the point of no return.
function makeHooks(dataDir: string, over: Partial<ConvertWalletHooks> = {}): { hooks: ConvertWalletHooks; spies: Spies } {
  const spies: Spies = { valuate: [], enforce: [], ensureWollet: 0, broadcast: 0 };
  const hooks: ConvertWalletHooks = {
    dataDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ensureWollet: async () => {
      spies.ensureWollet += 1;
      throw new Error("BUILD_REACHED");
    },
    getReceiveAddress: async () => "lq1qmyreceive",
    decryptMnemonic: async () => {
      throw new Error("decryptMnemonic should not run in these tests");
    },
    valuate: async (asset, sats) => {
      spies.valuate.push([asset, sats]);
      return 3_000;
    },
    enforceGuardrails: async (intent) => {
      spies.enforce.push(intent);
    },
    recordSpend: async () => {},
    runExclusive: (fn) => fn(),
    broadcast: async () => {
      spies.broadcast += 1;
      return "broadcast_txid";
    },
    assertOpen: () => {},
    now: () => 0,
    ...over
  };
  return { hooks, spies };
}

let dataDir: string;
let pending: PendingPegIn;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-pegmin-"));
  pending = new PendingPegIn(dataDir);
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Drive ONE direct pegOut with a fresh client + hooks; return the thrown error
// (or null if it unexpectedly resolved) plus the spies for inspection.
async function runPegOut(
  amountSats: bigint,
  opts: { script?: FakeClientScript; blocks?: number } = {}
): Promise<{ err: unknown; client: FakeSideSwapClient; spies: Spies }> {
  const client = new FakeSideSwapClient(opts.script);
  const { hooks, spies } = makeHooks(dataDir);
  const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });
  const err = await peg
    .pegOut({ recvAddr: "bc1qdestination", amountSats, blocks: opts.blocks })
    .then(() => null)
    .catch((e) => e);
  return { err, client, spies };
}

describe("SideSwapPeg.pegOut — refuses a below-minimum amount before broadcast (P6)", () => {
  it("(a) a below-minimum peg-out is refused with the minimum, and never orders / builds / broadcasts", async () => {
    // Silent fake (no peg_quote, empty server_status) → conservative floor 100_000.
    const { err, client, spies } = await runPegOut(50_000n);
    expect(isDepixSdkError(err, "INVALID_AMOUNT")).toBe(true);
    expect(String((err as Error).message)).toContain("100000");
    // No order was opened, the build never started, nothing was broadcast.
    expect(client.pegOutCalls).toHaveLength(0);
    expect(spies.ensureWollet).toBe(0);
    expect(spies.broadcast).toBe(0);
    // Provably pre-broadcast → a multi-hop caller may keep the plan for retry.
    expect((err as { nothingLocked?: boolean }).nothingLocked).toBe(true);
  });

  it("(d) with a silent server the 100_000-sat floor applies: 99_999 is refused, 100_000 clears to the build", async () => {
    const below = await runPegOut(99_999n);
    expect(isDepixSdkError(below.err, "INVALID_AMOUNT")).toBe(true);
    expect(String((below.err as Error).message)).toContain("100000");
    expect(below.client.pegOutCalls).toHaveLength(0);

    const atFloor = await runPegOut(100_000n);
    expect(String((atFloor.err as Error).message)).toBe("BUILD_REACHED");
    expect(atFloor.client.pegOutCalls).toEqual([{ recvAddr: "bc1qdestination", blocks: undefined }]);
    expect(atFloor.spies.ensureWollet).toBe(1);
  });

  it("(e) a live server_status minimum is honored: at the minimum clears, one sat under is refused", async () => {
    const script: FakeClientScript = { serverStatus: async () => ({ min_peg_out_amount: 50_000 }) };

    const atMin = await runPegOut(50_000n, { script });
    expect(String((atMin.err as Error).message)).toBe("BUILD_REACHED");
    expect(atMin.client.pegOutCalls).toHaveLength(1);

    const underMin = await runPegOut(49_999n, { script });
    expect(isDepixSdkError(underMin.err, "INVALID_AMOUNT")).toBe(true);
    expect(String((underMin.err as Error).message)).toContain("50000");
    expect(underMin.client.pegOutCalls).toHaveLength(0);
  });

  it("(e2) peg_quote's min_amount is preferred over server_status's min_peg_out_amount", async () => {
    // The direction-specific quote (50_000) wins over the status floor (200_000).
    const script: FakeClientScript = {
      pegQuote: async () => ({ serverFeePercent: 0.1, minAmount: 50_000, maxAmount: null, recvAmount: null }),
      serverStatus: async () => ({ min_peg_out_amount: 200_000 })
    };

    const cleared = await runPegOut(60_000n, { script }); // ≥ 50_000 (quote), < 200_000 (status)
    expect(String((cleared.err as Error).message)).toBe("BUILD_REACHED");

    const refused = await runPegOut(40_000n, { script }); // < 50_000 (quote)
    expect(isDepixSdkError(refused.err, "INVALID_AMOUNT")).toBe(true);
    expect(String((refused.err as Error).message)).toContain("50000");
  });
});

// A market-swap leg whose execute() settles `executedRecvSats` L-BTC (distinct
// from any estimate) — the real amount the following peg-out leg must size on.
function fakeSwapQuoteFactory(executedRecvSats: bigint) {
  return async (params: { from: string; to: string; amountSats: bigint }) => {
    const quote: SideSwapQuote = {
      quoteId: "Q1",
      from: params.from as SideSwapQuote["from"],
      to: params.to as SideSwapQuote["to"],
      sendAmountSats: params.amountSats,
      recvAmountSats: executedRecvSats,
      serverFeeSats: 0n,
      fixedFeeSats: 0n,
      feeAsset: null,
      ttlMs: 30_000,
      expiresAt: Date.now() + 30_000,
      receiveAddress: "lq1our-receive"
    };
    return {
      next: async () => quote,
      execute: async (q: SideSwapQuote): Promise<SwapExecuteResult> => ({
        txid: "swap_txid",
        from: q.from,
        to: q.to,
        sendAmountSats: q.sendAmountSats,
        recvAmountSats: executedRecvSats,
        brlCents: 100
      }),
      close: () => {}
    };
  };
}

const UNUSED_SIDESHIFT = undefined as unknown as IntentDeps["sideshift"];
function boltzUnused(): never {
  throw new Error("boltz must not run for a peg-out route");
}

describe("convert() peg-out — the same guard is reached through the intent layer (P6)", () => {
  it("(b) convert LBTC→BTC below the minimum is refused before any order or broadcast", async () => {
    const client = new FakeSideSwapClient(); // floor 100_000
    const { hooks, spies } = makeHooks(dataDir);
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });
    const deps: IntentDeps = {
      sideswap: {
        quote: async () => {
          throw new Error("quote must not run for a peg-out route");
        },
        pegIn: () => peg.pegIn(),
        pegOut: (p) => peg.pegOut(p),
        pegStatus: (a) => peg.pegStatus(a)
      },
      sideshift: UNUSED_SIDESHIFT,
      getBoltz: boltzUnused
    };

    const err = await convertIntent(
      { from: "LBTC", to: "BTC", network: "bitcoin", address: "bc1qdestination", amount: 50_000n },
      deps
    ).catch((e) => e);

    expect(isDepixSdkError(err, "INVALID_AMOUNT")).toBe(true);
    expect(String((err as Error).message)).toContain("100000");
    expect(client.pegOutCalls).toHaveLength(0);
    expect(spies.broadcast).toBe(0);
  });
});

describe("multi-hop — a below-minimum final peg-out leg never crosses into broadcast (P6)", () => {
  let store: ConversionPlanStore;
  beforeEach(() => {
    store = new ConversionPlanStore({
      dataDir,
      passphrase: "correct-horse-battery-staple",
      saltB64: base64.encode(randomBytes(16))
    });
  });

  it("(c) leg 1 settles below the peg-out minimum; the peg leg is refused pre-broadcast and the plan is kept for retry", async () => {
    const route = enumerateRoutes({ from: "DEPIX", to: "BTC", network: "bitcoin" }).find(
      (r) => r.legs[r.legs.length - 1]?.method === "pegOut"
    );
    if (!route) throw new Error("expected a DEPIX→BTC route ending in pegOut");

    const client = new FakeSideSwapClient(); // floor 100_000
    const { hooks, spies } = makeHooks(dataDir);
    const peg = new SideSwapPeg({ hooks, pending, clientFactory: () => client });
    const deps: IntentDeps = {
      sideswap: {
        // Leg 0 swaps DEPIX→L-BTC and really settles 42 sats — far below the floor.
        quote: fakeSwapQuoteFactory(42n),
        pegIn: () => peg.pegIn(),
        pegOut: (p) => peg.pegOut(p),
        pegStatus: (a) => peg.pegStatus(a)
      },
      sideshift: UNUSED_SIDESHIFT,
      getBoltz: boltzUnused,
      planStore: store,
      newPlanId: () => "plan-p6",
      pollIntervalMs: 1
    };

    const res = await convertIntent(
      { from: "DEPIX", to: "BTC", network: "bitcoin", route: route.id, address: "bc1qdestination", amount: 100_000_000n },
      deps
    );

    // The peg leg never created an order or broadcast anything — the L-BTC from
    // leg 0 stays in the wallet instead of being burned.
    expect(client.pegOutCalls).toHaveLength(0);
    expect(spies.broadcast).toBe(0);
    // The refusal is pre-broadcast, so the plan is kept for retry (not parked as
    // an ambiguous failure), and the minimum is surfaced to the caller.
    expect(res.status).toBe("pending");
    expect(String(res.nextStep)).toContain("100000");
    const saved = await store.get("plan-p6");
    expect(saved?.state).toBe("pending");
    expect(await store.count()).toBe(1);
  });
});
