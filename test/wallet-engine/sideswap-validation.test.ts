// SideSwap PSET validation (spec §5.1) — the load-bearing security core, pure
// and deterministic. Covers the PRIMARY hard check (PSET must pay OUR receive
// address) and the SECONDARY check that DIVERGES from the frontend by failing
// CLOSED (G3): a null / missing-asset inspection or a >1% divergence ABORTS with
// SWAP_VALIDATION_FAILED and nothing is signed. Also the peg-out recipient pin.
import { describe, expect, it } from "vitest";
import { ASSETS } from "../../src/wallet-engine/assets.js";
import { Pset, buildWollet, descriptorFromMnemonic } from "../../src/wallet-engine/engine/lwk.js";
import {
  assertSwapPsetPaysAndBalances,
  inspectSwapPset,
  type SwapPsetInspection
} from "../../src/wallet-engine/convert/sideswap.js";
import { assertPegOutRecipient, type PegOutRecipient } from "../../src/wallet-engine/convert/sideswap-peg.js";
import { isDepixSdkError } from "../../src/wallet-engine/errors.js";

const SCRIPT = "0014abcdef0011223344556677889900aabbccddeeff"; // our receive scriptPubkey hex
const OTHER_SCRIPT = "0014ffffffffffffffffffffffffffffffffffffffff";
const LBTC = ASSETS.LBTC.id;
const DEPIX = ASSETS.DEPIX.id; // the from-asset in these fixtures
const RECV = 1000n;
const SEND = 2000n;

function inspection(over: Partial<SwapPsetInspection> = {}): SwapPsetInspection {
  return {
    outputScriptsHex: [SCRIPT],
    netBalances: new Map([[LBTC, RECV]]),
    ...over
  };
}
const expectValid = {
  expectedScriptHex: SCRIPT,
  recvAssetId: LBTC,
  recvAmountSats: RECV,
  fromAssetId: DEPIX,
  sendAmountSats: SEND
};
const isSwapFail = (e: unknown): boolean => isDepixSdkError(e, "SWAP_VALIDATION_FAILED");

describe("assertSwapPsetPaysAndBalances — PRIMARY hard check (§5.1)", () => {
  it("passes when an output pays our script and the net is within tolerance", () => {
    expect(() => assertSwapPsetPaysAndBalances(inspection(), expectValid)).not.toThrow();
    // 1% of 1000 is 10, below the 100-unit floor, so the effective band is ±100.
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 1010n]]) }), expectValid)
    ).not.toThrow();
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 990n]]) }), expectValid)
    ).not.toThrow();
  });

  it("aborts when NO output pays our receive address (fund-diversion guard)", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ outputScriptsHex: [OTHER_SCRIPT] }), expectValid)
    ).toThrow();
    try {
      assertSwapPsetPaysAndBalances(inspection({ outputScriptsHex: [OTHER_SCRIPT] }), expectValid);
    } catch (e) {
      expect(isSwapFail(e)).toBe(true);
    }
  });
});

describe("assertSwapPsetPaysAndBalances — SECONDARY check is FAIL-CLOSED (G3, §5.1)", () => {
  it("FAIL-CLOSED: a null inspection (LWK read failed) aborts — never treated as passed", () => {
    // Primary passes (script present), but net-balance inspection is null.
    // Frontend proceeds here (fail-open); the SDK aborts (G3).
    expect(() => assertSwapPsetPaysAndBalances(inspection({ netBalances: null }), expectValid)).toThrow();
    try {
      assertSwapPsetPaysAndBalances(inspection({ netBalances: null }), expectValid);
    } catch (e) {
      expect(isSwapFail(e)).toBe(true);
    }
  });

  it("FAIL-CLOSED: recv asset absent from the net balances aborts", () => {
    const other = ASSETS.USDT.id;
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[other, RECV]]) }), expectValid)
    ).toThrow();
  });

  it("aborts when the net diverges beyond the accepted band above or below the quote", () => {
    // Band is [900, 1100] here (±100 floor dominates 1% of 1000); one unit past
    // either edge aborts.
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 1101n]]) }), expectValid)
    ).toThrow();
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 899n]]) }), expectValid)
    ).toThrow();
  });

  it("aborts when the net for the recv asset is non-positive", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 0n]]) }), expectValid)
    ).toThrow();
  });

  it("tolerates asset-id hex case differences (frontend parity)", () => {
    const upper = new Map([[LBTC.toUpperCase(), RECV]]);
    expect(() => assertSwapPsetPaysAndBalances(inspection({ netBalances: upper }), expectValid)).not.toThrow();
  });

  it("rejects a non-positive quoted recv amount", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection(), { ...expectValid, recvAmountSats: 0n })
    ).toThrow();
  });
});

