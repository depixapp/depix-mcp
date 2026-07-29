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
