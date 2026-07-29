import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiClient } from "../src/apiClient.js";
import {
  activateProduct,
  createProduct,
  getProduct,
  listProductCheckouts,
  listProducts,
  setFeaturedProducts,
  updateProduct,
} from "../src/tools/products.js";
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

describe("create_product (spec §4.3)", () => {
  it("POSTs amount, unwraps { product }, normalizes flags", async () => {
    const { client, requests } = makeClient([
      {
        status: 201,
        json: {
          product: {
            id: "prd_1",
            slug: "ebook",
            name: "Ebook",
            amount: 700,
            description: null,
            image_url: null,
            callback_url: null,
            redirect_url: null,
            metadata: null,
            expires_in: 1200,
            active: true,
            is_live: true,
            payment_url: "https://pay.depixapp.com/loja/ebook",
            created_at: "2026-07-01T12:00:00.000Z",
          },
        },
      },
    ]);
    const out = await createProduct(client, { name: "Ebook", amount_cents: 700 });
    const body = JSON.parse(requests[0].body!);
    expect(body.amount).toBe(700);
    expect(body).not.toHaveProperty("amount_cents");
    expect(out.product.is_live).toBe(true);
    expect(z.object(s.createProductOutput).safeParse(out).success).toBe(true);
  });
});

describe("list_products has_more via limit+1 over-fetch (spec §4.3)", () => {
  it("over-fetches, trims, and reports has_more true", async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      id: `prd_${i}`,
      slug: `p${i}`,
      name: `P${i}`,
      amount: 700,
      description: null,
      image_url: null,
      active: 1,
      is_live: 1,
      expires_in: 1200,
      created_at: "2026-07-01 12:00:00",
      position: null,
      total_checkouts: 0,
      completed_checkouts: 0,
      completed_amount: 0,
    }));
    const { client, requests } = makeClient([
      { status: 200, json: { products: items, limit: 3, offset: 0 } },
    ]);
    const out = await listProducts(client, { limit: 2, offset: 0 });
    expect(requests[0].url).toContain("limit=3"); // requested limit+1
    expect(out.products.length).toBe(2); // trimmed to announced limit
    expect(out.limit).toBe(2);
    expect(out.has_more).toBe(true);
    expect(out.products[0].is_live).toBe(true);
    expect(out.products[0].active).toBe(true);
    expect(z.object(s.listProductsOutput).safeParse(out).success).toBe(true);
  });

  it("no over-fetch remainder → has_more false", async () => {
    const { client } = makeClient([{ status: 200, json: { products: [], limit: 51, offset: 0 } }]);
    const out = await listProducts(client, { limit: 50, offset: 0 });
    expect(out.has_more).toBe(false);
  });

  it("input schema caps limit at 99 so limit+1 always fits the API's 100 cap", () => {
    expect(s.listProductsInput.limit.safeParse(99).success).toBe(true);
    expect(s.listProductsInput.limit.safeParse(100).success).toBe(false);
  });

  it("over-fetches even at the max limit (99 → wire 100)", async () => {
    const { client, requests } = makeClient([
      { status: 200, json: { products: [], limit: 100, offset: 0 } },
    ]);
    await listProducts(client, { limit: 99, offset: 0 });
    expect(requests[0].url).toContain("limit=100");
  });
});

describe("get_product open-world passthrough (spec §4.3)", () => {
  it("forwards unknown columns and normalizes known flags", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          product: {
            id: "prd_1",
            merchant_id: "mrc_1",
            slug: "ebook",
            name: "Ebook",
            amount: 700,
            metadata: '{"k":"v"}',
            active: 1,
            is_live: 0,
            future_column: "surprise",
          },
          stats: { total: 3, completed: 2, pending: 1, completed_amount: 1400 },
        },
      },
    ]);
    const out = await getProduct(client, { product_id: "prd_1" });
    expect(out.product.is_live).toBe(false);
    expect(out.product.active).toBe(true);
    expect(out.product.metadata).toEqual({ k: "v" });
    expect((out.product as Record<string, unknown>).future_column).toBe("surprise");
    expect(z.object(s.getProductOutput).safeParse(out).success).toBe(true);
  });
});

