// Unified crash recovery over EVERY rail (fund-safety wiring): open()
// auto-resumes conversions (Boltz / peg-in / SideShift) alongside withdrawals,
// wallet.recover() re-drives all rails mid-session, and wallet.getPending()
// gives one read-only view over the four durable stores. This suite covers the
// WIRING — the per-rail refund/claim logic is proven by its own suites
// (boltz-refund/boltz-convert/pending/sideswap-peg/sideshift-*).
import { keyFingerprint } from "../../src/wallet-engine/api/client.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepixWallet, type PendingBoltzSwapItem } from "../../src/wallet-engine/wallet.js";
import { BoltzConvert, type BoltzResumeSummary } from "../../src/wallet-engine/convert/boltz/convert.js";
import {
  BoltzSwapStore,
  type StoredReverseSwap,
  type StoredStablecoinSwap,
  type StoredSubmarineSwap
} from "../../src/wallet-engine/convert/boltz/store.js";
import { PendingPegIn, PENDING_PEGIN_FILE } from "../../src/wallet-engine/convert/pending-pegin.js";
import { SideShiftStore, type StoredSideShift } from "../../src/wallet-engine/convert/sideshift-store.js";
import { PendingWithdrawals } from "../../src/wallet-engine/pending.js";
import type { FetchLike, FetchResponseLike } from "../../src/wallet-engine/api/client.js";
import { FakeSideSwapClient } from "./support/sideswap-mock.js";

const PASSPHRASE = "correct-horse-battery-staple";
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const EMPTY_BOLTZ: BoltzResumeSummary = {
  submarineResumed: 0,
  submarineRefunded: 0,
  reverseResumed: 0,
  stablecoinResumed: 0,
  stablecoinRefunded: 0,
  discarded: 0,
  removed: 0,
  failed: 0
};

let dataDir: string;
const openedWallets: DepixWallet[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-recovery-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of openedWallets.splice(0)) {
    await w.close().catch(() => {});
  }
  await rm(dataDir, { recursive: true, force: true });
});

function track<T extends DepixWallet>(wallet: T): T {
  openedWallets.push(wallet);
  return wallet;
}

/** Create wallet.json (and its salt) without auto-resume side effects. */
async function seedWalletFile(): Promise<string> {
  const w = await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC });
  await w.close();
  return saltOf();
}

async function saltOf(): Promise<string> {
  return JSON.parse(await readFile(join(dataDir, "wallet.json"), "utf8")).salt as string;
}

/** Minimal SideShift REST fake: GET /shifts/:id returns the scripted status. */
function shiftStatusFetch(status: string): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const body = { id: url.split("/").pop(), status, settleAmount: "9.9", depositAmount: "10" };
    const res: FetchResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body)
    };
    return res;
  };
  return { fetchImpl, calls };
}

function storedShift(id: string, status: string): StoredSideShift {
  return {
    id,
    type: "send",
    asset: "USDT",
    network: "tron",
    depositAddress: "lq1qdeposit",
    settleAddress: "T" + "x".repeat(33),
    refundAddress: null,
    status,
    createdAt: 1_720_000_000_000,
    updatedAt: 1_720_000_000_000
  };
}

function storedSubmarine(swapId: string): StoredSubmarineSwap {
  return {
    type: "submarine",
    swapId,
    invoice: "lnbc1...",
    lockupAddress: "lq1qlockup",
    expectedAmountSats: 90_000,
    invoiceSats: 89_000,
    swapTree: {},
    claimPublicKey: "02" + "b".repeat(64),
    timeoutBlockHeight: 3_100_000,
    refundPrivateKeyHex: "c".repeat(64),
    refundPublicKeyHex: "02" + "d".repeat(64),
    state: "locked_up",
    createdAt: 1_720_000_000_000
  };
}

