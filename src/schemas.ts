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

// Settlement rails (OpenAPI 0.20.0 `PaymentMethod`). `pix`: the payer pays a
// Pix QR and the provider delivers DePix to the merchant. `depix`: the payer
// sends DePix wallet-to-wallet on Liquid to an address dedicated to the
// merchant, and settlement is observed on-chain — there is no Pix QR, and no
// payer document, on that rail.
export const PAYMENT_METHODS = ["pix", "depix"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const checkoutStatus = z.enum(CHECKOUT_STATUSES);
const paymentMethod = z.enum(PAYMENT_METHODS);
// Withdrawal reads may carry the sandbox-only synthetic "confirmed" (spec §4.5).
const withdrawalStatus = z.enum([...WITHDRAWAL_STATUSES, SANDBOX_WITHDRAWAL_STATUS]);
const depositStatus = z.enum(DEPOSIT_STATUSES);

// Transaction ceiling, mirroring the backend's single source (limits.js
// MIN/MAX_TX_AMOUNT_CENTS) as documented on CheckoutCreateRequest,
// MerchantCheckoutRequest, ProductCreateRequest and ProductUpdateRequest —
// all four carry the same range. A stale copy here does not fail loudly: it
// rejects, client-side and before any request, a charge the API would have
// accepted. test/contract.test.ts pins both numbers against the fixture so the
// next raise breaks CI here instead of surfacing as "the agent refuses to
// bill R$ 4.000".
const AMOUNT_MIN = 500;
const AMOUNT_MAX = 600000;
// Factory (not a shared instance): reusing ONE zod object for both `amount` and
// `amount_cents` makes the JSON Schema converter emit a `$ref` for the second
// occurrence — hosts that don't resolve $ref then break, and the sibling
// description is dropped. Fresh chains per field keep the schema inline.
const amountField = () => z.number().int().min(AMOUNT_MIN).max(AMOUNT_MAX);

// Derived, never typed by hand: the previous literal said R$3000.00 long after
// the cap doubled, and an agent reading it self-censors below what the merchant
// can actually charge.
const AMOUNT_RANGE_TEXT = `R$${AMOUNT_MIN / 100}.00–R$${AMOUNT_MAX / 100}.00`;

// Money field appears in different wire keys per endpoint (spec §4.0); the
// serialization boundary (requestMap.ts) maps amount_cents (input alias) → the
// wire field. Factory so every consuming tool schema gets fresh instances.
const amountInputShape = () => ({
  amount: amountField()
    .optional()
    .describe(`Amount in BRL cents (${AMOUNT_RANGE_TEXT}). Wire field is \`amount\`.`),
  amount_cents: amountField()
    .optional()
    .describe("Alias of `amount` (BRL cents). Provide either `amount` or `amount_cents`."),
});

const metadataOutput = z
  .union([z.record(z.string(), z.unknown()), z.string(), z.null()])
  .describe("Merchant metadata, parsed to an object when it was valid JSON.");

// ────────────────────────────── Checkouts ──────────────────────────────

// Lifetime bounds per rail (OpenAPI 0.20.0 CheckoutCreateRequest.allOf). The
// FIELD carries the widest window so the tool never rejects client-side what
// the API accepts; the narrower pix ceiling is a cross-field rule, because it
// only applies once you know the rail (see createCheckoutInputSchema).
const MIN_EXPIRES_IN = 300;
const PIX_MAX_EXPIRES_IN = 1200;
const DEPIX_MAX_EXPIRES_IN = 3600;
const MAX_DISCOUNT_PCT = 90;

export const createCheckoutInput = {
  ...amountInputShape(),
  description: z.string().max(500).optional().describe("Description shown to the payer."),
  payment_method: paymentMethod
    .optional()
    .describe(
      "Settlement rail; defaults to `pix`. `pix`: the payer pays a Pix QR in any bank app. `depix`: the payer sends DePix wallet-to-wallet on Liquid to the merchant's dedicated address — no Pix QR, no payer document, an optional merchant discount, and settlement observed on-chain. `depix` requires the merchant to have the direct DePix rail enabled, otherwise the API answers `depix_not_enabled`.",
    ),
  payer_tax_number: z
    .string()
    .optional()
    .describe(
      "Payer CPF/CNPJ (digits). REQUIRED on the `pix` rail — in all modes, including sandbox, while the platform tax-number gate is on. IGNORED on the `depix` rail: that rail has no payer identity by design, so this MCP does not even send the field.",
    ),
  expected_discount_pct: z
    .number()
    .int()
    .min(0)
    .max(MAX_DISCOUNT_PCT)
    .optional()
    .describe(
      "`depix` rail only: the discount percentage (0–90) you already showed the payer. When it no longer matches the merchant's current discount the API answers 409 `discount_changed` with the fresh values, instead of silently charging a different price.",
    ),
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
    .min(MIN_EXPIRES_IN)
    .max(DEPIX_MAX_EXPIRES_IN)
    .optional()
    .describe(
      "Payment lifetime in seconds, per rail: `pix` accepts 300–1200 (default 1200); `depix` accepts 300–3600 (default 1800), because paying on-chain means opening a wallet.",
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Optional. If omitted, the server generates one. Reuse to safely retry."),
};

/**
 * The RAIL-CONDITIONAL rules of create_checkout, which a per-field raw shape
 * cannot express (OpenAPI 0.20.0 states them as an if/then/else on
 * `payment_method`).
 *
 * It is applied at the serialization boundary (requestMap.ts), not handed to
 * registerTool: the SDK enforces an input schema by THROWING McpError
 * InvalidParams, a protocol-level failure the agent reads as a broken tool,
 * whereas every other bad-input case in this server surfaces as a typed
 * `validation_error` tool result it can act on. Same reason the
 * `amount`/`amount_cents` rule lives there.
 */
export const createCheckoutInputSchema = z.object(createCheckoutInput).superRefine((v, ctx) => {
  // Absent payment_method means the pix rail (the API's default), so the pix
  // rules must fire for it too — never only for an explicit "pix".
  if (v.payment_method === "depix") return;
  if (v.payer_tax_number === undefined || v.payer_tax_number.trim() === "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payer_tax_number"],
      message:
        "`payer_tax_number` (the payer's CPF/CNPJ) is required on the `pix` rail. Pass it, or charge on the DePix rail with payment_method:\"depix\", which needs no payer document.",
    });
  }
  if (v.expires_in !== undefined && v.expires_in > PIX_MAX_EXPIRES_IN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_in"],
      message: `\`expires_in\` must be ${MIN_EXPIRES_IN}–${PIX_MAX_EXPIRES_IN} seconds on the \`pix\` rail; only the \`depix\` rail accepts up to ${DEPIX_MAX_EXPIRES_IN}.`,
    });
  }
});

