// A swap belongs to the backend that CREATED it (§5.3).
//
// Creation follows the live provider; watching, claiming and refunding follow
// the RECORD. Getting that backwards is what strands money: a Coinos lockup
// asked of Boltz gets "swap not found", and the refund key in the record is the
// only thing that can sweep it back.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoltzConvert,
  type BoltzConvertDeps,
  type BoltzWalletContext
} from "../../src/wallet-engine/convert/boltz/convert.js";
import type { BoltzClient } from "../../src/wallet-engine/convert/boltz/client.js";
import {
  ensureBoltzConfig,
  resetBoltzConfigForTests
} from "../../src/wallet-engine/convert/boltz/client.js";
import {
  SWAP_PROVIDERS,
  forceSwapProvider,
  isStablecoinProviderLive,
  resetSwapProviderSelection,
  selectSwapProvider,
  type ProbeFetch,
  type SwapProvider
} from "../../src/wallet-engine/convert/boltz/providers.js";
import {
  BoltzSwapStore,
  type StoredReverseSwap,
  type StoredSubmarineSwap
} from "../../src/wallet-engine/convert/boltz/store.js";
import {
  refundSubmarineSwap,
  type RefundDeps,
  type RefundResult,
  type SubmarineRefundRecord
} from "../../src/wallet-engine/convert/boltz/refund.js";
import { executeStablecoinRoute } from "../../src/wallet-engine/convert/boltz/stablecoin.js";
import type { Logger } from "../../src/wallet-engine/logger.js";
import { isDepixSdkError } from "../../src/wallet-engine/errors.js";
import { TEST_INVOICE } from "./support/boltz.js";

const BOLTZ = SWAP_PROVIDERS[0]!;
const COINOS = SWAP_PROVIDERS[1]!;
const LOCKUP_ADDRESS =
  "lq1qqfk0uw9vlmqlggzs7cxmw49x8ks37l87udspmpt3ssgxjrkqqlww63xvus3c5gaz89r2kd393c4fvurwxf06qj87y2kd3vsln";
const SILENT_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const SALT_B64 = Buffer.from(new Uint8Array(16).fill(7)).toString("base64");
const PASSPHRASE = "correct-horse-battery-staple";

/** Boltz creation off, Coinos answering — the state of the world since 2026-08-03. */
const boltzDownProbe: ProbeFetch = async (url) => ({
  status: 400,
  text: async () =>
    url.startsWith(BOLTZ.apiUrl)
      ? '{"error":"swap creation is disabled"}'
      : '{"error":"1 is less than minimal of 25000"}'
});

/** Everyone answering — used to model Boltz coming back after a fallback. */
const allAliveProbe: ProbeFetch = async () => ({
  status: 400,
  text: async () => '{"error":"1 is less than minimal of 25000"}'
});

let dataDir: string;
let store: BoltzSwapStore;
/** Every provider a client was built for, in order. */
let clientProviders: SwapProviderId[];
type SwapProviderId = SwapProvider["id"];

function fakeClient(provider: SwapProvider, over: Record<string, unknown> = {}): BoltzClient {
  clientProviders.push(provider.id);
  return {
    getSubmarinePairHash: async () => "pair-hash",
    createSubmarineSwap: async () => ({
      id: "sub-1",
      address: LOCKUP_ADDRESS,
      expectedAmount: 10_000,
      swapTree: { claimLeaf: {}, refundLeaf: {} },
      claimPublicKey: "03" + "cc".repeat(32),
      blindingKey: "dd".repeat(32),
      timeoutBlockHeight: 1_000_100
    }),
    getChainHeight: async () => 1_000_000,
    getSwapStatus: async () => ({ status: "swap.created" }),
    subscribeSwap: () => () => {},
    ...over
  } as unknown as BoltzClient;
}

function makeConvert(deps: BoltzConvertDeps = {}): { convert: BoltzConvert; ctx: BoltzWalletContext } {
  const ctx: BoltzWalletContext = {
    store,
    logger: SILENT_LOGGER,
    lockupLbtc: async () => ({ txid: "lockup_txid" }),
    getReceiveAddress: async () => LOCKUP_ADDRESS
  };
  return {
    convert: new BoltzConvert(ctx, {
      verifyLockup: vi.fn(async () => {}) as unknown as BoltzConvertDeps["verifyLockup"],
      ...deps
    }),
    ctx
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-boltz-provider-"));
  store = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: SALT_B64, logger: SILENT_LOGGER });
  clientProviders = [];
  resetSwapProviderSelection();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  forceSwapProvider("boltz"); // restore the suite-wide pin from test/setup.ts
});

