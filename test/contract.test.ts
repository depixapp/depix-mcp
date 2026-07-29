// Contract test (spec §4.8). Fails CI if src/schemas.ts (enums / terminal sets)
// or src/requestMap.ts (wire field names) drift from the pinned OpenAPI 0.20.0
// fixture. This is the guard that catches the amount_cents↔amount and
// product_ids↔productIds class of bug before it 400s in production.
//
// 0.20.0 is the "Pagar com DePix" contract: `payment_method` selects the rail,
// the `depix` object replaces `pix` on the direct-Liquid rail, and both
// `expires_in` and `payer_tax_number` became RAIL-CONDITIONAL. The fixture pins
// those conditional bounds so the MCP can never reject client-side what the API
// accepts (or the reverse).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as schemas from "../src/schemas.js";
import {
  buildCreateCheckoutBody,
  buildCreateProductBody,
  buildSetFeaturedBody,
  buildUpdateProductBody,
} from "../src/requestMap.js";
import { SCOPES } from "../src/errors.js";

interface RailRules {
  expires_in: { minimum: number; maximum: number };
  required: string[];
}
interface Bounds {
  minimum: number;
  maximum: number;
}
interface Fixture {
  info_version: string;
  scopes: string[];
  statusEnums: { checkout: string[]; deposit: string[]; withdrawal: string[] };
  terminal: { checkout: string[]; deposit: string[]; withdrawal: string[] };
  sandboxStatus: { deposit: string; withdrawal: string };
  paymentMethods: string[];
  requestBodies: Record<
    string,
    {
      required: string[];
      properties: string[];
      railConditional?: { pix: RailRules; depix: RailRules };
      fieldBounds?: Record<string, Bounds>;
    }
  >;
  responseFields: Record<string, string[]>;
  depixPaymentRequired: string[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/openapi-0.20.0.json", import.meta.url), "utf8"),
) as Fixture;

const CHECKOUTS = "POST /api/checkouts";
const rails = fixture.requestBodies[CHECKOUTS].railConditional!;
const TAX = "52998224725";

describe("contract: pinned to OpenAPI 0.20.0", () => {
  it("pins the version", () => {
    expect(fixture.info_version).toBe("0.20.0");
  });

  it("scopes match the closed set", () => {
    expect([...SCOPES]).toEqual(fixture.scopes);
  });

  it("status enums match", () => {
    expect([...schemas.CHECKOUT_STATUSES]).toEqual(fixture.statusEnums.checkout);
    expect([...schemas.DEPOSIT_STATUSES]).toEqual(fixture.statusEnums.deposit);
    expect([...schemas.WITHDRAWAL_STATUSES]).toEqual(fixture.statusEnums.withdrawal);
  });

  it("terminal sets match", () => {
    expect([...schemas.TERMINAL_CHECKOUT_STATUSES]).toEqual(fixture.terminal.checkout);
    expect([...schemas.TERMINAL_DEPOSIT_STATUSES]).toEqual(fixture.terminal.deposit);
    expect([...schemas.TERMINAL_WITHDRAWAL_STATUSES]).toEqual(fixture.terminal.withdrawal);
  });

  it("sandbox synthetic statuses match", () => {
    expect(schemas.SANDBOX_DEPOSIT_STATUS).toBe(fixture.sandboxStatus.deposit);
    expect(schemas.SANDBOX_WITHDRAWAL_STATUS).toBe(fixture.sandboxStatus.withdrawal);
  });

  it("payment methods match the rail enum", () => {
    expect([...schemas.PAYMENT_METHODS]).toEqual(fixture.paymentMethods);
  });
});

describe("contract: request bodies use the wire field names", () => {
  function assertBody(endpoint: string, body: Record<string, unknown>) {
    const spec = fixture.requestBodies[endpoint];
    expect(spec, `missing fixture for ${endpoint}`).toBeDefined();
    for (const key of Object.keys(body)) {
      expect(spec.properties, `${endpoint}: unexpected wire field \`${key}\``).toContain(key);
    }
    for (const req of spec.required) {
      expect(Object.keys(body), `${endpoint}: missing required \`${req}\``).toContain(req);
    }
  }

  it("POST /api/checkouts maps amount_cents alias → amount (never amount_cents on the wire)", () => {
    const body = buildCreateCheckoutBody({
      amount_cents: 1500,
      payer_tax_number: TAX,
      description: "x",
      metadata: { a: 1 },
      idempotency_key: "should-not-be-in-body",
    });
    expect(body.amount).toBe(1500);
    expect(body).not.toHaveProperty("amount_cents");
    expect(body).not.toHaveProperty("idempotency_key");
    assertBody(CHECKOUTS, body);
  });

  it("POST /api/checkouts carries the depix rail fields, and the pix rail's payer document", () => {
    const body = buildCreateCheckoutBody({
      amount: 9990,
      payment_method: "depix",
      expected_discount_pct: 10,
      expires_in: 1800,
    });
    expect(body.payment_method).toBe("depix");
    expect(body.expected_discount_pct).toBe(10);
    // The rail has no payer identity by design — the field is never forwarded.
    expect(body).not.toHaveProperty("payer_tax_number");
    assertBody(CHECKOUTS, body);
    // …and the pix rail's own required field is still satisfied there.
    assertBody(CHECKOUTS, buildCreateCheckoutBody({ amount: 1500, payer_tax_number: TAX }));
  });

  it("the pix rail's conditional `required` from the fixture is enforced client-side", () => {
    expect(rails.pix.required).toContain("payer_tax_number");
    expect(rails.depix.required).not.toContain("payer_tax_number");
    expect(() => buildCreateCheckoutBody({ amount: 1500 })).toThrowError(/payer_tax_number/);
    expect(() =>
      buildCreateCheckoutBody({ amount: 1500, payment_method: "pix" }),
    ).toThrowError(/payer_tax_number/);
  });

  it("expires_in bounds follow the rail-conditional fixture (pix is NOT widened)", () => {
    const shape = z.object(schemas.createCheckoutInput);
    // Field-level bounds must span the WIDEST rail, otherwise the tool schema
    // would reject client-side what the API accepts.
    expect(shape.safeParse({ amount: 1500, payment_method: "depix", expires_in: rails.depix.expires_in.maximum }).success).toBe(true);
    expect(shape.safeParse({ amount: 1500, payment_method: "depix", expires_in: rails.depix.expires_in.maximum + 1 }).success).toBe(false);
    expect(shape.safeParse({ amount: 1500, payer_tax_number: TAX, expires_in: rails.pix.expires_in.minimum - 1 }).success).toBe(false);

    // …and the narrower pix ceiling is enforced by the rail-conditional refine.
    expect(
      buildCreateCheckoutBody({ amount: 1500, payer_tax_number: TAX, expires_in: rails.pix.expires_in.maximum }).expires_in,
    ).toBe(rails.pix.expires_in.maximum);
    expect(() =>
      buildCreateCheckoutBody({ amount: 1500, payer_tax_number: TAX, expires_in: rails.pix.expires_in.maximum + 1 }),
    ).toThrowError(/expires_in/);
    expect(
      buildCreateCheckoutBody({ amount: 1500, payment_method: "depix", expires_in: rails.pix.expires_in.maximum + 1 }).expires_in,
    ).toBe(rails.pix.expires_in.maximum + 1);
  });

  // The `amount` ceiling drifted once already: the backend raised it to
  // R$ 6.000 and this schema stayed at R$ 3.000, so every charge above the old
  // cap died in a client-side zod error the API would have accepted — the exact
  // failure this file exists to catch, except nothing pinned the NUMBER, only
  // the field name. These assertions read the bounds from the fixture so the
  // next raise fails here instead of in production.
  describe("amount bounds are pinned to the document, not hardcoded", () => {
    const AMOUNT_ENDPOINTS: Array<[string, Record<string, z.ZodTypeAny>, Record<string, unknown>]> = [
      [CHECKOUTS, schemas.createCheckoutInput, { payment_method: "depix" }],
      ["POST /api/products", schemas.createProductInput, { name: "Ebook" }],
      ["PATCH /api/products/{id}", schemas.updateProductInput, { product_id: "prd_1" }],
    ];

    it.each(AMOUNT_ENDPOINTS)("%s accepts the documented range and nothing beyond it", (endpoint, input, extra) => {
      const bounds = fixture.requestBodies[endpoint].fieldBounds?.amount;
      expect(bounds, `${endpoint}: fixture must pin the amount bounds`).toBeDefined();
      const shape = z.object(input);

      // Both wire aliases carry the same ceiling — `amount_cents` is the one
      // agents reach for, and it used to be just as stale.
      for (const key of ["amount", "amount_cents"]) {
        expect(shape.safeParse({ ...extra, [key]: bounds!.maximum }).success, `${endpoint}: ${key} must accept the documented maximum`).toBe(true);
        expect(shape.safeParse({ ...extra, [key]: bounds!.maximum + 1 }).success, `${endpoint}: ${key} must reject above the maximum`).toBe(false);
        expect(shape.safeParse({ ...extra, [key]: bounds!.minimum }).success, `${endpoint}: ${key} must accept the documented minimum`).toBe(true);
        expect(shape.safeParse({ ...extra, [key]: bounds!.minimum - 1 }).success, `${endpoint}: ${key} must reject below the minimum`).toBe(false);
      }
    });

    it("states the real range in the field description an agent reads", () => {
      const described = z.object(schemas.createCheckoutInput).shape.amount.description ?? "";
      const { minimum, maximum } = fixture.requestBodies[CHECKOUTS].fieldBounds!.amount;
      // An agent picks the amount from this string, so a stale ceiling here
      // makes it self-censor below what the merchant can actually charge —
      // invisible to any assertion that only checks the zod bounds.
      expect(described).toContain(String(maximum / 100));
      expect(described).toContain(String(minimum / 100));
    });
  });

  it("POST /api/products maps amount_cents alias → amount", () => {
    const body = buildCreateProductBody({ name: "Ebook", amount_cents: 700 });
    expect(body.amount).toBe(700);
    expect(body).not.toHaveProperty("amount_cents");
    assertBody("POST /api/products", body);
  });

  it("PATCH /api/products/{id} maps amount_cents → amount and drops product_id", () => {
    const body = buildUpdateProductBody({ product_id: "prd_1", amount_cents: 900 });
    expect(body.amount).toBe(900);
    expect(body).not.toHaveProperty("amount_cents");
    expect(body).not.toHaveProperty("product_id");
    assertBody("PATCH /api/products/{id}", body);
  });

  it("POST /api/products/featured maps product_ids → productIds", () => {
    const body = buildSetFeaturedBody({ product_ids: ["prd_1", "prd_2"] });
    expect(body).toEqual({ productIds: ["prd_1", "prd_2"] });
    assertBody("POST /api/products/featured", body);
  });
});

describe("contract: output shapes stay within the response schema", () => {
  const derived = new Set(["terminal", "replayed"]); // MCP-derived, not API fields

  function assertOutputSubset(shape: Record<string, unknown>, schemaName: string) {
    const allowed = new Set(fixture.responseFields[schemaName]);
    for (const key of Object.keys(shape)) {
      if (derived.has(key)) continue;
      expect(allowed.has(key), `${schemaName}: output field \`${key}\` not in the API response`).toBe(
        true,
      );
    }
  }

  it("create_checkout ⊆ CheckoutCreateResponse", () => {
    assertOutputSubset(schemas.checkoutCreateOutput, "CheckoutCreateResponse");
  });
  it("get_checkout ⊆ CheckoutDetail", () => {
    assertOutputSubset(schemas.checkoutDetailOutput, "CheckoutDetail");
  });
  it("get_account ⊆ MeResponse", () => {
    assertOutputSubset(schemas.getAccountOutput, "MeResponse");
  });
  it("get_deposit_status ⊆ DepositStatusResponse (+derived)", () => {
    assertOutputSubset(schemas.getDepositStatusOutput, "DepositStatusResponse");
  });
  it("get_withdrawal_status ⊆ WithdrawalStatusResponse (+derived)", () => {
    assertOutputSubset(schemas.getWithdrawalStatusOutput, "WithdrawalStatusResponse");
  });

  it("the depix payment object mirrors DepixPayment EXACTLY (every field is required upstream)", () => {
    for (const shape of [schemas.checkoutCreateOutput, schemas.checkoutDetailOutput]) {
      const depix = (shape as Record<string, unknown>).depix as
        | z.ZodOptional<z.AnyZodObject>
        | undefined;
      expect(depix, "depix is missing from the output shape").toBeDefined();
      expect(Object.keys(depix!.unwrap().shape).sort()).toEqual(
        [...fixture.depixPaymentRequired].sort(),
      );
    }
  });
});
