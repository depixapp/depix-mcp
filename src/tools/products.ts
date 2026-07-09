// Product tools (spec §4.3). CRUD + featured + activate/deactivate +
// list_checkouts. Amounts use the wire field `amount` (serialization boundary).

import type { ApiClient } from "../apiClient.js";
import {
  buildCreateProductBody,
  buildSetFeaturedBody,
  buildUpdateProductBody,
  type CreateProductArgs,
  type UpdateProductArgs,
} from "../requestMap.js";
import { deriveHasMore, normalizeBool, normalizeIsLive, parseMetadata, unwrap } from "../normalize.js";
import { arr, numOrNull, rec, str, strOrNull, stringArray } from "./access.js";

function normalizeCreatedProduct(raw: Record<string, unknown>) {
  return {
    id: str(raw.id),
    slug: str(raw.slug),
    name: strOrNull(raw.name),
    amount: numOrNull(raw.amount) ?? 0,
    description: strOrNull(raw.description),
    image_url: strOrNull(raw.image_url),
    callback_url: strOrNull(raw.callback_url),
    redirect_url: strOrNull(raw.redirect_url),
    metadata: parseMetadata(raw.metadata),
    expires_in: numOrNull(raw.expires_in) ?? 0,
    active: normalizeBool(raw.active),
    is_live: normalizeIsLive(raw),
    payment_url: str(raw.payment_url),
    created_at: str(raw.created_at),
  };
}

function normalizeProductListItem(raw: Record<string, unknown>) {
  return {
    id: str(raw.id),
    slug: str(raw.slug),
    name: strOrNull(raw.name),
    amount: numOrNull(raw.amount) ?? 0,
    description: strOrNull(raw.description),
    image_url: strOrNull(raw.image_url),
    active: normalizeBool(raw.active),
    is_live: normalizeIsLive(raw),
    expires_in: numOrNull(raw.expires_in) ?? 0,
    created_at: strOrNull(raw.created_at),
    position: numOrNull(raw.position),
    total_checkouts: numOrNull(raw.total_checkouts) ?? 0,
    completed_checkouts: numOrNull(raw.completed_checkouts) ?? 0,
    completed_amount: numOrNull(raw.completed_amount) ?? 0,
  };
}

export async function createProduct(client: ApiClient, args: CreateProductArgs) {
  const body = buildCreateProductBody(args);
  const { data } = await client.request({
    method: "POST",
    path: "/api/products",
    body,
    tool: "create_product",
  });
  return { product: normalizeCreatedProduct(rec(unwrap(data, "product"))) };
}

export async function listProducts(
  client: ApiClient,
  args: { active?: boolean; q?: string; limit: number; offset: number },
) {
  // Exact has_more via limit+1 over-fetch (spec §4.3). The tool's input schema
  // caps limit at 99, so limit+1 always fits the API's 100 cap and has_more is
  // exact on every page (no length heuristic).
  const { data } = await client.request({
    method: "GET",
    path: "/api/products",
    query: {
      active: args.active === undefined ? undefined : args.active,
      q: args.q,
      limit: args.limit + 1,
      offset: args.offset,
    },
    tool: "list_products",
  });
  const d = rec(data);
  let items = arr(d.products).map((p) => normalizeProductListItem(rec(p)));
  const hasMore = items.length > args.limit;
  if (hasMore) items = items.slice(0, args.limit);
  return {
    products: items,
    limit: args.limit,
    offset: numOrNull(d.offset) ?? args.offset,
    has_more: hasMore,
  };
}

export async function getProduct(client: ApiClient, args: { product_id: string }) {
  const { data } = await client.request({
    method: "GET",
    path: `/api/products/${encodeURIComponent(args.product_id)}`,
    tool: "get_product",
  });
  const d = rec(data);
  const rawProduct = rec(d.product);
  // Open-world: forward every column, only normalizing the known flags/metadata.
  const product: Record<string, unknown> = {
    ...rawProduct,
    is_live: normalizeIsLive(rawProduct),
    active: normalizeBool(rawProduct.active),
    metadata: parseMetadata(rawProduct.metadata),
  };
  return { product, stats: rec(d.stats) };
}

export async function updateProduct(client: ApiClient, args: UpdateProductArgs) {
  const body = buildUpdateProductBody(args);
  await client.request({
    method: "PATCH",
    path: `/api/products/${encodeURIComponent(args.product_id)}`,
    body,
    tool: "update_product",
  });
  return { success: true as const, product_id: args.product_id };
}

export async function activateProduct(client: ApiClient, args: { product_id: string }) {
  await client.request({
    method: "POST",
    path: `/api/products/${encodeURIComponent(args.product_id)}/activate`,
    tool: "activate_product",
  });
  return { success: true as const, product_id: args.product_id };
}

export async function deactivateProduct(client: ApiClient, args: { product_id: string }) {
  await client.request({
    method: "POST",
    path: `/api/products/${encodeURIComponent(args.product_id)}/deactivate`,
    tool: "deactivate_product",
  });
  return { success: true as const, product_id: args.product_id };
}

export async function setFeaturedProducts(client: ApiClient, args: { product_ids: string[] }) {
  const body = buildSetFeaturedBody(args);
  const { data } = await client.request({
    method: "POST",
    path: "/api/products/featured",
    body,
    tool: "set_featured_products",
  });
  const d = rec(data);
  return { success: true as const, featured: stringArray(d.featured) };
}

export async function listProductCheckouts(
  client: ApiClient,
  args: { product_id: string; status?: string; limit: number; offset: number },
) {
  const { data } = await client.request({
    method: "GET",
    path: `/api/products/${encodeURIComponent(args.product_id)}/checkouts`,
    query: { status: args.status, limit: args.limit, offset: args.offset },
    tool: "list_product_checkouts",
  });
  const d = rec(data);
  const checkouts = arr(d.checkouts).map((c) => {
    const raw = rec(c);
    return {
      id: str(raw.id),
      status: str(raw.status),
      amount: numOrNull(raw.amount) ?? 0,
      description: strOrNull(raw.description),
      created_at: strOrNull(raw.created_at),
      expires_at: strOrNull(raw.expires_at),
      processing_at: strOrNull(raw.processing_at),
      completed_at: strOrNull(raw.completed_at),
    };
  });
  const stats = rec(d.stats);
  const total = numOrNull(stats.total) ?? 0;
  const limit = numOrNull(d.limit) ?? args.limit;
  const offset = numOrNull(d.offset) ?? args.offset;
  return { checkouts, stats, limit, offset, has_more: deriveHasMore(offset, checkouts.length, total) };
}
