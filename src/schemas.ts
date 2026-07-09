// Tool input/output schemas (zod raw shapes) and the canonical status enums /
// terminal sets. The enums are a VERSIONED COPY of the API's exported constants
// (delay-policy.js / checkout.js / sandbox.js, OpenAPI 0.6.0); the contract test
// (test/contract.test.ts) fails CI if they drift from the pinned OpenAPI
// fixture, so `terminal` and wait_for_checkout never guess (spec §4.8).

import { z } from "zod";

// ── Canonical status enums (OpenAPI 0.6.0) ──
export const CHECKOUT_STATUSES = [
  "pending",
  "processing",
  "approved",
  "completed",
  "expired",
  "cancelled",
] as const;
export const TERMINAL_CHECKOUT_STATUSES = ["completed", "expired", "cancelled"] as const;

export const DEPOSIT_STATUSES = [
  "pending",
  "under_review",
  "pending_pix2fa",
  "approved",
  "delayed",
  "will_refund",
  "depix_sent",
  "refunded",
  "canceled",
  "error",
  "expired",
] as const;
export const TERMINAL_DEPOSIT_STATUSES = [
  "depix_sent",
  "refunded",
  "canceled",
  "error",
  "expired",
] as const;

export const WITHDRAWAL_STATUSES = [
  "unsent",
  "sending",
  "sent",
  "refunded",
  "cancelled",
  "error",
  "expired",
] as const;
export const TERMINAL_WITHDRAWAL_STATUSES = [
  "sent",
  "refunded",
  "cancelled",
  "error",
  "expired",
] as const;

// Sandbox-only synthetic states (not part of the live enums; spec §4.5).
export const SANDBOX_DEPOSIT_STATUS = "depix_sent" as const;
export const SANDBOX_WITHDRAWAL_STATUS = "confirmed" as const;

const checkoutStatus = z.enum(CHECKOUT_STATUSES);
// Withdrawal reads may carry the sandbox-only synthetic "confirmed" (spec §4.5).
const withdrawalStatus = z.enum([...WITHDRAWAL_STATUSES, SANDBOX_WITHDRAWAL_STATUS]);
const depositStatus = z.enum(DEPOSIT_STATUSES);

const AMOUNT_MIN = 500;
const AMOUNT_MAX = 300000;
// Factory (not a shared instance): reusing ONE zod object for both `amount` and
// `amount_cents` makes the JSON Schema converter emit a `$ref` for the second
// occurrence — hosts that don't resolve $ref then break, and the sibling
// description is dropped. Fresh chains per field keep the schema inline.
const amountField = () => z.number().int().min(AMOUNT_MIN).max(AMOUNT_MAX);

// Money field appears in different wire keys per endpoint (spec §4.0); the
// serialization boundary (requestMap.ts) maps amount_cents (input alias) → the
// wire field. Factory so every consuming tool schema gets fresh instances.
const amountInputShape = () => ({
  amount: amountField()
    .optional()
    .describe("Amount in BRL cents (R$5.00–R$3000.00). Wire field is `amount`."),
  amount_cents: amountField()
    .optional()
    .describe("Alias of `amount` (BRL cents). Provide either `amount` or `amount_cents`."),
});

const metadataOutput = z
  .union([z.record(z.string(), z.unknown()), z.string(), z.null()])
  .describe("Merchant metadata, parsed to an object when it was valid JSON.");

// ────────────────────────────── Checkouts ──────────────────────────────

export const createCheckoutInput = {
  ...amountInputShape(),
  description: z.string().max(500).optional().describe("Description shown to the payer."),
  payer_tax_number: z
    .string()
    .describe("Payer CPF/CNPJ (digits). Required in all modes, including sandbox, while the platform tax-number gate is on."),
  image_url: z.string().url().optional().describe("Optional image on the hosted payment page."),
  callback_url: z.string().url().optional().describe("Optional per-checkout webhook URL."),
  redirect_url: z.string().url().optional().describe("Optional post-payment redirect URL."),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional arbitrary key/value bag echoed back on reads/webhooks."),
  expires_in: z
    .number()
    .int()
    .min(300)
    .max(1200)
    .optional()
    .describe("QR lifetime in seconds (300–1200, default 1200)."),
  idempotency_key: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Optional. If omitted, the server generates one. Reuse to safely retry."),
};

export const checkoutCreateOutput = {
  id: z.string().describe("Checkout id (chk_…)."),
  status: checkoutStatus.describe("Always `pending` at creation."),
  amount: z.number().int().describe("Charge amount in BRL cents."),
  description: z.string().nullable(),
  image_url: z.string().nullable(),
  expires_at: z.string().nullable().describe("QR expiry timestamp (UTC)."),
  is_live: z.boolean().describe("false when created with sk_test_."),
  payment_url: z.string().describe("Hosted payment page URL to hand to the payer."),
  pix: z
    .object({ qr_code: z.string().describe("PIX copy-and-paste (BR Code) payload.") })
    .describe("PIX payload; present while pending."),
  replayed: z
    .boolean()
    .optional()
    .describe("true when the API replayed a prior response for the same Idempotency-Key."),
};

