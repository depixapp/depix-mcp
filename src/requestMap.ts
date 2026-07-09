// Serialization boundary (spec §4.0). The snake_case tool surface is
// deliberately DECOUPLED from the mixed camelCase/snake_case API wire via an
// explicit per-endpoint map — never pass-through. This is the single source of
// truth for wire field names, and the contract test diffs these bodies against
// the OpenAPI 0.6.0 request schemas so a rename (amount_cents↔amount,
// product_ids↔productIds) fails CI before it 400s in production.
//
// Money field name is NOT uniform (spec §4.0): checkout + product requests use
// `amount`; only the deposit/withdrawal STATUS reads use `amount_cents`. The
// tool accepts `amount_cents` as an input alias and this map renames it to the
// wire `amount`.

import { ToolError } from "./errors.js";

/** Resolve the money value from either `amount` or the `amount_cents` alias. */
function resolveAmount(args: { amount?: number; amount_cents?: number }): number | undefined {
  if (args.amount !== undefined) return args.amount;
  if (args.amount_cents !== undefined) return args.amount_cents;
  return undefined;
}

function put(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) body[key] = value;
}

export interface CreateCheckoutArgs {
  amount?: number;
  amount_cents?: number;
  description?: string;
  payer_tax_number: string;
  image_url?: string;
  callback_url?: string;
  redirect_url?: string;
  metadata?: Record<string, unknown>;
  expires_in?: number;
  idempotency_key?: string;
}

/** Build the POST /api/checkouts wire body (amount_cents → amount). */
export function buildCreateCheckoutBody(args: CreateCheckoutArgs): Record<string, unknown> {
  const amount = resolveAmount(args);
  if (amount === undefined) {
    throw new ToolError("Provide `amount` (BRL cents).", "validation_error", {
      data: { details: { field: "amount" } },
    });
  }
  const body: Record<string, unknown> = { amount, payer_tax_number: args.payer_tax_number };
  put(body, "description", args.description);
  put(body, "image_url", args.image_url);
  put(body, "callback_url", args.callback_url);
  put(body, "redirect_url", args.redirect_url);
  put(body, "metadata", args.metadata);
  put(body, "expires_in", args.expires_in);
  // idempotency_key is a HEADER, never a body field.
  return body;
}

export interface CreateProductArgs {
  name: string;
  amount?: number;
  amount_cents?: number;
  slug?: string;
  description?: string;
  image_url?: string;
  callback_url?: string;
  redirect_url?: string;
  metadata?: Record<string, unknown>;
  expires_in?: number;
}

/** Build the POST /api/products wire body (amount_cents → amount). */
export function buildCreateProductBody(args: CreateProductArgs): Record<string, unknown> {
  const amount = resolveAmount(args);
  if (amount === undefined) {
    throw new ToolError("Provide `amount` (BRL cents).", "validation_error", {
      data: { details: { field: "amount" } },
    });
  }
  const body: Record<string, unknown> = { name: args.name, amount };
  put(body, "slug", args.slug);
  put(body, "description", args.description);
  put(body, "image_url", args.image_url);
  put(body, "callback_url", args.callback_url);
  put(body, "redirect_url", args.redirect_url);
  put(body, "metadata", args.metadata);
  put(body, "expires_in", args.expires_in);
  return body;
}

export interface UpdateProductArgs {
  product_id: string;
  name?: string;
  slug?: string;
  amount?: number;
  amount_cents?: number;
  description?: string | null;
  image_url?: string | null;
  callback_url?: string | null;
  redirect_url?: string | null;
  metadata?: Record<string, unknown> | null;
  expires_in?: number;
}

/** Build the PATCH /api/products/:id wire body (amount_cents → amount). */
export function buildUpdateProductBody(args: UpdateProductArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  put(body, "name", args.name);
  put(body, "slug", args.slug);
  const amount = resolveAmount(args);
  put(body, "amount", amount);
  // Nullable fields: forward null explicitly to clear them.
  if (args.description !== undefined) body.description = args.description;
  if (args.image_url !== undefined) body.image_url = args.image_url;
  if (args.callback_url !== undefined) body.callback_url = args.callback_url;
  if (args.redirect_url !== undefined) body.redirect_url = args.redirect_url;
  if (args.metadata !== undefined) body.metadata = args.metadata;
  put(body, "expires_in", args.expires_in);
  if (Object.keys(body).length === 0) {
    throw new ToolError(
      "Provide at least one field to update (name/description/amount/image_url/metadata/…).",
      "validation_error",
    );
  }
  return body;
}

/** Build the POST /api/products/featured wire body (product_ids → productIds). */
export function buildSetFeaturedBody(args: { product_ids: string[] }): Record<string, unknown> {
  return { productIds: args.product_ids };
}