describe("assertSwapPsetPaysAndBalances — SEND-SIDE bound is FAIL-CLOSED (§5.1/G3 change-diversion)", () => {
  // recv side always valid; we vary only the FROM (sent) asset's net. selectSwapUtxos
  // overshoots largest-first, so a dealer that shrinks/omits our change makes us
  // overpay the from-asset — the recv-only checks above are blind to it.
  const withFromNet = (fromNet: bigint): SwapPsetInspection =>
    inspection({ netBalances: new Map([[LBTC, RECV], [DEPIX, fromNet]]) });

  it("passes the honest path: from-net == -sendAmount (change correctly returned)", () => {
    expect(() => assertSwapPsetPaysAndBalances(withFromNet(-SEND), expectValid)).not.toThrow();
  });

  it("passes within the network-fee slack (from-net a little beyond -sendAmount)", () => {
    expect(() => assertSwapPsetPaysAndBalances(withFromNet(-(SEND + 4_000n)), expectValid)).not.toThrow();
  });

  it("passes exactly at sendAmount + slack, rejects one base unit over (slack = 5_000)", () => {
    expect(() => assertSwapPsetPaysAndBalances(withFromNet(-(SEND + 5_000n)), expectValid)).not.toThrow();
    expect(() => assertSwapPsetPaysAndBalances(withFromNet(-(SEND + 5_001n)), expectValid)).toThrow();
  });

  it("FAIL-CLOSED: a shrunk/omitted change (whole UTXO consumed) aborts, unsigned", () => {
    // Dealer omits our change: a 1,000,000-unit UTXO fully spent to send 2000.
    expect(() => assertSwapPsetPaysAndBalances(withFromNet(-1_000_000n), expectValid)).toThrow();
    try {
      assertSwapPsetPaysAndBalances(withFromNet(-1_000_000n), expectValid);
    } catch (e) {
      expect(isSwapFail(e)).toBe(true);
    }
  });

  it("passes when the from-asset is absent (zero outflow — cannot overpay us)", () => {
    // Only the recv side present in the net balances → sentFrom = 0.
    expect(() => assertSwapPsetPaysAndBalances(inspection(), expectValid)).not.toThrow();
  });

  it("rejects a non-positive quoted send amount", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(withFromNet(-SEND), { ...expectValid, sendAmountSats: 0n })
    ).toThrow();
  });
});

describe("inspectSwapPset — offline lwk adapter smoke", () => {
  it("returns a Map (not null) and an output-scripts array for a real empty PSET", () => {
    const wollet = buildWollet(
      descriptorFromMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
      )
    );
    const pset = new Pset("cHNldP8BAgQCAAAAAQQBAAEFAQABBgEDAfsEAgAAAAA=");
    const result = inspectSwapPset(pset as never, wollet as never);
    // The critical parsing property: entries() (a JS Map in lwk 0.18) is read
    // into a Map — NOT left null, which would fail-close every legit swap.
    expect(result.netBalances).toBeInstanceOf(Map);
    expect(Array.isArray(result.outputScriptsHex)).toBe(true);
    wollet.free();
  });
});

describe("assertPegOutRecipient — peg-out output pin (§5.2)", () => {
  const PEG_SCRIPT = "0014aaaa00112233445566778899aabbccddeeff0011";
  const good: PegOutRecipient[] = [{ asset: LBTC, value: 5000n, scriptHex: PEG_SCRIPT }];
  const expectPeg = { lbtcId: LBTC, authorizedSats: 5000n, expectedScriptHex: PEG_SCRIPT };

  it("passes for exactly one L-BTC recipient at the peg script, within the authorized amount", () => {
    expect(() => assertPegOutRecipient(good, expectPeg)).not.toThrow();
    // ≤ authorized is fine (network fee shaving would only reduce it).
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: 4900n, scriptHex: PEG_SCRIPT }], expectPeg)
    ).not.toThrow();
  });

  it("aborts on ≠1 external recipients", () => {
    expect(() => assertPegOutRecipient([], expectPeg)).toThrow();
    expect(() => assertPegOutRecipient([...good, ...good], expectPeg)).toThrow();
  });

  it("aborts on a non-L-BTC asset", () => {
    expect(() =>
      assertPegOutRecipient([{ asset: ASSETS.DEPIX.id, value: 5000n, scriptHex: PEG_SCRIPT }], expectPeg)
    ).toThrow();
  });

  it("aborts when the recipient exceeds the authorized amount", () => {
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: 5001n, scriptHex: PEG_SCRIPT }], expectPeg)
    ).toThrow();
  });

  it("aborts when the recipient does not pay the peg script", () => {
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: 5000n, scriptHex: OTHER_SCRIPT }], expectPeg)
    ).toThrow();
  });

  it("aborts on an unreadable / non-positive recipient value", () => {
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: null, scriptHex: PEG_SCRIPT }], expectPeg)
    ).toThrow();
    expect(() =>
      assertPegOutRecipient([{ asset: LBTC, value: 0n, scriptHex: PEG_SCRIPT }], expectPeg)
    ).toThrow();
  });
});