// Full checkout detail — curate+strip (spec §4.1): the API row is closed, so
// unknown keys are dropped rather than advertised.
export const checkoutDetailOutput = {
  id: z.string(),
  status: checkoutStatus,
  amount: z.number().int(),
  description: z.string().nullable(),
  image_url: z.string().nullable(),
  pix_payload: z.string().nullable().describe("PIX payload; present only while pending."),
  callback_url: z.string().nullable(),
  redirect_url: z.string().nullable(),
  metadata: metadataOutput,
  expires_at: z.string().nullable(),
  is_live: z.boolean(),
  created_at: z.string().nullable(),
  processing_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  blockchain_tx_id: z.string().nullable(),
  rejection_reasons: z
    .array(z.string())
    .describe("Provider reason codes when the underlying payment was refused/held; [] otherwise."),
};

export const getCheckoutInput = {
  checkout_id: z.string().regex(/^chk_/).describe("Checkout id (chk_…)."),
};

export const listCheckoutsInput = {
  status: checkoutStatus.optional(),
  product_id: z.string().regex(/^prd_/).optional(),
  from: z.string().optional().describe("UTC timestamp lower bound (created_at >=)."),
  to: z.string().optional().describe("UTC timestamp upper bound (created_at <=)."),
  q: z.string().optional().describe("Substring match on id + description."),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
};

const checkoutListItemOutput = z.object({
  id: z.string(),
  status: checkoutStatus,
  amount: z.number().int(),
  description: z.string().nullable(),
  created_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  is_live: z.boolean(),
  processing_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  metadata: metadataOutput,
  product_name: z.string().nullable(),
  rejection_reasons: z.array(z.string()),
});

const checkoutStats = z
  .object({
    total: z.number().int(),
    pending: z.number().int().optional(),
    completed: z.number().int().optional(),
    completed_amount: z.number().int().optional(),
  })
  .passthrough();

export const listCheckoutsOutput = {
  checkouts: z.array(checkoutListItemOutput),
  stats: checkoutStats,
  limit: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
};

export const simulateCheckoutInput = {
  checkout_id: z.string().regex(/^chk_/).describe("Sandbox checkout id (chk_…)."),
};
export const simulateCheckoutOutput = {
  success: z.literal(true),
  checkout_id: z.string(),
  note: z.string(),
};

export const waitForCheckoutOutput = {
  checkout_id: z.string(),
  status: checkoutStatus,
  terminal: z.boolean().describe("true when status reached a terminal state."),
  timed_out: z
    .boolean()
    .describe("true if the wait budget elapsed before terminal; status is last observed."),
  is_live: z.boolean(),
};

/** wait_for_checkout input schema — `maximum` is env-driven (spec §2.5, §5.2). */
export function waitForCheckoutInput(maxWaitSeconds: number) {
  return {
    checkout_id: z.string().regex(/^chk_/).describe("Checkout id (chk_…)."),
    timeout_seconds: z
      .number()
      .int()
      .min(5)
      .max(maxWaitSeconds)
      .default(Math.min(300, maxWaitSeconds))
      .describe(
        `Server-side wait budget (5–${maxWaitSeconds}s). The internal deadline always fires with margin below the platform cap, returning timed_out:true rather than being killed.`,
      ),
  };
}

// ────────────────────────────── Products ──────────────────────────────

export const createProductInput = {
  name: z.string().min(2).max(80).describe("Product name (2–80 chars)."),
  ...amountInputShape(),
  slug: z.string().optional().describe("URL slug (auto-generated from name when omitted)."),
  description: z.string().max(500).optional(),
  image_url: z.string().url().optional(),
  callback_url: z.string().url().optional(),
  redirect_url: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expires_in: z.number().int().min(300).max(1200).optional(),
};

const productCreateObject = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string().nullable(),
    amount: z.number().int(),
    description: z.string().nullable(),
    image_url: z.string().nullable(),
    callback_url: z.string().nullable(),
    redirect_url: z.string().nullable(),
    metadata: metadataOutput,
    expires_in: z.number().int(),
    active: z.boolean(),
    is_live: z.boolean(),
    payment_url: z.string(),
    created_at: z.string(),
  })
  .passthrough();

export const createProductOutput = {
  product: productCreateObject,
};