describe("creation follows the live provider", () => {
  it("creates a Lightning send on Coinos when Boltz has creation switched off", async () => {
    await selectSwapProvider({ fetchImpl: boltzDownProbe });
    const { convert } = makeConvert({ clientFactory: (p) => fakeClient(p) });

    const res = await convert.payLightningInvoice({ invoice: TEST_INVOICE });

    expect(clientProviders).toEqual(["coinos"]);
    const stored = (await store.get(res.swapId)) as StoredSubmarineSwap;
    expect(stored.providerId).toBe("coinos");
    expect(stored.state).toBe("locked_up");
    convert.dispose();
  });

  it("stamps the record BEFORE the lockup, so a crash mid-funding still names the backend", async () => {
    await selectSwapProvider({ fetchImpl: boltzDownProbe });
    const { convert } = makeConvert({
      clientFactory: (p) => fakeClient(p),
      // A broadcast-stage failure: the L-BTC may already be locked, so the
      // record must survive — and it must still say whose lockup it is.
      // (`nothingLocked` absent ⇒ keep.)
    });
    const ctxFailing = new BoltzConvert(
      {
        store,
        logger: SILENT_LOGGER,
        lockupLbtc: async () => {
          throw new Error("network reset after the node accepted the tx");
        },
        getReceiveAddress: async () => LOCKUP_ADDRESS
      },
      {
        clientFactory: (p) => fakeClient(p),
        verifyLockup: vi.fn(async () => {}) as unknown as BoltzConvertDeps["verifyLockup"]
      }
    );

    await expect(ctxFailing.payLightningInvoice({ invoice: TEST_INVOICE })).rejects.toThrow(/network reset/);
    const { records } = await store.readAll();
    expect(records).toHaveLength(1);
    expect((records[0] as StoredSubmarineSwap).providerId).toBe("coinos");
    convert.dispose();
    ctxFailing.dispose();
  });

  it("re-probes after a creation failure that blames the backend", async () => {
    const probe = vi.fn(boltzDownProbe);
    await selectSwapProvider({ fetchImpl: probe });
    const { convert } = makeConvert({
      clientFactory: (p) =>
        fakeClient(p, {
          createSubmarineSwap: async () => {
            throw new Error("swap creation is disabled");
          }
        })
    });

    await expect(convert.payLightningInvoice({ invoice: TEST_INVOICE })).rejects.toThrow(/creation is disabled/);
    // The cached pick was dropped, so the next attempt walks the list again —
    // two probes per walk (Boltz refuses, Coinos answers), twice.
    await selectSwapProvider({ fetchImpl: probe });
    expect(probe.mock.calls).toHaveLength(4);
    convert.dispose();
  });
});

