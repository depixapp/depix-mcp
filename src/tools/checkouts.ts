// Checkout tools: create / get / list / simulate (spec §4.1). Amounts use the
// wire field `amount`; the serialization boundary handles the amount_cents alias.

import { randomUUID } from "node:crypto";
import type { ApiClient } from "../apiClient.js";
import { buildCreateCheckoutBody, type CreateCheckoutArgs } from "../requestMap.js";
import { deriveHasMore, normalizeIsLive, parseMetadata, unwrap } from "../normalize.js";
import { TERMINAL_CHECKOUT_STATUSES } from "../schemas.js";
import { arr, numOrNull, rec, str, strOrNull, stringArray } from "./access.js";

export interface CheckoutStatusSnapshot {
  status: string;
  is_live: boolean;
}

/** Normalized full checkout detail (curate + strip). */
function normalizeCheckoutDetail(raw: Record<string, unknown>) {
  return {
    id: str(raw.id),
    status: str(raw.status),
    amount: numOrNull(raw.amount) ?? 0,
    description: strOrNull(raw.description),
    image_url: strOrNull(raw.image_url),
    pix_payload: strOrNull(raw.pix_payload),
    callback_url: strOrNull(raw.callback_url),
    redirect_url: strOrNull(raw.redirect_url),
    metadata: parseMetadata(raw.metadata),
    expires_at: strOrNull(raw.expires_at),
    is_live: normalizeIsLive(raw),
    created_at: strOrNull(raw.created_at),
    processing_at: strOrNull(raw.processing_at),
    approved_at: strOrNull(raw.approved_at),
    completed_at: strOrNull(raw.completed_at),
    cancelled_at: strOrNull(raw.cancelled_at),
    blockchain_tx_id: strOrNull(raw.blockchain_tx_id),
    rejection_reasons: stringArray(raw.rejection_reasons),
  };
}

function normalizeCheckoutListItem(raw: Record<string, unknown>) {
  return {
    id: str(raw.id),
    status: str(raw.status),
    amount: numOrNull(raw.amount) ?? 0,
    description: strOrNull(raw.description),
    created_at: strOrNull(raw.created_at),
    expires_at: strOrNull(raw.expires_at),
    is_live: normalizeIsLive(raw),
    processing_at: strOrNull(raw.processing_at),
    approved_at: strOrNull(raw.approved_at),
    metadata: parseMetadata(raw.metadata),
    product_name: strOrNull(raw.product_name),
    rejection_reasons: stringArray(raw.rejection_reasons),
  };
}

export async function createCheckout(client: ApiClient, args: CreateCheckoutArgs) {
  const body = buildCreateCheckoutBody(args);
  // Auto-generate an Idempotency-Key unless the caller passes one (spec §4.2);
  // this makes the client's transient auto-retry safe on this POST.
  const idempotencyKey = args.idempotency_key ?? randomUUID();
  const { data, replayed } = await client.request({
    method: "POST",
    path: "/api/checkouts",
    body,
    idempotencyKey,
    tool: "create_checkout",
  });
  const d = rec(data);
  const pix = rec(d.pix);
  const out: Record<string, unknown> = {
    id: str(d.id),
    status: str(d.status),
    amount: numOrNull(d.amount) ?? 0,
    description: strOrNull(d.description),
    image_url: strOrNull(d.image_url),
    expires_at: strOrNull(d.expires_at),
    is_live: normalizeIsLive(d),
    payment_url: str(d.payment_url),
    pix: { qr_code: str(pix.qr_code) },
  };
  if (replayed) out.replayed = true;
  return out;
}

export async function getCheckout(client: ApiClient, args: { checkout_id: string }) {
  const { data } = await client.request({
    method: "GET",
    path: `/api/checkouts/${encodeURIComponent(args.checkout_id)}`,
    tool: "get_checkout",
  });
  return normalizeCheckoutDetail(rec(unwrap(data, "checkout")));
}

export async function listCheckouts(
  client: ApiClient,
  args: {
    status?: string;
    product_id?: string;
    from?: string;
    to?: string;
    q?: string;
    limit: number;
    offset: number;
  },
) {
  const { data } = await client.request({
    method: "GET",
    path: "/api/checkouts",
    query: {
      status: args.status,
      product_id: args.product_id,
      from: args.from,
      to: args.to,
      q: args.q,
      limit: args.limit,
      offset: args.offset,
    },
    tool: "list_checkouts",
  });
  const d = rec(data);
  const checkouts = arr(d.checkouts).map((c) => normalizeCheckoutListItem(rec(c)));
  const stats = rec(d.stats);
  const total = numOrNull(stats.total) ?? 0;
  const limit = numOrNull(d.limit) ?? args.limit;
  const offset = numOrNull(d.offset) ?? args.offset;
  return {
    checkouts,
    stats,
    limit,
    offset,
    has_more: deriveHasMore(offset, checkouts.length, total),
  };
}

export async function simulateCheckoutPayment(client: ApiClient, args: { checkout_id: string }) {
  await client.request({
    method: "POST",
    path: `/api/checkouts/${encodeURIComponent(args.checkout_id)}/simulate-payment`,
    tool: "simulate_checkout_payment",
  });
  return {
    success: true as const,
    checkout_id: args.checkout_id,
    note: "Sandbox only — marks the checkout paid so you can observe checkout.completed.",
  };
}

/** Read a checkout's status + mode, for the wait loop (spec §5.2). */
export async function fetchCheckoutStatus(
  client: ApiClient,
  checkoutId: string,
  signal?: AbortSignal,
): Promise<CheckoutStatusSnapshot> {
  const { data } = await client.request({
    method: "GET",
    path: `/api/checkouts/${encodeURIComponent(checkoutId)}`,
    tool: "wait_for_checkout",
    signal,
  });
  const c = rec(unwrap(data, "checkout"));
  return { status: str(c.status), is_live: normalizeIsLive(c) };
}

export const TERMINAL_CHECKOUT_SET: readonly string[] = TERMINAL_CHECKOUT_STATUSES;