describe("update / activate return { success, product_id } (spec §4.3)", () => {
  it("update_product PATCHes and maps amount_cents", async () => {
    const { client, requests } = makeClient([{ status: 200, json: { success: true } }]);
    const out = await updateProduct(client, { product_id: "prd_1", amount_cents: 900 });
    expect(requests[0].method).toBe("PATCH");
    const body = JSON.parse(requests[0].body!);
    expect(body.amount).toBe(900);
    expect(out).toEqual({ success: true, product_id: "prd_1" });
    expect(z.object(s.productActionOutput).safeParse(out).success).toBe(true);
  });

  it("activate_product POSTs the action", async () => {
    const { client, requests } = makeClient([{ status: 200, json: { success: true } }]);
    const out = await activateProduct(client, { product_id: "prd_1" });
    expect(requests[0].url).toBe(`${BASE}/api/products/prd_1/activate`);
    expect(out).toEqual({ success: true, product_id: "prd_1" });
  });
});

describe("set_featured_products maps product_ids → productIds (spec §4.3)", () => {
  it("sends productIds on the wire", async () => {
    const { client, requests } = makeClient([
      { status: 200, json: { success: true, featured: ["prd_1", "prd_2"] } },
    ]);
    const out = await setFeaturedProducts(client, { product_ids: ["prd_1", "prd_2"] });
    const body = JSON.parse(requests[0].body!);
    expect(body).toEqual({ productIds: ["prd_1", "prd_2"] });
    expect(out).toEqual({ success: true, featured: ["prd_1", "prd_2"] });
    expect(z.object(s.setFeaturedOutput).safeParse(out).success).toBe(true);
  });
});

describe("list_product_checkouts has_more via stats.total (spec §4.3)", () => {
  it("derives has_more exactly", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          checkouts: [
            {
              id: "chk_1",
              status: "completed",
              amount: 700,
              description: "Ebook",
              created_at: "2026-07-01 12:00:00",
              expires_at: "2026-07-01 12:20:00",
              processing_at: "2026-07-01 12:01:00",
              completed_at: "2026-07-01 12:02:00",
            },
          ],
          stats: { total: 1, completed: 1, completed_amount: 700 },
          limit: 50,
          offset: 0,
        },
      },
    ]);
    const out = await listProductCheckouts(client, { product_id: "prd_1", limit: 50, offset: 0 });
    expect(out.has_more).toBe(false);
    expect(z.object(s.listProductCheckoutsOutput).safeParse(out).success).toBe(true);
  });
});

// ── Charges (kind='charge') ────────────────────────────────────────────────
// A charge is a product with a due date and late fees. The backend models it as
// the SAME resource with a discriminator, so these tools must carry it — an
// agent that can create one but never see it again is worse than one that
// cannot create it at all.

describe("charges — create_product with kind='charge'", () => {
  it("forwards every charge field on the wire", async () => {
    const { client, requests } = makeClient([
      {
        status: 201,
        json: {
          product: {
            id: "prd_chg1", slug: "aluguel-apto-12", name: "Aluguel Apto 12",
            amount: 250000, description: null, image_url: null,
            callback_url: null, redirect_url: null, metadata: null,
            expires_in: 1200, active: true, is_live: true,
            kind: "charge", due_date: "2026-08-05", recurrence: "monthly",
            late_fine_bps: 200, late_interest_monthly_bps: 100,
            payment_url: "https://pay.depixapp.com/c/prd_chg1",
            created_at: "2026-07-29T12:00:00.000Z",
          },
        },
      },
    ]);

    const out = await createProduct(client, {
      name: "Aluguel Apto 12",
      amount: 250000,
      kind: "charge",
      due_date: "2026-08-05",
      recurrence: "monthly",
      late_fine_bps: 200,
      late_interest_monthly_bps: 100,
    });

    const body = JSON.parse(requests[0].body!);
    expect(body).toMatchObject({
      kind: "charge",
      due_date: "2026-08-05",
      recurrence: "monthly",
      late_fine_bps: 200,
      late_interest_monthly_bps: 100,
    });
    // The response must carry them back — the normalizer is curate-and-strip,
    // so an agent that cannot read due_date cannot confirm what it created.
    expect(out.product).toMatchObject({
      kind: "charge",
      due_date: "2026-08-05",
      recurrence: "monthly",
      late_fine_bps: 200,
      late_interest_monthly_bps: 100,
      payment_url: "https://pay.depixapp.com/c/prd_chg1",
    });
  });

  it("omits kind entirely for a plain product — the product body stays byte-identical", async () => {
    const { client, requests } = makeClient([
      { status: 201, json: { product: { id: "prd_1", slug: "ebook", name: "Ebook", amount: 700, expires_in: 1200, active: true, is_live: true, payment_url: "u", created_at: "t" } } },
    ]);
    await createProduct(client, { name: "Ebook", amount: 700 });
    const body = JSON.parse(requests[0].body!);
    expect(body).not.toHaveProperty("kind");
    expect(body).not.toHaveProperty("due_date");
  });

  it("refuses a charge without a due date before spending a request", async () => {
    const { client, requests } = makeClient([]);
    await expect(
      createProduct(client, { name: "Aluguel", amount: 250000, kind: "charge" }),
    ).rejects.toThrow(/due_date/i);
    expect(requests).toHaveLength(0);
  });
});