// Sentinel secrets (distinct 64-hex values) so the no-leak assertions can prove
// each rail's key material stays out of the read-only view.
const REVERSE_PREIMAGE_HEX = "b1".repeat(32);
const REVERSE_CLAIM_PRIV_HEX = "b2".repeat(32);
const STABLECOIN_REFUND_PRIV_HEX = "e1".repeat(32);
const STABLECOIN_EVM_PRIV_HEX = "e2".repeat(32);
const STABLECOIN_PREIMAGE_HEX = "e3".repeat(32);

/** A stored reverse (LN RECEIVE) swap — carries a claim key + preimage. */
function storedReverse(swapId: string): StoredReverseSwap {
  return {
    type: "reverse",
    swapId,
    invoice: "lnbc1...",
    lockupAddress: "lq1qrevlockup",
    onchainAmount: 200_000,
    swapTree: {},
    refundPublicKey: "03" + "cc".repeat(32),
    timeoutBlockHeight: 3_100_000,
    claimAddress: "lq1qclaim",
    preimageHex: REVERSE_PREIMAGE_HEX,
    claimPublicKeyHex: "02" + "ab".repeat(32),
    claimPrivateKeyHex: REVERSE_CLAIM_PRIV_HEX,
    state: "awaiting_payment",
    createdAt: 1_720_000_000_000
  };
}

/** A stored stablecoin (L-BTC -> USDT) swap — carries a refund key, EVM key + preimage. */
function storedStablecoin(swapId: string): StoredStablecoinSwap {
  return {
    type: "stablecoin",
    swapId,
    asset: "USDT",
    networkId: "tron",
    claimAddress: "T" + "x".repeat(33),
    lockupAddress: "lq1qstlockup",
    lockAmountSats: 500_000,
    serverPublicKey: "02" + "cd".repeat(32),
    swapTree: {},
    timeoutBlockHeight: 3_100_000,
    refundPrivateKeyHex: STABLECOIN_REFUND_PRIV_HEX,
    refundPublicKeyHex: "02" + "ef".repeat(32),
    preimageHex: STABLECOIN_PREIMAGE_HEX,
    evmPrivateKeyHex: STABLECOIN_EVM_PRIV_HEX,
    createdSwap: {},
    plan: {},
    state: "locked_up",
    createdAt: 1_720_000_000_000
  };
}

// ─── open() auto-invokes the conversion recovery (mirror of withdrawals) ──────

describe("open() auto-resumes pending conversions (§5 recovery wiring)", () => {
  it("calls convert.boltz.resume() on open() by default", async () => {
    await seedWalletFile();
    const resumeSpy = vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue({ ...EMPTY_BOLTZ });
    const wallet = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(wallet.isBackupConfirmed()).toBe(true);
  });

  it("skips the conversion resume when resumePendingConversionsOnOpen: false", async () => {
    await seedWalletFile();
    const resumeSpy = vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue({ ...EMPTY_BOLTZ });
    track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE, resumePendingConversionsOnOpen: false }));
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("NEVER fails open() when the conversion resume blows up", async () => {
    await seedWalletFile();
    vi.spyOn(BoltzConvert.prototype, "resume").mockRejectedValue(new Error("boltz is down"));
    const wallet = track(await DepixWallet.open({ dataDir, passphrase: PASSPHRASE }));
    // The wallet opened and is fully usable despite the failed resume.
    expect(wallet.isBackupConfirmed()).toBe(true);
  });

  it("resumePendingConversions() itself never throws on a per-rail failure", async () => {
    await seedWalletFile();
    vi.spyOn(BoltzConvert.prototype, "resume").mockRejectedValue(new Error("boom"));
    const wallet = track(
      await DepixWallet.open({ dataDir, passphrase: PASSPHRASE, resumePendingConversionsOnOpen: false })
    );
    const summary = await wallet.resumePendingConversions();
    expect(summary.boltz).toBeNull(); // rail failed → no summary, but no throw
    expect(summary.pegin).toEqual({ pending: 0, cleared: 0, failed: 0 });
    expect(summary.sideshift).toEqual({ checked: 0, refreshed: 0, failed: 0 });
  });
});

// ─── wallet.recover(): every rail, mid-session, idempotent ────────────────────