// Payment instructions for the depix rail (OpenAPI 0.20.0 `DepixPayment`).
// Factory, like `amountField()`: the object appears in two tool schemas, and a
// single shared instance would make the JSON-Schema converter emit a `$ref` the
// day both land in one document.
const depixPaymentOutput = () =>
  z.object({
    address: z
      .string()
      .describe(
        "Confidential Liquid address (lq1…) dedicated to this merchant's direct DePix receipts. In sandbox it is a non-payable placeholder — never send funds to it.",
      ),
    amount_cents: z
      .number()
      .int()
      .describe(
        "EXACT amount to send, in BRL cents: the face amount minus the merchant's discount, minus a per-checkout adjustment of at most 99 cents (always downwards) that makes the value unique among the merchant's open checkouts. That uniqueness is how the payment is matched — any other value stays unattributed and is NOT credited automatically.",
      ),
    amount: z
      .string()
      .describe(
        'The same amount as the decimal string a wallet signs (e.g. "89.91"). Transmit it verbatim; never round it.',
      ),
    asset_id: z
      .string()
      .describe(
        "Liquid asset id of DePix. Sending any other asset to this address loses the funds — they cannot be returned.",
      ),
    uri: z
      .string()
      .nullable()
      .describe(
        "BIP21-style Liquid payment URI carrying address, amount and asset — hand it to a wallet instead of asking the payer to type anything. Null in sandbox, which has no payable destination.",
      ),
    discount_pct: z
      .number()
      .int()
      .describe("Merchant discount applied on this rail, 0–90 (0 when the merchant offers none)."),
    original_amount_cents: z
      .number()
      .int()
      .describe("Face amount in cents before discount and uniqueness adjustment — the checkout's `amount`."),
    detected: z
      .boolean()
      .describe(
        "true once a matching payment has been SEEN on the network but not yet confirmed. Informational only: the status stays `pending` and no webhook fires until the first confirmation.",
      ),
  });

