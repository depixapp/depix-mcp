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
import { createCheckoutInputSchema, type PaymentMethod } from "./schemas.js";

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
  payment_method?: PaymentMethod;
  payer_tax_number?: string;
  expected_discount_pct?: number;
  image_url?: string;
  callback_url?: string;
  redirect_url?: string;
  metadata?: Record<string, unknown>;
  expires_in?: number;
  idempotency_key?: string;
}

/**
 * Enforce the rail-conditional rules (schemas.ts) here rather than at
 * registerTool, so a violation reaches the agent as a typed `validation_error`
 * result instead of a protocol-level InvalidParams. Re-parsing what the SDK
 * already checked per-field is cheap and keeps this function correct for direct
 * callers too.
 */
function assertRailRules(args: CreateCheckoutArgs): void {
  const parsed = createCheckoutInputSchema.safeParse(args);
  if (parsed.success) return;
  const issue = parsed.error.issues[0];
  const field = issue.path.length > 0 ? String(issue.path[0]) : undefined;
  throw new ToolError(issue.message, "validation_error", {
    data: field !== undefined ? { details: { field } } : {},
  });
}

/** Build the POST /api/checkouts wire body (amount_cents → amount). */
export function buildCreateCheckoutBody(args: CreateCheckoutArgs): Record<string, unknown> {
  const amount = resolveAmount(args);
  if (amount === undefined) {
    throw new ToolError("Provide `amount` (BRL cents).", "validation_error", {
      data: { details: { field: "amount" } },
    });
  }
  assertRailRules(args);

  const body: Record<string, unknown> = { amount };
  put(body, "payment_method", args.payment_method);
  // The depix rail carries NO payer identity (spec §4, decision 9): the field is
  // not just optional there, it is dropped — a payer document has no purpose
  // on a wallet-to-wallet transfer, and sending PII the API ignores is worse
  // than sending nothing.
  if (args.payment_method !== "depix") put(body, "payer_tax_number", args.payer_tax_number);
  put(body, "expected_discount_pct", args.expected_discount_pct);
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
  // Charge fields. A charge is the SAME resource with a discriminator — the
  // backend models it that way, so the tool does too (see schemas.ts).
  kind?: "product" | "charge";
  due_date?: string;
  recurrence?: string | null;
  late_fine_bps?: number;
  late_interest_monthly_bps?: number;
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
  // `kind` is omitted when absent so a plain-product body stays byte-identical
  // to what it was before charges existed.
  put(body, "kind", args.kind);

  // A charge field without the discriminator is a mistake with a nasty shape:
  // dropping it would create a PLAIN product, which lands on the merchant's
  // PUBLIC storefront — the exact leak charges exist to avoid — silently, with
  // a 201, and a model asked to "bill the tenant on the 5th" is very likely to
  // send due_date and forget kind. The API answers 400 for the same body; say
  // so here, before the request, instead of quietly building something else.
  const CHARGE_ONLY: (keyof CreateProductArgs)[] = [
    "due_date",
    "recurrence",
    "late_fine_bps",
    "late_interest_monthly_bps",
  ];
  const strayCharge = CHARGE_ONLY.filter((f) => args[f] !== undefined);
  if (args.kind !== "charge" && strayCharge.length > 0) {
    throw new ToolError(
      `${strayCharge.join(", ")} ${strayCharge.length > 1 ? "are" : "is"} only accepted with kind="charge". ` +
        `Pass kind="charge" to create a dated payment link, or drop the field to create a catalog product.`,
      "validation_error",
      { data: { details: { field: "kind" } } },
    );
  }

  if (args.kind === "charge") {
    // Caught here, not by zod: the field is only required for one value of a
    // sibling field, and a conditional zod refine on a tool input degrades the
    // JSON Schema every MCP host reads. Failing locally also saves the agent a
    // round trip to learn something we already know.
    if (!args.due_date) {
      throw new ToolError(
        "A charge needs `due_date` (YYYY-MM-DD) — the first due date, which anchors the recurrence.",
        "validation_error",
        { data: { details: { field: "due_date" } } },
      );
    }
    put(body, "due_date", args.due_date);
    if (args.recurrence !== undefined) body.recurrence = args.recurrence;
    put(body, "late_fine_bps", args.late_fine_bps);
    put(body, "late_interest_monthly_bps", args.late_interest_monthly_bps);
  }
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
  // Charge fields that may change after creation. `kind` is deliberately NOT
  // here: the API rejects it with 400 "kind é imutável", so accepting it would
  // only manufacture a guaranteed error.
  due_date?: string;
  recurrence?: string | null;
  late_fine_bps?: number;
  late_interest_monthly_bps?: number;
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
  // Charge fields count as fields: before they were forwarded, an edit that
  // touched ONLY the due date produced an empty body and died locally without
  // ever reaching the API.
  put(body, "due_date", args.due_date);
  if (args.recurrence !== undefined) body.recurrence = args.recurrence;
  put(body, "late_fine_bps", args.late_fine_bps);
  put(body, "late_interest_monthly_bps", args.late_interest_monthly_bps);
  if (Object.keys(body).length === 0) {
    throw new ToolError(
      "Provide at least one field to update (name/description/amount/due_date/late fees/…).",
      "validation_error",
    );
  }
  return body;
}

/** Build the POST /api/products/featured wire body (product_ids → productIds). */
export function buildSetFeaturedBody(args: { product_ids: string[] }): Record<string, unknown> {
  return { productIds: args.product_ids };
}

// ── Support tickets ──
// No field renames here (subject/category/body are snake_case on both sides),
// but the body is still constructed explicitly so unrelated tool args (e.g. the
// `id` path param on a reply) never leak onto the wire.

export interface OpenTicketArgs {
  subject: string;
  category?: string;
  body: string;
}

/** Build the POST /api/tickets wire body (category omitted when absent). */
export function buildOpenTicketBody(args: OpenTicketArgs): Record<string, unknown> {
  const body: Record<string, unknown> = { subject: args.subject, body: args.body };
  put(body, "category", args.category);
  return body;
}

export interface ReplyTicketArgs {
  id: string;
  body: string;
}

/** Build the POST /api/tickets/:id/messages wire body ({ body } only — `id` is a path param). */
export function buildReplyTicketBody(args: ReplyTicketArgs): Record<string, unknown> {
  return { body: args.body };
}

export interface AttachTicketArgs {
  id: string;
  filename: string;
  content_type: string;
  file_b64: string;
  caption?: string;
}

/** Build the POST /api/tickets/:id/attachments wire body (`id` is a path param, never sent). */
export function buildAttachTicketBody(args: AttachTicketArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    filename: args.filename,
    content_type: args.content_type,
    file_b64: args.file_b64,
  };
  put(body, "caption", args.caption);
  return body;
}