describe("charges — list_products", () => {
  it("forwards kind so charges are reachable at all", async () => {
    // The API defaults kind='product' precisely so pre-charges integrations
    // keep their old result set. Without this parameter list_products can
    // NEVER return a charge, and an agent concludes the one it just created
    // does not exist.
    const { client, requests } = makeClient([{ status: 200, json: { products: [], limit: 50, offset: 0 } }]);
    await listProducts(client, { kind: "charge", limit: 50, offset: 0 });
    expect(requests[0].url).toContain("kind=charge");
  });

  it("does not send kind when the caller did not ask — default stays the API's", async () => {
    const { client, requests } = makeClient([{ status: 200, json: { products: [], limit: 50, offset: 0 } }]);
    await listProducts(client, { limit: 50, offset: 0 });
    expect(requests[0].url).not.toContain("kind=");
  });

  it("carries charge_state and the /c/ payment_url through the normalizer", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          products: [
            {
              id: "prd_chg1", slug: "aluguel", name: "Aluguel Apto 12", amount: 250000,
              description: null, image_url: null, active: 1, is_live: 1, expires_in: 1200,
              created_at: "2026-07-29 12:00:00", position: null,
              kind: "charge", due_date: "2026-08-05", recurrence: "monthly",
              late_fine_bps: 200, late_interest_monthly_bps: 100,
              total_checkouts: 3, completed_checkouts: 1, completed_amount: 250000,
              settled_count: 1, processing_count: 0,
              payment_url: "https://pay.depixapp.com/c/prd_chg1",
              charge_state: {
                settled: false, cycle_due_date: "2026-09-05", days_late: 0,
                base_cents: 250000, fine_cents: 0, interest_cents: 0,
                total_today_cents: 250000, capped: false, status: "upcoming",
                open_past_due_cycles: 0, in_flight: false,
              },
            },
          ],
          limit: 50, offset: 0,
        },
      },
    ]);

    const out = await listProducts(client, { kind: "charge", limit: 50, offset: 0 });
    const row = out.products[0] as Record<string, unknown>;
    expect(row.kind).toBe("charge");
    expect(row.due_date).toBe("2026-08-05");
    expect(row.payment_url).toBe("https://pay.depixapp.com/c/prd_chg1");
    // charge_state is the whole point of listing charges: without it the agent
    // cannot tell an overdue rent from one that is not due yet.
    expect(row.charge_state).toMatchObject({ cycle_due_date: "2026-09-05", status: "upcoming" });
  });
});

describe("charges — update_product", () => {
  it("forwards the four mutable charge fields", async () => {
    const { client, requests } = makeClient([{ status: 200, json: { success: true } }]);
    await updateProduct(client, {
      product_id: "prd_chg1",
      due_date: "2026-09-10",
      recurrence: null,
      late_fine_bps: 1000,
      late_interest_monthly_bps: 0,
    });
    const body = JSON.parse(requests[0].body!);
    expect(body).toMatchObject({
      due_date: "2026-09-10",
      recurrence: null,
      late_fine_bps: 1000,
      late_interest_monthly_bps: 0,
    });
  });

  it("a charge-only edit counts as a field — it must not trip the empty-body guard", async () => {
    // buildUpdateProductBody throws locally when the body is empty. Before the
    // charge fields were forwarded, editing ONLY the due date produced an empty
    // body and never reached the API.
    const { client, requests } = makeClient([{ status: 200, json: { success: true } }]);
    await updateProduct(client, { product_id: "prd_chg1", due_date: "2026-09-10" });
    expect(requests).toHaveLength(1);
  });
});
