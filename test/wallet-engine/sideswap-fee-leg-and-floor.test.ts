// SideSwap recv-band edge cases the ±1% window got wrong (spec §5.1):
//   P2 — the declared fees only reduce what we RECEIVE when they are denominated
//        in the recv asset. On the SENT leg they leave the recv output whole, so
//        widening the accept band by them there hides a short-paid recv.
//   P3 — the 1% tolerance truncates toward 0 for small swaps (bigint), collapsing
//        the band onto the quote and rejecting normal few-sat jitter.
// Both are money-sensitive: P2 lets a subpayment through, P3 blocks honest PSETs.
import { describe, expect, it } from "vitest";
import { ASSETS } from "../../src/wallet-engine/assets.js";
import { assertSwapPsetPaysAndBalances, type SwapPsetInspection } from "../../src/wallet-engine/convert/sideswap.js";
import { isDepixSdkError } from "../../src/wallet-engine/errors.js";

const SCRIPT = "0014abcdef0011223344556677889900aabbccddeeff";
const RECV_ASSET = ASSETS.LBTC.id;
const SEND_ASSET = ASSETS.DEPIX.id;
const isSwapFail = (e: unknown): boolean => isDepixSdkError(e, "SWAP_VALIDATION_FAILED");

/** Inspection that pays our script and credits `net` of the recv asset only. */
function recvNet(net: bigint): SwapPsetInspection {
  return { outputScriptsHex: [SCRIPT], netBalances: new Map([[RECV_ASSET, net]]) };
}

const base = {
  expectedScriptHex: SCRIPT,
  recvAssetId: RECV_ASSET,
  fromAssetId: SEND_ASSET,
  sendAmountSats: 2_000_000n
};

describe("P2 — declared fees only widen the recv band on the RECV leg", () => {
  // recv=1_000_000, 1% tolerance = 10_000 (dominates the P3 floor), fees = 50_000.
  const RECV = 1_000_000n;
  const FEES = 50_000n;

  it("SEND-leg fee: a recv short by the fee amount is DETECTED (band must not widen)", () => {
    // Dealer denominates the fee in the SENT asset, then still shaves it off the
    // recv output. The fee never touches recv, so 945_000 is a real subpayment.
    const expect_ = { ...base, recvAmountSats: RECV, declaredFeesSats: FEES, feeAssetId: SEND_ASSET };
    expect(() => assertSwapPsetPaysAndBalances(recvNet(945_000n), expect_)).toThrow();
    try {
      assertSwapPsetPaysAndBalances(recvNet(945_000n), expect_);
    } catch (e) {
      expect(isSwapFail(e)).toBe(true);
    }
  });

  it("SEND-leg fee: the honest full-recv PSET (and normal jitter) still passes", () => {
    const expect_ = { ...base, recvAmountSats: RECV, declaredFeesSats: FEES, feeAssetId: SEND_ASSET };
    expect(() => assertSwapPsetPaysAndBalances(recvNet(RECV), expect_)).not.toThrow();
    expect(() => assertSwapPsetPaysAndBalances(recvNet(992_000n), expect_)).not.toThrow(); // 0.8% jitter
  });

  it("RECV-leg fee: the fee-netted PSET passes, and a short-pay below it is still caught", () => {
    const expect_ = { ...base, recvAmountSats: RECV, declaredFeesSats: FEES, feeAssetId: RECV_ASSET };
    expect(() => assertSwapPsetPaysAndBalances(recvNet(950_000n), expect_)).not.toThrow(); // quote − fees
    expect(() => assertSwapPsetPaysAndBalances(recvNet(935_000n), expect_)).toThrow(); // below fee-widened floor
  });
});

describe("P3 — the 1% tolerance is floored so small swaps keep a usable band", () => {
  it("dust swap: 1% truncates to 0, but a one-unit jitter is still accepted", () => {
    const expect_ = { ...base, recvAmountSats: 80n };
    expect(() => assertSwapPsetPaysAndBalances(recvNet(79n), expect_)).not.toThrow();
  });

  it("small swap: a few-sat jitter that 1% alone would reject is accepted", () => {
    const expect_ = { ...base, recvAmountSats: 800n };
    expect(() => assertSwapPsetPaysAndBalances(recvNet(785n), expect_)).not.toThrow();
  });

  it("large swap: the floor is inert — a >1% divergence is still rejected", () => {
    const expect_ = { ...base, recvAmountSats: 1_000_000n };
    expect(() => assertSwapPsetPaysAndBalances(recvNet(985_000n), expect_)).toThrow(); // 1.5% low
    expect(() => assertSwapPsetPaysAndBalances(recvNet(995_000n), expect_)).not.toThrow(); // 0.5% low
  });
});
