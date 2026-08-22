import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiClient } from "../src/apiClient.js";
import {
  createCheckout,
  getCheckout,
  listCheckouts,
  simulateCheckoutPayment,
} from "../src/tools/checkouts.js";
import * as s from "../src/schemas.js";
import { buildCreateCheckoutBody } from "../src/requestMap.js";
import { ToolError } from "../src/errors.js";
import { makeFetch, type MockResponseSpec } from "./helpers/mockFetch.js";

const BASE = "https://api.depixapp.com";
const KEY = "sk_test_ABC";

function makeClient(specs: MockResponseSpec[]) {
  const { fetchImpl, requests } = makeFetch(specs);
  return {
    client: new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl, sleep: async () => {} }),
    requests,
  };
}

describe("create_checkout (spec §4.1)", () => {
  it("POSTs amount (not amount_cents), auto-generates Idempotency-Key, normalizes output", async () => {
    const { client, requests } = makeClient([
      {
        status: 201,
        json: {
          id: "chk_1",
          status: "pending",
          amount: 1500,
          description: "Pedido",
          image_url: null,
          expires_at: "2026-07-01 12:20:00",
          is_live: true,
          payment_url: "https://pay.depixapp.com/chk_1",
          pix: { qr_code: "000201..." },
        },
      },
    ]);
    const out = await createCheckout(client, { amount: 1500, payer_tax_number: "52998224725" });
    const req = requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/api/checkouts`);
    expect(req.headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
    const body = JSON.parse(req.body!);
    expect(body.amount).toBe(1500);
    expect(body).not.toHaveProperty("amount_cents");
    expect(out).toMatchObject({ id: "chk_1", is_live: true, pix: { qr_code: "000201..." } });
    expect(out).not.toHaveProperty("replayed");
    expect(z.object(s.checkoutCreateOutput).safeParse(out).success).toBe(true);
  });

  it("marks replayed:true on Idempotency-Replayed", async () => {
    const { client } = makeClient([
      {
        status: 201,
        headers: { "idempotency-replayed": "true" },
        json: {
          id: "chk_1",
          status: "pending",
          amount: 1500,
          description: null,
          image_url: null,
          expires_at: null,
          is_live: false,
          payment_url: "https://pay.depixapp.com/chk_1",
          pix: { qr_code: "SANDBOX-DO-NOT-PAY" },
        },
      },
    ]);
    const out = await createCheckout(client, {
      amount: 1500,
      payer_tax_number: "52998224725",
      idempotency_key: "k1",
    });
    expect(out).toMatchObject({ replayed: true, is_live: false });
  });
});

describe("create_checkout — depix rail (SPEC_PAGAR_COM_DEPIX §4/§9)", () => {
  const DEPIX_RESPONSE = {
    id: "chk_dpx1",
    status: "pending",
    amount: 9990,
    description: "Pedido #124",
    image_url: null,
    expires_at: "2026-07-29 12:30:00",
    is_live: true,
    payment_url: "https://pay.depixapp.com/chk_dpx1",
    payment_method: "depix",
    depix: {
      address: "lq1qqw8re6vg9dqfazzsx4h9pkq6trxfmk8n0h0ykr7v9k8xn7pdrjq9m4v0rn3hhkq2c6jl2m8q7z0v",
      amount_cents: 8991,
      amount: "89.91",
      asset_id: "02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189",
      uri: "liquidnetwork:lq1qqw8re6vg9dqfazzsx4h9pkq6trxfmk8n0h0ykr7v9k8xn7pdrjq9m4v0rn3hhkq2c6jl2m8q7z0v?amount=89.91&assetid=02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189",
      discount_pct: 10,
      original_amount_cents: 9990,
      detected: false,
    },
  };

  it("POSTs the rail + expected discount and returns `depix` instead of `pix`", async () => {
    const { client, requests } = makeClient([{ status: 201, json: DEPIX_RESPONSE }]);
    const out = await createCheckout(client, {
      amount: 9990,
      payment_method: "depix",
      expected_discount_pct: 10,
      expires_in: 1800,
    });
    const body = JSON.parse(requests[0].body!);
    expect(body).toMatchObject({
      amount: 9990,
      payment_method: "depix",
      expected_discount_pct: 10,
      expires_in: 1800,
    });
    expect(out).not.toHaveProperty("pix");
    expect(out).toMatchObject({ payment_method: "depix", depix: DEPIX_RESPONSE.depix });
    expect(z.object(s.checkoutCreateOutput).safeParse(out).success).toBe(true);
  });

  it("never forwards payer_tax_number on the depix rail (no payer identity by design)", async () => {
    const { client, requests } = makeClient([{ status: 201, json: DEPIX_RESPONSE }]);
    await createCheckout(client, {
      amount: 9990,
      payment_method: "depix",
      payer_tax_number: "52998224725",
    });
    const body = JSON.parse(requests[0].body!);
    expect(body).not.toHaveProperty("payer_tax_number");
  });

  it("keeps a sandbox checkout unpayable: null uri survives normalization", async () => {
    const sandbox = {
      ...DEPIX_RESPONSE,
      is_live: false,
      depix: {
        ...DEPIX_RESPONSE.depix,
        address: "SANDBOX-DEPIX-TEST-MODE-chk_dpx1-DO-NOT-PAY",
        uri: null,
      },
    };
    const { client } = await Promise.resolve(makeClient([{ status: 201, json: sandbox }]));
    const out = await createCheckout(client, { amount: 9990, payment_method: "depix" });
    expect((out as { depix: { uri: string | null } }).depix.uri).toBeNull();
    expect(z.object(s.checkoutCreateOutput).safeParse(out).success).toBe(true);
  });

  it("omits `pix` when the API returned none — never a hollow qr_code:\"\"", async () => {
    const { client } = makeClient([
      { status: 201, json: { ...DEPIX_RESPONSE, depix: undefined } },
    ]);
    const out = await createCheckout(client, { amount: 9990, payment_method: "depix" });
    expect(out).not.toHaveProperty("pix");
    expect(out).not.toHaveProperty("depix");
  });

  it("omits `payment_method` when the API does not report one (pre-0.20.0 responses)", async () => {
    const { client } = makeClient([
      {
        status: 201,
        json: {
          id: "chk_1",
          status: "pending",
          amount: 1500,
          description: null,
          image_url: null,
          expires_at: null,
          is_live: true,
          payment_url: "https://pay.depixapp.com/chk_1",
          pix: { qr_code: "000201..." },
        },
      },
    ]);
    const out = await createCheckout(client, { amount: 1500, payer_tax_number: "52998224725" });
    expect(out).not.toHaveProperty("payment_method");
    expect(out).toMatchObject({ pix: { qr_code: "000201..." } });
    expect(z.object(s.checkoutCreateOutput).safeParse(out).success).toBe(true);
  });

  it("rejects a pix charge without payer_tax_number before it reaches the API", async () => {
    const { client, requests } = makeClient([]);
    await expect(createCheckout(client, { amount: 1500 })).rejects.toThrowError(
      /payer_tax_number/,
    );
    expect(requests).toHaveLength(0);
  });

  it("reports the rail-conditional refusal as a typed validation_error naming the field", () => {
    try {
      buildCreateCheckoutBody({ amount: 1500, payer_tax_number: "   " });
      expect.unreachable("whitespace is not a payer document");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("validation_error");
      expect((err as ToolError).data).toMatchObject({ details: { field: "payer_tax_number" } });
    }
  });

  it("rejects an out-of-domain discount and an unknown rail at the boundary", () => {
    expect(() =>
      buildCreateCheckoutBody({ amount: 9990, payment_method: "depix", expected_discount_pct: 91 }),
    ).toThrowError();
    expect(() =>
      buildCreateCheckoutBody({
        amount: 1500,
        payer_tax_number: "52998224725",
        // A rail this MCP does not know must never reach the wire unchecked.
        payment_method: "boleto" as unknown as "pix",
      }),
    ).toThrowError();
  });

  it("drops a depix object with no address — half instructions are not payable", async () => {
    const { client } = makeClient([
      {
        status: 201,
        json: { ...DEPIX_RESPONSE, depix: { amount_cents: 8991, detected: false } },
      },
    ]);
    const out = await createCheckout(client, { amount: 9990, payment_method: "depix" });
    expect(out).not.toHaveProperty("depix");
    expect(z.object(s.checkoutCreateOutput).safeParse(out).success).toBe(true);
  });

  it("still flags an idempotent replay on the depix rail", async () => {
    const { client } = makeClient([
      { status: 201, headers: { "idempotency-replayed": "true" }, json: DEPIX_RESPONSE },
    ]);
    const out = await createCheckout(client, {
      amount: 9990,
      payment_method: "depix",
      idempotency_key: "k1",
    });
    expect(out).toMatchObject({ replayed: true, payment_method: "depix" });
  });
});

describe("get_checkout (spec §4.1)", () => {
  it("unwraps { checkout }, normalizes is_live int→bool and metadata string→object", async () => {
    const { client, requests } = makeClient([
      {
        status: 200,
        json: {
          checkout: {
            id: "chk_1",
            status: "completed",
            amount: 1500,
            description: "Pedido",
            image_url: null,
            pix_payload: null,
            callback_url: null,
            redirect_url: null,
            metadata: '{"order_id":"123"}',
            expires_at: "2026-07-01 12:20:00",
            is_live: 1,
            created_at: "2026-07-01 12:00:00",
            processing_at: null,
            approved_at: null,
            completed_at: "2026-07-01 12:02:00",
            cancelled_at: null,
            blockchain_tx_id: "cd".repeat(32),
            rejection_reasons: [],
          },
        },
      },
    ]);
    const out = await getCheckout(client, { checkout_id: "chk_1" });
    expect(requests[0].url).toBe(`${BASE}/api/checkouts/chk_1`);
    expect(out.is_live).toBe(true);
    expect(out.metadata).toEqual({ order_id: "123" });
    expect(out.rejection_reasons).toEqual([]);
    expect(z.object(s.checkoutDetailOutput).safeParse(out).success).toBe(true);
  });

  // The hold pair is what separates a sale waiting out a 14-day hold from one
  // settling in the next few seconds — both read `processing`. This allowlist
  // dropped the pair (the exact bug 2.2.0 fixed for the DePix money fields),
  // so an agent polling the one order it was waiting on had no date to wait
  // for. Null must SURVIVE, not be treated as absence: null answers "no hold
  // decision recorded", a different fact from vault_hours 0.
  it("carries the hold pair through, null included, and omits it only when the API does", async () => {
    const detail = (over: Record<string, unknown>) => ({
      checkout: {
        id: "chk_1",
        status: "processing",
        amount: 5990,
        description: null,
        image_url: null,
        pix_payload: null,
        callback_url: null,
        redirect_url: null,
        metadata: null,
        expires_at: "2026-07-30 12:20:00",
        is_live: 1,
        created_at: "2026-07-30 12:00:00",
        processing_at: "2026-07-30 12:03:00",
        approved_at: null,
        completed_at: null,
        cancelled_at: null,
        blockchain_tx_id: null,
        rejection_reasons: [],
        ...over,
      },
    });
    const { client } = makeClient([
      { status: 200, json: detail({ delay_until: "2026-08-13T09:03:00-03:00", vault_hours: 336 }) },
      { status: 200, json: detail({ delay_until: null, vault_hours: 0 }) },
      { status: 200, json: detail({ delay_until: null, vault_hours: null }) },
      { status: 200, json: detail({}) },
    ]);

    const held = await getCheckout(client, { checkout_id: "chk_1" });
    // Verbatim, offset and all — the provider's string is the contract.
    expect(held.delay_until).toBe("2026-08-13T09:03:00-03:00");
    expect(held.vault_hours).toBe(336);

    const unheld = await getCheckout(client, { checkout_id: "chk_1" });
    expect(unheld).toHaveProperty("delay_until", null);
    expect(unheld).toHaveProperty("vault_hours", 0);

    // Sandbox / DePix rail: no paired deposit, both null — still an answer.
    const noRecord = await getCheckout(client, { checkout_id: "chk_1" });
    expect(noRecord).toHaveProperty("delay_until", null);
    expect(noRecord).toHaveProperty("vault_hours", null);

    // Pre-0.39.0 deployment: keys absent upstream stay absent, never invented.
    const old = await getCheckout(client, { checkout_id: "chk_1" });
    expect(old).not.toHaveProperty("delay_until");
    expect(old).not.toHaveProperty("vault_hours");

    for (const out of [held, unheld, noRecord, old]) {
      expect(z.object(s.checkoutDetailOutput).safeParse(out).success).toBe(true);
    }
  });
});

describe("get_checkout — depix rail (SPEC_PAGAR_COM_DEPIX §4/§9)", () => {
  const detail = (extra: Record<string, unknown>) => ({
    checkout: {
      id: "chk_dpx1",
      status: "pending",
      amount: 9990,
      description: null,
      image_url: null,
      pix_payload: null,
      callback_url: null,
      redirect_url: null,
      metadata: null,
      expires_at: "2026-07-29 12:30:00",
      is_live: 1,
      created_at: "2026-07-29 12:00:00",
      processing_at: null,
      approved_at: null,
      completed_at: null,
      cancelled_at: null,
      blockchain_tx_id: null,
      rejection_reasons: [],
      ...extra,
    },
  });

  it("curates payment_method + depix through the strip (both are on the closed list)", async () => {
    const depix = {
      address: "lq1qq0000",
      amount_cents: 8991,
      amount: "89.91",
      asset_id: "02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189",
      uri: "liquidnetwork:lq1qq0000?amount=89.91&assetid=02f2",
      discount_pct: 10,
      original_amount_cents: 9990,
      detected: true,
    };
    const { client } = makeClient([
      { status: 200, json: detail({ payment_method: "depix", depix }) },
    ]);
    const out = await getCheckout(client, { checkout_id: "chk_dpx1" });
    expect(out).toMatchObject({ payment_method: "depix", depix });
    expect(z.object(s.checkoutDetailOutput).safeParse(out).success).toBe(true);
  });

  it("omits both keys on a pix checkout that carries no depix instructions", async () => {
    const { client } = makeClient([{ status: 200, json: detail({ payment_method: "pix" }) }]);
    const out = await getCheckout(client, { checkout_id: "chk_1" });
    expect(out.payment_method).toBe("pix");
    expect(out).not.toHaveProperty("depix");
    expect(z.object(s.checkoutDetailOutput).safeParse(out).success).toBe(true);
  });

  it("drops an unknown rail instead of failing output validation (forward compatible)", async () => {
    const { client } = makeClient([{ status: 200, json: detail({ payment_method: "carrier_pigeon" }) }]);
    const out = await getCheckout(client, { checkout_id: "chk_1" });
    expect(out).not.toHaveProperty("payment_method");
    expect(z.object(s.checkoutDetailOutput).safeParse(out).success).toBe(true);
  });
});

describe("list_checkouts (spec §4.1)", () => {
  it("derives has_more exactly from stats.total and parses per-item metadata", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          checkouts: [
            {
              id: "chk_1",
              status: "completed",
              amount: 1500,
              description: "Pedido",
              created_at: "2026-07-01 12:00:00",
              expires_at: "2026-07-01 12:20:00",
              is_live: 1,
              processing_at: "2026-07-01 12:01:00",
              approved_at: null,
              metadata: '{"order_id":"123"}',
              product_name: null,
              rejection_reasons: [],
            },
          ],
          stats: { total: 1, pending: 0, completed: 1, completed_amount: 1500 },
          limit: 50,
          offset: 0,
        },
      },
    ]);
    const out = await listCheckouts(client, { limit: 50, offset: 0 });
    expect(out.has_more).toBe(false);
    expect(out.checkouts[0].is_live).toBe(true);
    expect(out.checkouts[0].metadata).toEqual({ order_id: "123" });
    expect(z.object(s.listCheckoutsOutput).safeParse(out).success).toBe(true);
  });

  // A listing that hides the rail forces the agent to re-read every checkout
  // one by one just to reconcile sales, and silently mixes the two rails when
  // it doesn't.
  it("carries payment_method per item, and omits it when the API doesn't report one", async () => {
    const item = (over: Record<string, unknown>) => ({
      id: "chk_1",
      status: "completed",
      amount: 1500,
      description: null,
      created_at: "2026-07-01 12:00:00",
      expires_at: "2026-07-01 12:20:00",
      is_live: 1,
      processing_at: null,
      approved_at: null,
      metadata: null,
      product_name: null,
      rejection_reasons: [],
      ...over,
    });
    const { client } = makeClient([
      {
        status: 200,
        json: {
          checkouts: [
            item({ id: "chk_pix", payment_method: "pix" }),
            item({ id: "chk_depix", payment_method: "depix" }),
            item({ id: "chk_old" }),
            item({ id: "chk_junk", payment_method: "carrier_pigeon" }),
          ],
          stats: { total: 4, pending: 0, completed: 4, completed_amount: 6000 },
          limit: 50,
          offset: 0,
        },
      },
    ]);
    const out = await listCheckouts(client, { limit: 50, offset: 0 });
    expect(out.checkouts[0].payment_method).toBe("pix");
    expect(out.checkouts[1].payment_method).toBe("depix");
    // Absent upstream (pre-0.20.0) and unrecognized values are both dropped
    // rather than defaulted — guessing "pix" here would misreport a sale.
    expect(out.checkouts[2]).not.toHaveProperty("payment_method");
    expect(out.checkouts[3]).not.toHaveProperty("payment_method");
    expect(z.object(s.listCheckoutsOutput).safeParse(out).success).toBe(true);
  });

  // Knowing the rail is not enough to reconcile the sale. `amount` is the FACE
  // price; a DePix-rail payer sends `depix_due_cents` — discounted and
  // cent-jittered, and the only value attribution matches. An agent adding up
  // `amount` over discounted sales overstates every one of them, which is
  // exactly the bug the backend added these two fields to close: the fix landed
  // in the API and this normalizer's allowlist silently dropped both.
  it("carries the DePix money fields, so a discounted sale reconciles to what was paid", async () => {
    const item = (over: Record<string, unknown>) => ({
      id: "chk_1",
      status: "completed",
      amount: 10000,
      description: null,
      created_at: "2026-07-01 12:00:00",
      expires_at: "2026-07-01 12:20:00",
      is_live: 1,
      processing_at: null,
      approved_at: null,
      metadata: null,
      product_name: null,
      rejection_reasons: [],
      ...over,
    });
    const { client } = makeClient([
      {
        status: 200,
        json: {
          checkouts: [
            item({ id: "chk_dpx", payment_method: "depix", depix_discount_pct: 10, depix_due_cents: 8999 }),
            // A DePix sale with no discount configured still reports a due value.
            item({ id: "chk_dpx0", payment_method: "depix", depix_discount_pct: 0, depix_due_cents: 9998 }),
            item({ id: "chk_pix", payment_method: "pix" }),
          ],
          stats: { total: 3, pending: 0, completed: 3, completed_amount: 30000 },
          limit: 50,
          offset: 0,
        },
      },
    ]);
    const out = await listCheckouts(client, { limit: 50, offset: 0 });

    // The face price and the paid amount are BOTH visible and they differ —
    // this is the assertion an agent's reconciliation depends on.
    expect(out.checkouts[0].amount).toBe(10000);
    expect(out.checkouts[0].depix_due_cents).toBe(8999);
    expect(out.checkouts[0].depix_discount_pct).toBe(10);

    // Zero is a reported value, not an absent one: `if (x)` here would drop it
    // and make a no-discount DePix sale indistinguishable from a pix sale.
    expect(out.checkouts[1].depix_discount_pct).toBe(0);
    expect(out.checkouts[1].depix_due_cents).toBe(9998);

    // A pix sale has no such thing; inventing 0 would assert a discount that
    // does not exist on that rail.
    expect(out.checkouts[2]).not.toHaveProperty("depix_discount_pct");
    expect(out.checkouts[2]).not.toHaveProperty("depix_due_cents");

    expect(z.object(s.listCheckoutsOutput).safeParse(out).success).toBe(true);
  });

  // The API has carried the hold pair on list items since 0.31.0; this
  // allowlist dropped both for that whole stretch, so "which of my sales are
  // held, and when do they land" — the question the list exists to answer —
  // was unanswerable through this server. Null must survive normalization
  // (it answers "no hold decision recorded"); absent stays absent.
  it("carries the hold pair per item, null included, and omits it only when the API does", async () => {
    const item = (over: Record<string, unknown>) => ({
      id: "chk_1",
      status: "processing",
      amount: 5990,
      description: null,
      created_at: "2026-07-30 12:00:00",
      expires_at: "2026-07-30 12:20:00",
      is_live: 1,
      processing_at: "2026-07-30 12:03:00",
      approved_at: null,
      metadata: null,
      product_name: null,
      rejection_reasons: [],
      ...over,
    });
    const { client } = makeClient([
      {
        status: 200,
        json: {
          checkouts: [
            item({ id: "chk_held", delay_until: "2026-08-13T09:03:00-03:00", vault_hours: 336 }),
            item({ id: "chk_free", delay_until: null, vault_hours: 0 }),
            item({ id: "chk_norec", delay_until: null, vault_hours: null }),
            item({ id: "chk_old" }),
          ],
          stats: { total: 4, pending: 0, completed: 0, completed_amount: 0 },
          limit: 50,
          offset: 0,
        },
      },
    ]);
    const out = await listCheckouts(client, { limit: 50, offset: 0 });

    // Verbatim, offset and all — the provider's string is the contract.
    expect(out.checkouts[0].delay_until).toBe("2026-08-13T09:03:00-03:00");
    expect(out.checkouts[0].vault_hours).toBe(336);

    // "Looked at, not held" — a real answer, not an absence.
    expect(out.checkouts[1]).toHaveProperty("delay_until", null);
    expect(out.checkouts[1]).toHaveProperty("vault_hours", 0);

    // "No decision recorded" (sandbox, DePix rail) — null survives; a
    // value-based emit would erase exactly this distinction.
    expect(out.checkouts[2]).toHaveProperty("delay_until", null);
    expect(out.checkouts[2]).toHaveProperty("vault_hours", null);

    // Pre-0.31.0 deployment: keys absent upstream stay absent.
    expect(out.checkouts[3]).not.toHaveProperty("delay_until");
    expect(out.checkouts[3]).not.toHaveProperty("vault_hours");

    expect(z.object(s.listCheckoutsOutput).safeParse(out).success).toBe(true);
  });
});

describe("simulate_checkout_payment (spec §4.1)", () => {
  it("POSTs to simulate-payment and returns a success shape", async () => {
    const { client, requests } = makeClient([{ status: 200, json: { success: true } }]);
    const out = await simulateCheckoutPayment(client, { checkout_id: "chk_1" });
    expect(requests[0].url).toBe(`${BASE}/api/checkouts/chk_1/simulate-payment`);
    expect(out).toMatchObject({ success: true, checkout_id: "chk_1" });
    expect(z.object(s.simulateCheckoutOutput).safeParse(out).success).toBe(true);
  });
});