describe("recovery follows the RECORD, never the current selection", () => {
  async function seedSubmarine(providerId: SwapProviderId | undefined, state: StoredSubmarineSwap["state"]) {
    const record: StoredSubmarineSwap = {
      type: "submarine",
      ...(providerId ? { providerId } : {}),
      swapId: "sub-legacy",
      invoice: TEST_INVOICE,
      lockupAddress: LOCKUP_ADDRESS,
      expectedAmountSats: 10_000,
      invoiceSats: 9_900,
      swapTree: { claimLeaf: {}, refundLeaf: {} },
      claimPublicKey: "03" + "cc".repeat(32),
      timeoutBlockHeight: 1_000_100,
      refundPrivateKeyHex: "11".repeat(32),
      refundPublicKeyHex: "02" + "22".repeat(32),
      lockupTxid: "lockup_txid",
      state,
      createdAt: Date.now()
    };
    await store.put(record);
    return record;
  }

  it("asks the CREATING backend for a Coinos swap's status, while the process is on Boltz", async () => {
    forceSwapProvider("boltz");
    await seedSubmarine("coinos", "locked_up");
    const { convert } = makeConvert({ clientFactory: (p) => fakeClient(p) });

    await convert.resume();

    expect(clientProviders).toEqual(["coinos"]);
    convert.dispose();
  });

  it("refunds a Coinos lockup through Coinos — only it can co-sign", async () => {
    forceSwapProvider("boltz");
    await seedSubmarine("coinos", "refund_pending");
    const seen: Array<string | undefined> = [];
    const refundSubmarine = vi.fn(
      async (_record: SubmarineRefundRecord, deps: RefundDeps): Promise<RefundResult> => {
        seen.push(deps.provider?.id);
        return { refundTxId: "refund_txid", cooperative: true };
      }
    );
    const { convert } = makeConvert({ clientFactory: (p) => fakeClient(p), refundSubmarine });

    const summary = await convert.resume();

    expect(summary.submarineRefunded).toBe(1);
    expect(seen).toEqual(["coinos"]);
    convert.dispose();
  });

  it("MIGRATION: a record written before providers existed resumes on Boltz, never stalls", async () => {
    forceSwapProvider("coinos"); // the process has since moved on
    await seedSubmarine(undefined, "refund_pending");
    const seen: Array<string | undefined> = [];
    const refundSubmarine = vi.fn(
      async (_record: SubmarineRefundRecord, deps: RefundDeps): Promise<RefundResult> => {
        seen.push(deps.provider?.id);
        return { refundTxId: "refund_txid", cooperative: true };
      }
    );
    const { convert } = makeConvert({ clientFactory: (p) => fakeClient(p), refundSubmarine });

    const summary = await convert.resume();

    // Refunded, not discarded: an unknown-shaped record must never strand a lockup.
    expect(summary).toMatchObject({ submarineRefunded: 1, discarded: 0, failed: 0 });
    expect(seen).toEqual(["boltz"]);
    convert.dispose();
  });

  it("MIGRATION: the store reads a pre-provider record back intact", async () => {
    const record = await seedSubmarine(undefined, "locked_up");
    const { records, tamperedIds } = await store.readAll();
    expect(tamperedIds).toEqual([]);
    expect(records[0]).toMatchObject({ swapId: record.swapId, state: "locked_up" });
    expect((records[0] as StoredSubmarineSwap).providerId).toBeUndefined();
  });

  it("re-watches a Coinos RECEIVE on Coinos", async () => {
    forceSwapProvider("boltz");
    const reverse: StoredReverseSwap = {
      type: "reverse",
      providerId: "coinos",
      state: "awaiting_payment",
      createdAt: Date.now(),
      swapId: "rev-1",
      invoice: "lnbc1invoice",
      lockupAddress: LOCKUP_ADDRESS,
      onchainAmount: 9_000,
      swapTree: { claimLeaf: {}, refundLeaf: {} },
      refundPublicKey: "03" + "cc".repeat(32),
      timeoutBlockHeight: 1_000_100,
      claimAddress: LOCKUP_ADDRESS,
      preimageHex: "aa".repeat(32),
      claimPublicKeyHex: "02" + "bb".repeat(32),
      claimPrivateKeyHex: "cc".repeat(32)
    };
    await store.put(reverse);
    const { convert } = makeConvert({ clientFactory: (p) => fakeClient(p) });

    const summary = await convert.resume();

    expect(summary.reverseResumed).toBe(1);
    // The re-watch is fired, not awaited.
    await vi.waitFor(() => expect(clientProviders).toEqual(["coinos"]));
    convert.dispose();
  });
});

describe("the stablecoin route stays on Boltz and refuses when Boltz is off", () => {
  it("throws SWAP_PROVIDER_UNAVAILABLE before creating anything", async () => {
    await selectSwapProvider({ fetchImpl: boltzDownProbe }); // process is on Coinos
    expect(await isStablecoinProviderLive({ fetchImpl: boltzDownProbe })).toBe(false);
    const createRoute = vi.fn();
    const { convert } = makeConvert({
      clientFactory: (p) => fakeClient(p),
      stablecoin: { prepare: { createRoute: createRoute as never } }
    });

    await expect(
      convert.toStablecoin({
        asset: "USDT",
        networkId: "arbitrum",
        amountSats: 10_000,
        claimAddress: "0x1111111111111111111111111111111111111111"
      })
    ).rejects.toSatisfy((e: unknown) => isDepixSdkError(e, "SWAP_PROVIDER_UNAVAILABLE"));
    expect(createRoute).not.toHaveBeenCalled();
    convert.dispose();
  });
});