describe("assertSwapPsetPaysAndBalances — fee-aware recv window (mainnet e2e P0, 2026-07-11)", () => {
  // SideSwap's quoted recv_amount is PRE-fee when the fees fall on the recv leg:
  // the dealer nets server_fee + fixed_fee out of the recv output. Live repro
  // (DePix → L-BTC, fee on the L-BTC recv leg): quote 5945, PSET 5853 (fixed
  // network fee ≈ 92) — every small swap aborted until this window learned about
  // the declared fees. The effective tolerance here is the 100-unit floor, not
  // 1% (59), since 5945 is below the 10_000-unit crossover.
  const QUOTED = 5945n;
  const FEES = 92n;
  const TOL = 100n; // 1% of 5945 is 59, floored to 100
  const expectWithFees = {
    ...expectValid,
    recvAmountSats: QUOTED,
    declaredFeesSats: FEES,
    feeAssetId: LBTC // fees denominated in the recv asset → they net from recv
  };
  const netOf = (n: bigint): SwapPsetInspection => inspection({ netBalances: new Map([[LBTC, n]]) });

  it("REGRESSION: accepts the live-observed post-fee net (5853 for quote 5945, fees 92)", () => {
    expect(() => assertSwapPsetPaysAndBalances(netOf(5853n), expectWithFees)).not.toThrow();
  });

  it("returns the ACTUAL post-fee net the PSET credits (callers must not report the pre-fee quote)", () => {
    expect(assertSwapPsetPaysAndBalances(netOf(5853n), expectWithFees)).toBe(5853n);
    expect(assertSwapPsetPaysAndBalances(inspection(), expectValid)).toBe(RECV);
  });

  it("accepts the exact window edges [quote − fees − tol, quote + tol]", () => {
    expect(() => assertSwapPsetPaysAndBalances(netOf(QUOTED - FEES - TOL), expectWithFees)).not.toThrow();
    expect(() => assertSwapPsetPaysAndBalances(netOf(QUOTED + TOL), expectWithFees)).not.toThrow();
  });

  it("FAIL-CLOSED: aborts one base unit beyond either edge — fees never widen the window open-endedly", () => {
    expect(() => assertSwapPsetPaysAndBalances(netOf(QUOTED - FEES - TOL - 1n), expectWithFees)).toThrow();
    expect(() => assertSwapPsetPaysAndBalances(netOf(QUOTED + TOL + 1n), expectWithFees)).toThrow();
    try {
      assertSwapPsetPaysAndBalances(netOf(QUOTED - FEES - TOL - 1n), expectWithFees);
    } catch (e) {
      expect(isSwapFail(e)).toBe(true);
    }
  });

  it("omitted / zero declaredFeesSats applies no fee widening (band is ±tolerance only)", () => {
    // 880 is below the [900, 1100] band for a 1000 quote with no fee netting.
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection({ netBalances: new Map([[LBTC, 880n]]) }), expectValid)
    ).toThrow();
    expect(() =>
      assertSwapPsetPaysAndBalances(
        inspection({ netBalances: new Map([[LBTC, 880n]]) }),
        { ...expectValid, declaredFeesSats: 0n }
      )
    ).toThrow();
  });

  it("refuses with a 'too small' diagnosis when recv-leg fees meet/exceed the quoted recv", () => {
    const tiny = { ...expectValid, recvAmountSats: 90n, declaredFeesSats: 92n, feeAssetId: LBTC };
    expect(() => assertSwapPsetPaysAndBalances(netOf(1n), tiny)).toThrow(/too small/);
    try {
      assertSwapPsetPaysAndBalances(netOf(1n), tiny);
    } catch (e) {
      expect(isSwapFail(e)).toBe(true);
    }
  });

  it("rejects negative declaredFeesSats", () => {
    expect(() =>
      assertSwapPsetPaysAndBalances(inspection(), { ...expectValid, declaredFeesSats: -1n })
    ).toThrow();
  });
});
