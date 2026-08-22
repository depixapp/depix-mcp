// Checkout tools: create / get / list / simulate (spec §4.1). Amounts use the
// wire field `amount`; the serialization boundary handles the amount_cents alias.

import { randomUUID } from "node:crypto";
import type { ApiClient } from "../apiClient.js";
import { buildCreateCheckoutBody, type CreateCheckoutArgs } from "../requestMap.js";
import { deriveHasMore, normalizeIsLive, parseMetadata, unwrap } from "../normalize.js";
import { PAYMENT_METHODS, TERMINAL_CHECKOUT_STATUSES } from "../schemas.js";
import { arr, numOrNull, rec, str, strOrNull, stringArray } from "./access.js";

export interface CheckoutStatusSnapshot {
  status: string;
  is_live: boolean;
}

/**
 * The settlement rail, or null when the API reports none / one we do not know.
 * Dropping an unrecognized rail is deliberate: the field is advertised as a
 * closed enum, and emitting a value outside it would fail the tool's own output
 * validation and turn a perfectly readable checkout into a protocol error.
 */
function normalizePaymentMethod(value: unknown): string | null {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value)
    ? value
    : null;
}

/**
 * The `depix` payment instructions, or null when this checkout has none (the
 * pix rail, or a depix checkout past the payable window). The address is the
 * discriminator: without a destination there is nothing to pay, and emitting a
 * half-filled object would advertise a payable charge that is not payable.
 */
function normalizeDepixPayment(value: unknown): Record<string, unknown> | null {
  const d = rec(value);
  const address = strOrNull(d.address);
  if (address === null) return null;
  return {
    address,
    amount_cents: numOrNull(d.amount_cents) ?? 0,
    amount: str(d.amount),
    asset_id: str(d.asset_id),
    // Null in sandbox — there is no payable destination to build a URI from.
    uri: strOrNull(d.uri),
    discount_pct: numOrNull(d.discount_pct) ?? 0,
    original_amount_cents: numOrNull(d.original_amount_cents) ?? 0,
    detected: d.detected === true,
  };
}

/** Normalized full checkout detail (curate + strip). */
function normalizeCheckoutDetail(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
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
  // Rail-specific keys are emitted only when the API actually reported them:
  // both are absent on API versions older than 0.20.0, and `depix` is absent on
  // every pix checkout.
  const rail = normalizePaymentMethod(raw.payment_method);
  if (rail !== null) out.payment_method = rail;
  const depix = normalizeDepixPayment(raw.depix);
  if (depix !== null) out.depix = depix;
  // The hold pair (OpenAPI 0.39.0 here, 0.31.0 on the list). Emitted by KEY
  // PRESENCE, not by value, unlike the rail above: null is an answer the agent
  // needs ("no hold decision recorded" — sandbox, DePix rail), a different
  // fact from vault_hours 0 ("looked at, not held"). A value-based emit would
  // erase exactly that distinction; an older API simply omits the keys.
  if ("delay_until" in raw) out.delay_until = strOrNull(raw.delay_until);
  if ("vault_hours" in raw) out.vault_hours = numOrNull(raw.vault_hours);
  return out;
}

function normalizeCheckoutListItem(raw: Record<string, unknown>) {
  const out: Record<string, unknown> = {
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
  // Same emit-only-when-reported rule as the single-checkout read. Without the
  // field the two rails are indistinguishable in a listing: an agent
  // reconciling sales cannot tell a Pix settlement from a wallet-to-wallet one.
  const rail = normalizePaymentMethod(raw.payment_method);
  if (rail !== null) out.payment_method = rail;
  // The rail alone is not enough to reconcile it. `amount` is the FACE price;
  // on the DePix rail the payer sends `depix_due_cents` — the discounted,
  // cent-jittered value that attribution matches exactly — so an agent summing
  // `amount` over discounted sales overstates every one of them by the
  // discount. Emitted only when the API reports them, same rule as the rail:
  // an older deployment simply omits the keys instead of reporting a zero
  // discount it never made.
  const duePct = numOrNull(raw.depix_discount_pct);
  if (duePct !== null) out.depix_discount_pct = duePct;
  const dueCents = numOrNull(raw.depix_due_cents);
  if (dueCents !== null) out.depix_due_cents = dueCents;
  // The hold pair — the API has carried it on list items since 0.31.0 and this
  // allowlist silently dropped both, so a held sale was indistinguishable from
  // one settling in seconds (same `processing`, no date). Key-presence emit,
  // not value-based: null is the "no hold decision recorded" answer and must
  // reach the agent — see normalizeCheckoutDetail.
  if ("delay_until" in raw) out.delay_until = strOrNull(raw.delay_until);
  if ("vault_hours" in raw) out.vault_hours = numOrNull(raw.vault_hours);
  return out;
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
  const out: Record<string, unknown> = {
    id: str(d.id),
    status: str(d.status),
    amount: numOrNull(d.amount) ?? 0,
    description: strOrNull(d.description),
    image_url: strOrNull(d.image_url),
    expires_at: strOrNull(d.expires_at),
    is_live: normalizeIsLive(d),
    payment_url: str(d.payment_url),
  };
  const rail = normalizePaymentMethod(d.payment_method);
  if (rail !== null) out.payment_method = rail;
  // Exactly one rail answers, so each payload is emitted only when it exists.
  // Unconditionally building `pix` would hand a depix checkout an empty
  // qr_code:"" — an integrator would render a blank "Pix QR" for a charge that
  // has no Pix leg at all, instead of reading the `depix` instructions.
  const pixQrCode = strOrNull(rec(d.pix).qr_code);
  if (pixQrCode !== null) out.pix = { qr_code: pixQrCode };
  const depix = normalizeDepixPayment(d.depix);
  if (depix !== null) out.depix = depix;
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
