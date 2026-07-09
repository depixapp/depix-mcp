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
