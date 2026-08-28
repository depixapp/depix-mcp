// Pure BOLT11 helpers + fail-closed guards (spec §5.3) — no network, no WASM.
import { describe, expect, it } from "vitest";
import {
  assertLockupNotInflated,
  assertTimeoutInBounds,
  decodeInvoiceAmountSats,
  decodeInvoiceExpiryMs,
  decodeInvoicePaymentHash,
  isInvoiceExpired,
  mapSubmarineStatus,
  MAX_SUBMARINE_TIMEOUT_BLOCKS
} from "../../src/wallet-engine/convert/boltz/lightning.js";
import { isDepixSdkError } from "../../src/wallet-engine/errors.js";
import {
  syntheticBolt11,
  TEST_INVOICE,
  TEST_INVOICE_LIVE,
  TEST_INVOICE_SATS,
  TEST_PAYMENT_HASH
} from "./support/boltz.js";

describe("decodeInvoiceAmountSats", () => {
  it("decodes the amount from a real BOLT11 invoice (2500u = 250_000 sats)", () => {
    expect(decodeInvoiceAmountSats(TEST_INVOICE)).toBe(TEST_INVOICE_SATS);
  });

  it("decodes each multiplier exactly (m/u/n) and whole-BTC", () => {
    // 1 BTC = 100_000_000 sats (amount "1" in the HRP, then the bech32 separator).
    expect(decodeInvoiceAmountSats("lnbc11xxxx")).toBe(100_000_000);
    // 1m BTC = 100_000 sats.
    expect(decodeInvoiceAmountSats("lnbc1m1xxxx")).toBe(100_000);
    // 20u BTC = 2_000 sats.
    expect(decodeInvoiceAmountSats("lnbc20u1xxxx")).toBe(2_000);
    // 1500n BTC = 150 sats.
    expect(decodeInvoiceAmountSats("lnbc1500n1xxxx")).toBe(150);
  });

  it("returns null for amount-less, sub-satoshi, and unparseable invoices", () => {
    expect(decodeInvoiceAmountSats("lnbc1pxxxx")).toBeNull(); // no amount digits
    expect(decodeInvoiceAmountSats("lnbc1p1xxxx")).toBeNull(); // 1p = sub-sat residue
    expect(decodeInvoiceAmountSats("not-an-invoice")).toBeNull();
    expect(decodeInvoiceAmountSats(123 as never)).toBeNull();
  });
});

describe("decodeInvoicePaymentHash", () => {
  it("decodes the 32-byte payment hash of a real BOLT11 invoice", () => {
    expect(decodeInvoicePaymentHash(TEST_INVOICE)).toBe(TEST_PAYMENT_HASH);
  });

  it("returns null for a non-invoice string", () => {
    expect(decodeInvoicePaymentHash("hello")).toBeNull();
    expect(decodeInvoicePaymentHash(null as never)).toBeNull();
  });
});

describe("decodeInvoiceExpiryMs", () => {
  const TS = 1_700_000_000; // 2023-11-14T22:13:20Z

  it("returns timestamp + the explicit expiry tag, in epoch ms", () => {
    const inv = syntheticBolt11({ timestampSec: TS, expirySeconds: 600 });
    expect(decodeInvoiceExpiryMs(inv)).toBe((TS + 600) * 1000);
  });

  it("defaults to 3600s when the expiry tag is absent (BOLT #11)", () => {
    const inv = syntheticBolt11({ timestampSec: TS, expirySeconds: null });
    expect(decodeInvoiceExpiryMs(inv)).toBe((TS + 3600) * 1000);
  });

  it("is case-insensitive (the uppercase QR form)", () => {
    const inv = syntheticBolt11({ timestampSec: TS, expirySeconds: 600 });
    expect(decodeInvoiceExpiryMs(inv.toUpperCase())).toBe((TS + 600) * 1000);
  });

  it("returns null for a non-Lightning bech32 string or garbage", () => {
    expect(decodeInvoiceExpiryMs(syntheticBolt11({ hrp: "bc", timestampSec: TS }))).toBeNull();
    expect(decodeInvoiceExpiryMs("notaninvoice")).toBeNull();
    expect(decodeInvoiceExpiryMs("")).toBeNull();
    expect(decodeInvoiceExpiryMs(null as never)).toBeNull();
    expect(decodeInvoiceExpiryMs(12345 as never)).toBeNull();
  });
});