export const checkoutCreateOutput = {
  id: z.string().describe("Checkout id (chk_…)."),
  status: checkoutStatus.describe("Always `pending` at creation."),
  amount: z.number().int().describe("Charge amount in BRL cents (face value, before any DePix discount)."),
  description: z.string().nullable(),
  image_url: z.string().nullable(),
  expires_at: z.string().nullable().describe("Expiry timestamp (UTC)."),
  is_live: z.boolean().describe("false when created with sk_test_."),
  payment_url: z.string().describe("Hosted payment page URL to hand to the payer."),
  payment_method: paymentMethod
    .optional()
    .describe("The rail this checkout settles on. Absent on API versions older than 0.20.0 (read it as `pix`)."),
  // Exactly one of pix / depix is present, matching the rail — so neither can be
  // required. A depix checkout has no Pix QR at all.
  pix: z
    .object({ qr_code: z.string().describe("PIX copy-and-paste (BR Code) payload.") })
    .optional()
    .describe("PIX payload — present on the `pix` rail only, while pending."),
  depix: depixPaymentOutput()
    .optional()
    .describe(
      "DePix (Liquid) payment instructions — present on the `depix` rail only, while the checkout is still payable. An on-chain payment is irreversible.",
    ),
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
  payment_method: paymentMethod
    .optional()
    .describe("The rail this checkout settles on. Absent on API versions older than 0.20.0 (read it as `pix`)."),
  depix: depixPaymentOutput()
    .optional()
    .describe(
      "DePix (Liquid) payment instructions — present on the `depix` rail only, while the checkout is still payable.",
    ),
  pix_payload: z.string().nullable().describe("PIX payload; present only while pending on the `pix` rail."),
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

// ────────────────────────────── Support tickets ──────────────────────────────
// Thin proxies over the backend /api/tickets endpoints (OpenAPI 0.17.0). The
// tool shapes mirror the backend `serializeTicket` / `serializeMessage` JSON
// verbatim — same field names, so there is no snake↔camel rename here; the
// mapping is still explicit (never a blind passthrough) in tools/tickets.ts.

export const TICKET_STATUSES = ["awaiting_reply", "answered", "closed"] as const;
export const TERMINAL_TICKET_STATUSES = ["closed"] as const;
export const TICKET_CATEGORIES = ["bug", "question", "account", "payment", "other"] as const;
export const TICKET_SENDERS = ["user", "admin", "system"] as const;
export const TICKET_OPENER_TYPES = ["human", "agent"] as const;

const ticketStatus = z.enum(TICKET_STATUSES);
const ticketCategory = z.enum(TICKET_CATEGORIES);

// Shared object schemas: each is referenced at most once per tool's outputSchema,
// so a single shared instance never triggers a JSON-Schema $ref (same reasoning
// as `metadataOutput`; the $ref hazard is only a repeat WITHIN one schema).
const ticketObject = z.object({
  id: z.string().describe("Ticket id (tkt_…)."),
  opener_type: z
    .enum(TICKET_OPENER_TYPES)
    .describe("Who opened the ticket, snapshotted from the account type at creation."),
  status: ticketStatus.describe("awaiting_reply | answered | closed. `closed` is terminal (an auto-closed ticket can be reopened by replying within 7 days)."),
  subject: z.string(),
  category: ticketCategory,
  created_at: z.string().describe("Creation timestamp (UTC)."),
  last_activity_at: z.string().describe("Timestamp of the last user/admin message (UTC)."),
  closed_reason: z.string().nullable().describe("'user' | 'admin' | 'auto'; null while open."),
  closed_at: z.string().nullable().describe("Close timestamp (UTC); null while open."),
});

// Allowed attachment types + size, mirroring the backend allowlist / 3 MB cap.
export const ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/json",
] as const;
export const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
// base64 inflates ~33%; cap the encoded string a hair above the decoded ceiling.
export const ATTACHMENT_MAX_BASE64_LENGTH = Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 16;