export const listProductsInput = {
  active: z.boolean().optional().describe("Filter by active flag."),
  q: z.string().optional().describe("Substring search over slug, name and description."),
  // Max 99 (not 100): the API has no `total` for products, so has_more is
  // derived by over-fetching limit+1 — capping at 99 keeps limit+1 within the
  // API's 100 cap and has_more EXACT on every page.
  limit: z.number().int().min(1).max(99).default(50),
  offset: z.number().int().min(0).default(0),
};

const productListItemOutput = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string().nullable(),
    amount: z.number().int(),
    description: z.string().nullable(),
    image_url: z.string().nullable(),
    active: z.boolean(),
    is_live: z.boolean(),
    expires_in: z.number().int(),
    created_at: z.string().nullable(),
    position: z.number().int().nullable(),
    total_checkouts: z.number().int(),
    completed_checkouts: z.number().int(),
    completed_amount: z.number().int(),
  })
  .passthrough();

export const listProductsOutput = {
  products: z.array(productListItemOutput),
  limit: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
};

export const getProductInput = {
  product_id: z.string().regex(/^prd_/).describe("Product id (prd_…)."),
};

// get_product is OPEN-WORLD (spec §4.3): the API returns SELECT * so extra
// columns may appear — passthrough forwards them without breaking.
export const getProductOutput = {
  product: z
    .object({
      id: z.string(),
      is_live: z.boolean(),
      active: z.boolean(),
      metadata: metadataOutput,
    })
    .passthrough(),
  stats: z
    .object({
      total: z.number().int(),
      completed: z.number().int(),
      pending: z.number().int().optional(),
      completed_amount: z.number().int(),
    })
    .passthrough(),
};

export const updateProductInput = {
  product_id: z.string().regex(/^prd_/),
  name: z.string().min(2).max(80).optional(),
  slug: z.string().optional(),
  ...amountInputShape(),
  description: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  callback_url: z.string().nullable().optional(),
  redirect_url: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  expires_in: z.number().int().min(300).max(1200).optional(),
};

export const productActionInput = {
  product_id: z.string().regex(/^prd_/),
};
export const productActionOutput = {
  success: z.literal(true),
  product_id: z.string(),
};

export const setFeaturedInput = {
  product_ids: z
    .array(z.string().regex(/^prd_/))
    .max(50)
    .describe("Ordered product ids to pin (max 50). Empty array clears all pins."),
};
export const setFeaturedOutput = {
  success: z.literal(true),
  featured: z.array(z.string()),
};

export const listProductCheckoutsInput = {
  product_id: z.string().regex(/^prd_/),
  status: checkoutStatus.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
};

const productCheckoutItemOutput = z
  .object({
    id: z.string(),
    status: checkoutStatus,
    amount: z.number().int(),
    description: z.string().nullable(),
    created_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    processing_at: z.string().nullable(),
    completed_at: z.string().nullable(),
  })
  .passthrough();

export const listProductCheckoutsOutput = {
  checkouts: z.array(productCheckoutItemOutput),
  stats: z
    .object({
      total: z.number().int(),
      completed: z.number().int().optional(),
      completed_amount: z.number().int().optional(),
    })
    .passthrough(),
  limit: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
};

// ────────────────────────────── Account ──────────────────────────────

export const getAccountInput = {};
export const getAccountOutput = {
  merchant_id: z.string().optional(),
  name: z.string().optional(),
  username: z.string().nullable().optional(),
  merchant_slug: z.string().optional(),
  is_live: z.boolean().describe("false ⇒ you are using a sandbox key (sk_test_)."),
  created_at: z.string().optional(),
};

// ─────────────────────── Pay-side status reads (read-only) ───────────────────────

export const getDepositStatusInput = {
  deposit_id: z.string().describe("Deposit id (or sandbox_… in test mode)."),
};
export const getDepositStatusOutput = {
  id: z.string(),
  type: z.literal("deposit"),
  amount_cents: z.number().int().nullable(),
  status: depositStatus,
  terminal: z.boolean().describe("Derived from the terminal status set."),
  sandbox: z.boolean(),
  rejection_reasons: z
    .array(z.string())
    .describe("Provider reason codes when refused/held; [] when not refused."),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
};

export const getWithdrawalStatusInput = {
  withdrawal_id: z.string().describe("Withdrawal id (or sandbox_… in test mode)."),
};
export const getWithdrawalStatusOutput = {
  id: z.string(),
  type: z.literal("withdraw"),
  amount_cents: z.number().int().nullable(),
  status: withdrawalStatus.describe("`confirmed` appears only in sandbox (not a live status)."),
  terminal: z.boolean().describe("Derived from the terminal status set."),
  sandbox: z.boolean(),
  liquid_txid: z.string().optional().describe("Settlement Liquid txid, once reported."),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
};