describe("isInvoiceExpired", () => {
  const TS = 1_700_000_000;
  const INV = syntheticBolt11({ timestampSec: TS, expirySeconds: 600 });

  it("is true past timestamp+expiry, and AT the expiry instant", () => {
    expect(isInvoiceExpired(INV, (TS + 601) * 1000)).toBe(true);
    expect(isInvoiceExpired(INV, (TS + 600) * 1000)).toBe(true);
  });

  it("is false while the invoice is still valid", () => {
    expect(isInvoiceExpired(INV, (TS + 599) * 1000)).toBe(false);
  });

  it("defaults `now` to Date.now()", () => {
    expect(isInvoiceExpired(TEST_INVOICE)).toBe(true); // the 2017 spec invoice
    expect(isInvoiceExpired(TEST_INVOICE_LIVE)).toBe(false);
  });

  it("fails OPEN when the invoice cannot be decoded — the server rejection is the backstop", () => {
    expect(isInvoiceExpired("notaninvoice")).toBe(false);
    expect(isInvoiceExpired(null as never)).toBe(false);
  });
});

describe("assertLockupNotInflated (fail-closed §5.3)", () => {
  it("accepts an expectedAmount within ceil(invoiceSats*1.05)+2000", () => {
    // ceiling = ceil(250000*1.05)+2000 = 262500+2000 = 264500.
    expect(() => assertLockupNotInflated(264_500, TEST_INVOICE_SATS)).not.toThrow();
    expect(() => assertLockupNotInflated(255_000, TEST_INVOICE_SATS)).not.toThrow();
  });

  it("throws LOCKUP_INFLATED above the ceiling", () => {
    try {
      assertLockupNotInflated(264_501, TEST_INVOICE_SATS);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isDepixSdkError(err, "LOCKUP_INFLATED")).toBe(true);
    }
  });

  it("throws INVOICE_NO_AMOUNT when the invoice amount is unknown (null)", () => {
    try {
      assertLockupNotInflated(1000, null);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isDepixSdkError(err, "INVOICE_NO_AMOUNT")).toBe(true);
    }
  });

  it("throws LOCKUP_INFLATED for a non-finite/zero expectedAmount", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        assertLockupNotInflated(bad, TEST_INVOICE_SATS);
        throw new Error("should have thrown");
      } catch (err) {
        expect(isDepixSdkError(err, "LOCKUP_INFLATED")).toBe(true);
      }
    }
  });
});

describe("assertTimeoutInBounds (fail-closed §5.3)", () => {
  it("accepts a timeout strictly in the future within MAX_SUBMARINE_TIMEOUT_BLOCKS", () => {
    expect(() => assertTimeoutInBounds(1_000_100, 1_000_000)).not.toThrow();
    expect(() =>
      assertTimeoutInBounds(1_000_000 + MAX_SUBMARINE_TIMEOUT_BLOCKS, 1_000_000)
    ).not.toThrow();
  });

  it("throws TIMEOUT_OUT_OF_BOUNDS for a past or too-far timeout", () => {
    for (const timeout of [999_999, 1_000_000, 1_000_000 + MAX_SUBMARINE_TIMEOUT_BLOCKS + 1]) {
      try {
        assertTimeoutInBounds(timeout, 1_000_000);
        throw new Error("should have thrown");
      } catch (err) {
        expect(isDepixSdkError(err, "TIMEOUT_OUT_OF_BOUNDS")).toBe(true);
      }
    }
  });

  it("SKIPS the bound (best-effort) when the current height is unknown", () => {
    expect(() => assertTimeoutInBounds(99_999_999, null)).not.toThrow();
  });
});

describe("mapSubmarineStatus", () => {
  it("maps raw Boltz statuses to coarse buckets", () => {
    expect(mapSubmarineStatus("transaction.claimed")).toBe("completed");
    expect(mapSubmarineStatus("invoice.failedToPay")).toBe("refund");
    expect(mapSubmarineStatus("swap.expired")).toBe("refund");
    expect(mapSubmarineStatus("transaction.refunded")).toBe("refunded");
    expect(mapSubmarineStatus("invoice.pending")).toBe("paying");
    expect(mapSubmarineStatus("unknown.status")).toBeNull();
    expect(mapSubmarineStatus(42 as never)).toBeNull();
  });
});
