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
