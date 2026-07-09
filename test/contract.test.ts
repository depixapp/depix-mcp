// Contract test (spec §4.8). Fails CI if src/schemas.ts (enums / terminal sets)
// or src/requestMap.ts (wire field names) drift from the pinned OpenAPI 0.6.0
// fixture. This is the guard that catches the amount_cents↔amount and
// product_ids↔productIds class of bug before it 400s in production.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as schemas from "../src/schemas.js";
import {
  buildCreateCheckoutBody,
  buildCreateProductBody,
  buildSetFeaturedBody,
  buildUpdateProductBody,
} from "../src/requestMap.js";
import { SCOPES } from "../src/errors.js";

interface Fixture {
  info_version: string;
  scopes: string[];
  statusEnums: { checkout: string[]; deposit: string[]; withdrawal: string[] };
  terminal: { checkout: string[]; deposit: string[]; withdrawal: string[] };
  sandboxStatus: { deposit: string; withdrawal: string };
  requestBodies: Record<string, { required: string[]; properties: string[] }>;
  responseFields: Record<string, string[]>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/openapi-0.6.0.json", import.meta.url), "utf8"),
) as Fixture;

describe("contract: pinned to OpenAPI 0.6.0", () => {
  it("pins the version", () => {
    expect(fixture.info_version).toBe("0.6.0");
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
      payer_tax_number: "52998224725",
      description: "x",
      metadata: { a: 1 },
      idempotency_key: "should-not-be-in-body",
    });
    expect(body.amount).toBe(1500);
    expect(body).not.toHaveProperty("amount_cents");
    expect(body).not.toHaveProperty("idempotency_key");
    assertBody("POST /api/checkouts", body);
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
  const derived = new Set(["terminal"]); // MCP-derived, not an API field

  function assertOutputSubset(shape: Record<string, unknown>, schemaName: string) {
    const allowed = new Set(fixture.responseFields[schemaName]);
    for (const key of Object.keys(shape)) {
      if (derived.has(key)) continue;
      expect(allowed.has(key), `${schemaName}: output field \`${key}\` not in the API response`).toBe(
        true,
      );
    }
  }

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
});
