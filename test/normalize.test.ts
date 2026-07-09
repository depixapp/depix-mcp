import { describe, expect, it } from "vitest";
import {
  deriveHasMore,
  isTerminal,
  normalizeBool,
  normalizeIsLive,
  parseMetadata,
  unwrap,
} from "../src/normalize.js";
import { TERMINAL_CHECKOUT_STATUSES } from "../src/schemas.js";

describe("normalizeIsLive (spec §4.0)", () => {
  it("boolean true/false", () => {
    expect(normalizeIsLive({ is_live: true })).toBe(true);
    expect(normalizeIsLive({ is_live: false })).toBe(false);
  });
  it("SQLite int 1/0", () => {
    expect(normalizeIsLive({ is_live: 1 })).toBe(true);
    expect(normalizeIsLive({ is_live: 0 })).toBe(false);
  });
  it("falls back to inverted is_test when is_live absent", () => {
    expect(normalizeIsLive({ is_test: 1 })).toBe(false);
    expect(normalizeIsLive({ is_test: 0 })).toBe(true);
    expect(normalizeIsLive({ is_test: true })).toBe(false);
  });
  it("defaults to non-live when both absent", () => {
    expect(normalizeIsLive({})).toBe(false);
  });
});

describe("normalizeBool", () => {
  it("treats 1/true as true, else false", () => {
    expect(normalizeBool(1)).toBe(true);
    expect(normalizeBool(true)).toBe(true);
    expect(normalizeBool(0)).toBe(false);
    expect(normalizeBool("1")).toBe(false);
    expect(normalizeBool(null)).toBe(false);
  });
});

describe("parseMetadata", () => {
  it("object passes through", () => {
    expect(parseMetadata({ a: 1 })).toEqual({ a: 1 });
  });
  it("JSON string parses to object", () => {
    expect(parseMetadata('{"order_id":"123"}')).toEqual({ order_id: "123" });
  });
  it("null/empty → null", () => {
    expect(parseMetadata(null)).toBeNull();
    expect(parseMetadata("")).toBeNull();
    expect(parseMetadata(undefined)).toBeNull();
  });
  it("unparseable string is preserved (no data loss)", () => {
    expect(parseMetadata("not json")).toBe("not json");
  });
});

describe("unwrap", () => {
  it("unwraps a single-key envelope", () => {
    expect(unwrap({ checkout: { id: "chk_1" } }, "checkout")).toEqual({ id: "chk_1" });
  });
  it("returns the body when the key is absent", () => {
    expect(unwrap({ id: "chk_1" }, "checkout")).toEqual({ id: "chk_1" });
  });
});

describe("deriveHasMore (exact via total, spec §4.1)", () => {
  it("false on the exact-multiple last page (no extra empty fetch)", () => {
    // total 100, page of 50 at offset 50 → 50+50 = 100, not < 100.
    expect(deriveHasMore(50, 50, 100)).toBe(false);
  });
  it("true when more remain", () => {
    expect(deriveHasMore(0, 50, 100)).toBe(true);
  });
});

describe("isTerminal", () => {
  it("uses the canonical terminal set", () => {
    expect(isTerminal("completed", TERMINAL_CHECKOUT_STATUSES)).toBe(true);
    expect(isTerminal("pending", TERMINAL_CHECKOUT_STATUSES)).toBe(false);
  });
});