describe("wallet.recover() re-drives every rail (§3.2.9 + §5)", () => {
  it("resumes withdrawals + boltz + peg-in + sideshift and reports per-rail counts", async () => {
    const boltzSummary: BoltzResumeSummary = { ...EMPTY_BOLTZ, submarineResumed: 1 };
    const resumeSpy = vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue(boltzSummary);

    // Seed a pending peg-in that SideSwap now reports Done, and a waiting shift
    // that SideShift now reports settled.
    const pegClient = new FakeSideSwapClient({
      pegStatus: async (args) => ({ orderId: args.orderId, status: "Done", confirmations: 102, txid: "ab".repeat(32), deposits: [] })
    });
    const { fetchImpl, calls } = shiftStatusFetch("settled");
    const wallet = track(
      await DepixWallet.restore({
        dataDir,
        passphrase: PASSPHRASE,
        mnemonic: KNOWN_MNEMONIC,
        convert: { clientFactory: () => pegClient, sideshift: { fetchImpl, affiliateId: "test-affiliate" } }
      })
    );
    await new PendingPegIn(dataDir).put({ orderId: "peg_1", pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" });
    await new SideShiftStore({ dataDir }).save(storedShift("sh_pending", "waiting"));

    const summary = await wallet.recover();

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(summary.withdrawals).toEqual({ resumed: 0, rebroadcast: 0, reposted: 0, discarded: 0, failed: 0 });
    expect(summary.boltz).toEqual(boltzSummary);
    // Done at SideSwap → the tracked peg-in was cleared.
    expect(summary.pegin).toEqual({ pending: 0, cleared: 1, failed: 0 });
    await expect(readFile(join(dataDir, PENDING_PEGIN_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // The waiting shift was refreshed from SideShift and folded into the log.
    expect(summary.sideshift).toEqual({ checked: 1, refreshed: 1, failed: 0 });
    expect(calls.length).toBe(1);
    expect((await new SideShiftStore({ dataDir }).get("sh_pending"))?.status).toBe("settled");

    // Idempotent: a second recover() finds nothing left to reconcile.
    const again = await wallet.recover();
    expect(again.pegin).toEqual({ pending: 0, cleared: 0, failed: 0 });
    expect(again.sideshift).toEqual({ checked: 0, refreshed: 0, failed: 0 });
  });

  it("keeps a still-in-flight peg-in tracked (pending, not cleared)", async () => {
    vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue({ ...EMPTY_BOLTZ });
    const pegClient = new FakeSideSwapClient({
      pegStatus: async (args) => ({ orderId: args.orderId, status: "Detected", confirmations: 12, txid: null, deposits: [] })
    });
    const wallet = track(
      await DepixWallet.restore({
        dataDir,
        passphrase: PASSPHRASE,
        mnemonic: KNOWN_MNEMONIC,
        convert: { clientFactory: () => pegClient }
      })
    );
    await new PendingPegIn(dataDir).put({ orderId: "peg_2", pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" });

    const summary = await wallet.recover();
    expect(summary.pegin).toEqual({ pending: 1, cleared: 0, failed: 0 });
    // Still tracked for the next resume/agent poll.
    expect(await wallet.convert.sideswap.getPendingPegIn()).toMatchObject({ orderId: "peg_2" });
  });

  it("counts a failed sideshift refresh without aborting the rail sweep", async () => {
    vi.spyOn(BoltzConvert.prototype, "resume").mockResolvedValue({ ...EMPTY_BOLTZ });
    const failingFetch: FetchLike = async () => {
      throw new Error("sideshift unreachable");
    };
    const wallet = track(
      await DepixWallet.restore({
        dataDir,
        passphrase: PASSPHRASE,
        mnemonic: KNOWN_MNEMONIC,
        convert: { sideshift: { fetchImpl: failingFetch, affiliateId: "test-affiliate" } }
      })
    );
    await new SideShiftStore({ dataDir }).save(storedShift("sh_a", "waiting"));
    await new SideShiftStore({ dataDir }).save(storedShift("sh_b", "pending"));

    const summary = await wallet.recover();
    expect(summary.sideshift).toEqual({ checked: 2, refreshed: 0, failed: 2 });
    // Records survive for the next resume.
    expect((await new SideShiftStore({ dataDir }).list()).length).toBe(2);
  });
});

// ─── wallet.getPending(): one read-only view over the four stores ─────────────

describe("wallet.getPending() unifies the four pending stores", () => {
  it("returns withdrawal + boltz + pegin + sideshift items with rail/id/state", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const salt = await saltOf();

    // Seed each store the same way its own flow persists.
    const withdrawals = new PendingWithdrawals({ dataDir, passphrase: PASSPHRASE, saltB64: salt });
    await withdrawals.putRequested({
      idempotencyKey: "idem-1",
      request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 }
    });
    const boltzStore = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: salt });
    // Seed one of EACH boltz rail — each stores different key material.
    await boltzStore.put(storedSubmarine("sub_1"));
    await boltzStore.put(storedReverse("rev_1"));
    await boltzStore.put(storedStablecoin("stbl_1"));
    await new PendingPegIn(dataDir).put({ orderId: "peg_1", pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" });
    const shifts = new SideShiftStore({ dataDir });
    await shifts.save(storedShift("sh_pending", "waiting"));
    await shifts.save(storedShift("sh_done", "settled")); // terminal → excluded

    const items = await wallet.getPending();
    expect(items).toHaveLength(6);

    const byRail = Object.fromEntries(items.map((i) => [i.rail, i]));
    expect(byRail.withdrawal).toMatchObject({ id: "idem-1", state: "requested", withdrawalId: null, txid: null });
    expect(byRail.pegin).toMatchObject({ id: "peg_1", state: "pending", pegAddr: "bc1qpeg", recvAddr: "lq1qrecv" });
    // The unified view surfaces the peg-in's REAL createdAt (was hardcoded null).
    expect(byRail.pegin?.createdAt).toEqual(expect.any(Number));
    expect(byRail.sideshift).toMatchObject({ id: "sh_pending", state: "waiting", shiftType: "send", network: "tron" });

    // All three boltz rails surface rail/id/state/swapType metadata only.
    const boltzById = Object.fromEntries(items.filter((i) => i.rail === "boltz").map((i) => [i.id, i]));
    expect(Object.keys(boltzById)).toHaveLength(3);
    expect(boltzById.sub_1).toMatchObject({ state: "locked_up", swapType: "submarine" });
    expect(boltzById.rev_1).toMatchObject({ state: "awaiting_payment", swapType: "reverse" });
    expect(boltzById.stbl_1).toMatchObject({ state: "locked_up", swapType: "stablecoin" });

    // NO key material leaks through the read-only view — this is the fund-safety
    // invariant the PR leans on, so it is checked for EVERY rail's secrets:
    // submarine refund key, reverse claim key + preimage, stablecoin refund/EVM
    // key + preimage. All must stay inside the encrypted store.
    const flat = JSON.stringify(items);
    // submarine
    expect(flat).not.toContain("refundPrivateKeyHex");
    expect(flat).not.toContain("c".repeat(64));
    expect(flat).not.toContain("signedTxHex");
    // reverse — claim key + preimage
    expect(flat).not.toContain("claimPrivateKeyHex");
    expect(flat).not.toContain("preimageHex");
    expect(flat).not.toContain(REVERSE_PREIMAGE_HEX);
    expect(flat).not.toContain(REVERSE_CLAIM_PRIV_HEX);
    // stablecoin — refund key, ephemeral EVM key + preimage
    expect(flat).not.toContain("evmPrivateKeyHex");
    expect(flat).not.toContain(STABLECOIN_REFUND_PRIV_HEX);
    expect(flat).not.toContain(STABLECOIN_EVM_PRIV_HEX);
    expect(flat).not.toContain(STABLECOIN_PREIMAGE_HEX);
  });

  it("does NOT promise recovery for a parked (unrecoverable) boltz record", async () => {
    // Every other pending item reads as "in flight, wallet.recover() finishes
    // it". This one never will — resume returns at the top for it — so the view
    // has to say what it actually needs: a human, not another retry.
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    const boltzStore = new BoltzSwapStore({ dataDir, passphrase: PASSPHRASE, saltB64: await saltOf() });
    await boltzStore.put({ ...storedSubmarine("sub_parked"), state: "unrecoverable" });

    const items = await wallet.getPending();
    expect(items).toHaveLength(1);
    const item = items[0] as PendingBoltzSwapItem;
    expect(item).toMatchObject({ rail: "boltz", id: "sub_parked", state: "unrecoverable" });
    expect(item.note).toMatch(/refund key/i);
    expect(item.note).toMatch(/support/i);
    // No "retry" / "try again" / "wallet.recover()" — the promise this fix removes.
    expect(item.note).not.toMatch(/retry|try again|wallet\.recover\(\)/i);
  });

  it("returns an empty list when nothing is in flight", async () => {
    const wallet = track(
      await DepixWallet.restore({ dataDir, passphrase: PASSPHRASE, mnemonic: KNOWN_MNEMONIC })
    );
    expect(await wallet.getPending()).toEqual([]);
  });
});

// ─── key-mode gate on resume: a sandbox exercise never becomes a live payout ──

describe("resumePendingWithdrawals() only replays a requested record under the key that created it", () => {
  function recordingFetch(): { fetchImpl: FetchLike; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(String(url));
      // 400, not 500: a 5xx is retried with backoff and would make the control
      // cases take a minute; the gate under test decides BEFORE any request.
      return new Response(JSON.stringify({ error: "not today" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    };
    return { fetchImpl, calls };
  }

  async function seeded(keyMode: "test" | "live" | undefined, keyFp?: string): Promise<string> {
    const salt = await seedWalletFile();
    const withdrawals = new PendingWithdrawals({ dataDir, passphrase: PASSPHRASE, saltB64: salt });
    await withdrawals.putRequested({
      idempotencyKey: "idem-mode",
      request: { pixKey: "k", taxNumber: "t", depositAmountInCents: 500 },
      ...(keyMode !== undefined ? { keyMode } : {}),
      ...(keyFp !== undefined ? { keyFingerprint: keyFp } : {})
    });
    return salt;
  }

  it("a record created under the sandbox key is left untouched when the live key is active — no POST", async () => {
    await seeded("test");
    const { fetchImpl, calls } = recordingFetch();
    const wallet = track(
      await DepixWallet.open({
        dataDir,
        passphrase: PASSPHRASE,
        apiKey: "sk_live_RESUME",
        fetch: fetchImpl,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false
      })
    );
    const summary = await wallet.resumePendingWithdrawals();
    expect(summary).toEqual({ resumed: 0, rebroadcast: 0, reposted: 0, discarded: 0, failed: 1 });
    expect(calls.filter((u) => u.includes("/withdraw"))).toEqual([]);
    // Still pending: it resumes once the sandbox key is active again.
    const held = (await wallet.getPending()).find((i) => i.rail === "withdrawal" && i.id === "idem-mode");
    // Visible to the agent: WHY it is held is the key mode on the item itself.
    expect(held).toMatchObject({ state: "requested", keyMode: "test" });
  });

  it("control: a record created under the SAME mode is replayed (the POST is attempted)", async () => {
    await seeded("live");
    const { fetchImpl, calls } = recordingFetch();
    const wallet = track(
      await DepixWallet.open({
        dataDir,
        passphrase: PASSPHRASE,
        apiKey: "sk_live_RESUME",
        fetch: fetchImpl,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false
      })
    );
    await wallet.resumePendingWithdrawals();
    expect(calls.some((u) => u.includes("/withdraw"))).toBe(true);
  });

  it("same MODE, different KEY: a record created under another live account is held — no POST", async () => {
    await seeded("live", keyFingerprint("sk_live_ACCOUNT_A"));
    const { fetchImpl, calls } = recordingFetch();
    const wallet = track(
      await DepixWallet.open({
        dataDir,
        passphrase: PASSPHRASE,
        apiKey: "sk_live_ACCOUNT_B",
        fetch: fetchImpl,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false
      })
    );
    const summary = await wallet.resumePendingWithdrawals();
    expect(summary).toEqual({ resumed: 0, rebroadcast: 0, reposted: 0, discarded: 0, failed: 1 });
    expect(calls.filter((u) => u.includes("/withdraw"))).toEqual([]);
  });

  it("the key that passed the gate is the key on the wire — even if the resolver flips mid-retry", async () => {
    await seeded("test", keyFingerprint("sk_test_A"));
    let current: string | undefined = "sk_test_A";
    const auths: string[] = [];
    let withdrawCalls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes("/withdraw")) {
        withdrawCalls += 1;
        auths.push(init.headers["Authorization"] ?? "");
        if (withdrawCalls === 1) {
          current = "sk_live_B"; // activate_key lands during the first attempt
          return new Response(JSON.stringify({ error: "flaky" }), { status: 503, headers: { "content-type": "application/json" } });
        }
      }
      return new Response(JSON.stringify({ error: "not today" }), { status: 400, headers: { "content-type": "application/json" } });
    };
    const wallet = track(
      await DepixWallet.open({
        dataDir,
        passphrase: PASSPHRASE,
        apiKey: () => current,
        fetch: fetchImpl,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false
      })
    );
    await wallet.resumePendingWithdrawals();
    expect(auths).toEqual(["Bearer sk_test_A", "Bearer sk_test_A"]);
  });

  it("the exact key that created the record replays it", async () => {
    await seeded("live", keyFingerprint("sk_live_ACCOUNT_A"));
    const { fetchImpl, calls } = recordingFetch();
    const wallet = track(
      await DepixWallet.open({
        dataDir,
        passphrase: PASSPHRASE,
        apiKey: "sk_live_ACCOUNT_A",
        fetch: fetchImpl,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false
      })
    );
    await wallet.resumePendingWithdrawals();
    expect(calls.some((u) => u.includes("/withdraw"))).toBe(true);
  });

  it("a new withdrawal is stamped with the mode AND the fingerprint of the key that made it", async () => {
    const salt = await seedWalletFile();
    const store = new PendingWithdrawals({ dataDir, passphrase: PASSPHRASE, saltB64: salt });
    // The record is written BEFORE the POST (the crash-safety invariant) and a
    // permanent 4xx removes it right after — so it is read from INSIDE the POST.
    let seenDuringPost: Awaited<ReturnType<typeof store.readAll>>["records"] = [];
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes("/withdraw")) seenDuringPost = (await store.readAll()).records;
      return new Response(JSON.stringify({ error: "not today" }), { status: 400, headers: { "content-type": "application/json" } });
    };
    const wallet = track(
      await DepixWallet.open({
        dataDir,
        passphrase: PASSPHRASE,
        apiKey: "sk_live_STAMP",
        fetch: fetchImpl,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false
      })
    );
    await wallet
      .withdraw({ pixKey: "k", recipientTaxNumber: "12345678909", amountCents: 500, mode: "send" })
      .catch(() => undefined);
    const stamped = seenDuringPost.find((r) => r.state === "requested");
    expect(stamped).toBeDefined();
    expect(stamped?.keyMode).toBe("live");
    expect(stamped?.keyFingerprint).toBe(keyFingerprint("sk_live_STAMP"));
  });

  it("a legacy record with no key mode resumes as before", async () => {
    await seeded(undefined);
    const { fetchImpl, calls } = recordingFetch();
    const wallet = track(
      await DepixWallet.open({
        dataDir,
        passphrase: PASSPHRASE,
        apiKey: "sk_live_RESUME",
        fetch: fetchImpl,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false
      })
    );
    await wallet.resumePendingWithdrawals();
    expect(calls.some((u) => u.includes("/withdraw"))).toBe(true);
  });
});