describe("a Lightning flow on the fallback runs CONCURRENTLY with a stablecoin flow on Boltz", () => {
  beforeEach(() => {
    resetBoltzConfigForTests();
  });

  it("a Coinos refund co-signs against Coinos while a Boltz stablecoin execution runs", async () => {
    // The Lightning SEND path only reaches the shared SDK config when it
    // refunds — and a refund asked of the wrong backend is a stranded lockup.
    await ensureBoltzConfig();
    const { getBoltzApiUrl } = (await import("boltz-swaps/config")) as unknown as {
      getBoltzApiUrl: () => string;
    };
    const seen: Record<string, string[]> = { refund: [], stablecoin: [] };
    const step = async (flow: string, ms: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, ms));
      seen[flow]!.push(getBoltzApiUrl());
    };

    const refund = refundSubmarineSwap(
      {
        swapId: "sub-coinos",
        claimPublicKey: "03" + "cc".repeat(32),
        swapTree: {},
        timeoutBlockHeight: 1_000_100,
        refundPrivateKeyHex: "11".repeat(32),
        refundPublicKeyHex: "02" + "22".repeat(32)
      },
      {
        provider: COINOS,
        getRefundAddress: async () => LOCKUP_ADDRESS,
        getLockupHex: async () => {
          await step("refund", 0);
          return "00";
        },
        refund: async () => {
          await step("refund", 6);
          return "deadbeef";
        },
        broadcast: async () => {
          await step("refund", 12);
          return { id: "refund_txid" };
        }
      }
    );

    const stablecoin = executeStablecoinRoute(
      {
        swapId: "chain-1",
        claimAddress: "0x" + "a".repeat(40),
        createdSwap: {},
        plan: {},
        preimageHex: "aa".repeat(32),
        evmPrivateKeyHex: "bb".repeat(32)
      },
      {
        ensureConfig: async () => {},
        waitForServerLockup: async () => {
          await step("stablecoin", 3);
          await step("stablecoin", 9);
        },
        buildSigner: (async () => ({}) as never) as never,
        executeRoute: async () => {
          await step("stablecoin", 15);
          return { claimTransactionId: "0xclaim" };
        }
      }
    );

    await Promise.all([refund, stablecoin]);

    expect(seen.refund).toEqual([COINOS.apiUrl, COINOS.apiUrl, COINOS.apiUrl]);
    expect(seen.stablecoin).toEqual([BOLTZ.apiUrl, BOLTZ.apiUrl, BOLTZ.apiUrl]);
  });

  it("each provider request resolves its own base URL", async () => {
    await ensureBoltzConfig();
    const { getBoltzApiUrl } = (await import("boltz-swaps/config")) as unknown as {
      getBoltzApiUrl: () => string;
    };
    // The reachable shape of this: the Lightning selection was cached while
    // Boltz was off, Boltz has since come back, and a stablecoin swap starts
    // while the Coinos swap is still in flight.
    await selectSwapProvider({ fetchImpl: boltzDownProbe }); // Lightning → Coinos
    expect(await isStablecoinProviderLive({ fetchImpl: allAliveProbe })).toBe(true);

    const seen: Record<string, string[]> = { lightning: [], stablecoin: [] };
    const step = async (flow: string, ms: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, ms));
      seen[flow]!.push(getBoltzApiUrl());
    };

    const { convert } = makeConvert({
      clientFactory: (p) => fakeClient(p),
      getReversePairHash: async () => "reverse-pair-hash",
      deriveSecrets: () => ({
        preimage: new Uint8Array(32).fill(1),
        preimageHash: new Uint8Array(32).fill(2),
        claimKeys: { privateKey: new Uint8Array(32).fill(3), publicKey: new Uint8Array(33).fill(4) }
      }),
      // The reverse CREATE runs on the Lightning provider…
      reverseCreate: async () => {
        await step("lightning", 0);
        await step("lightning", 6);
        await step("lightning", 12);
        throw new Error("stop here — the invoice binding is not what this test is about");
      },
      stablecoin: {
        prepare: {
          ensureConfig: async () => {},
          isKnownTokenAddress: () => false,
          // …while the chain-swap route planning runs on Boltz.
          estimate: async () => {
            await step("stablecoin", 3);
            await step("stablecoin", 9);
            await step("stablecoin", 15);
            throw new Error("stop here — the route execution is not what this test is about");
          }
        }
      }
    });

    await Promise.allSettled([
      convert.receiveLightning({ amountSats: 50_000 }),
      convert.toStablecoin({
        asset: "USDT",
        networkId: "arbitrum",
        amountSats: 10_000,
        claimAddress: "0x1111111111111111111111111111111111111111"
      })
    ]);

    expect(seen.lightning).toEqual([COINOS.apiUrl, COINOS.apiUrl, COINOS.apiUrl]);
    expect(seen.stablecoin).toEqual([BOLTZ.apiUrl, BOLTZ.apiUrl, BOLTZ.apiUrl]);
    convert.dispose();
  });
});