const ticketAttachmentObject = z
  .object({
    name: z.string().describe("Original filename."),
    mime: z.string().nullable().describe("Content type."),
  })
  .nullable()
  .describe("Attached file metadata when the message carries a file, otherwise null.");

const ticketMessageObject = z.object({
  id: z.string(),
  sender: z.enum(TICKET_SENDERS).describe("Who sent the message."),
  body: z.string(),
  created_at: z.string().describe("Message timestamp (UTC)."),
  attachment: ticketAttachmentObject,
});

export const openSupportTicketInput = {
  subject: z.string().min(4).max(120).describe("Short subject (4–120 chars)."),
  category: z
    .enum(TICKET_CATEGORIES)
    .optional()
    .describe(
      "Optional category (bug | question | account | payment | other; defaults to 'other'). Triage only — it does not change handling or the SLA.",
    ),
  body: z.string().min(1).max(4000).describe("Ticket body — becomes the first message (1–4000 chars)."),
};

export const openSupportTicketOutput = {
  ticket: ticketObject,
};

export const getSupportTicketInput = {
  id: z.string().regex(/^tkt_/).describe("Ticket id (tkt_…)."),
};

export const getSupportTicketOutput = {
  ticket: ticketObject,
  messages: z.array(ticketMessageObject).describe("Full message thread, oldest first."),
};

export const listSupportTicketsInput = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
};

export const listSupportTicketsOutput = {
  tickets: z.array(ticketObject).describe("Your tickets (this session/key), newest activity first."),
  total: z.number().int().describe("Total tickets for this principal (ignores pagination)."),
  limit: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean().describe("True when more tickets exist past this page."),
};

export const replySupportTicketInput = {
  id: z.string().regex(/^tkt_/).describe("Ticket id (tkt_…)."),
  body: z.string().min(1).max(4000).describe("Reply body (1–4000 chars)."),
};

export const replySupportTicketOutput = {
  message: ticketMessageObject,
  ticket: ticketObject,
};

export const closeSupportTicketInput = {
  id: z.string().regex(/^tkt_/).describe("Ticket id (tkt_…)."),
};

export const closeSupportTicketOutput = {
  ticket: ticketObject,
};

export const attachSupportTicketFileInput = {
  id: z.string().regex(/^tkt_/).describe("Ticket id (tkt_…)."),
  filename: z
    .string()
    .min(1)
    .max(200)
    .describe("Filename shown to the support team, e.g. 'error.log' or 'screenshot.png'."),
  content_type: z
    .enum(ATTACHMENT_CONTENT_TYPES)
    .describe("File MIME type: image/png, image/jpeg, image/webp, application/pdf, text/plain or application/json."),
  file_b64: z
    .string()
    .min(1)
    .max(ATTACHMENT_MAX_BASE64_LENGTH)
    .describe("The file bytes, base64-encoded (no data: URI prefix). Max ~3 MB decoded."),
  caption: z.string().max(400).optional().describe("Optional note shown with the file (max 400 chars)."),
};

export const attachSupportTicketFileOutput = {
  message: ticketMessageObject,
  ticket: ticketObject,
};
