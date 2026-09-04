// Server factory (spec §2.8). Registers all 26 tools on a McpServer bound to an
// ApiClient carrying the caller's key (20 gateway tools + 6 support-ticket
// proxies, SPEC_TICKETS §8). Stateless: a fresh server is built per HTTP request
// (the key comes from that request's Authorization header) and once for the
// whole process in stdio mode. cancel_checkout is intentionally absent (removed
// by product decision 2026-07-09).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiClient, type ApiKeySource } from "./apiClient.js";
import { SERVER_NAME, SERVER_TITLE, resolveServerVersion } from "./config.js";
import { ToolError, type LockedVaults } from "./errors.js";
import { hostedInstructions } from "./instructions.js";
import { logger } from "./log.js";
import * as s from "./schemas.js";
import {
  createCheckout,
  getCheckout,
  listCheckouts,
  simulateCheckoutPayment,
} from "./tools/checkouts.js";
import { waitForCheckout } from "./tools/wait.js";
import {
  activateProduct,
  createProduct,
  deactivateProduct,
  getProduct,
  listProductCheckouts,
  listProducts,
  setFeaturedProducts,
  updateProduct,
} from "./tools/products.js";
import { getAccount } from "./tools/account.js";
import { getDepositStatus, getWithdrawalStatus } from "./tools/payStatus.js";
import { getOnboardingStatus } from "./tools/onboarding.js";
import { updateMerchantProfile, type UpdateMerchantProfileArgs } from "./tools/merchantProfile.js";
import { getVaultStatus } from "./tools/vault.js";
import { listWebhookLogs } from "./tools/webhookLogs.js";
import {
  attachSupportTicketFile,
  closeSupportTicket,
  getSupportTicket,
  listSupportTickets,
  openSupportTicket,
  replySupportTicket,
} from "./tools/tickets.js";
import type {
  AttachTicketArgs,
  CreateCheckoutArgs,
  CreateProductArgs,
  OpenTicketArgs,
  ReplyTicketArgs,
  UpdateProductArgs,
} from "./requestMap.js";

/**
 * The number of tools createServer registers — the HOSTED catalog and the
 * gateway half of the unified one (§3.6): 20 gateway (merchant/account/status/
 * onboarding/vault/webhook-logs) + 6 support-ticket. Kept as a checked constant
 * so the count surfaces (well-known, unified.ts) derive from ONE number, and
 * test/server.test.ts pins it against the tools actually registered here.
 */
export const GATEWAY_TOOL_COUNT = 26;

function ok(out: unknown): CallToolResult {
  return {
    // Full JSON in the text block: structuredContent carries the same payload,
    // and truncating the text would silently hand hosts that only render
    // `content` an invalid, cut-off JSON document.
    content: [{ type: "text", text: JSON.stringify(out) }],
    structuredContent: out as Record<string, unknown>,
  };
}

function fail(err: ToolError): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: err.message },
      {
        type: "text",
        text: JSON.stringify({ error: { code: err.code, retryable: err.retryable, ...err.data } }),
      },
    ],
  };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof ToolError) return fail(err);
    // Unexpected error (a bug, not an API error): surface a generic tool error,
    // never the raw message — keeps the redaction/trust boundary uniform so no
    // upstream text or accidental secret can reach the host through this path.
    logger.error("tool_unexpected_error", {
      name: err instanceof Error ? err.name : "unknown",
    });
    return fail(new ToolError("Unexpected error while executing the tool.", "internal_error"));
  }
}

export interface CreateServerOptions {
  /** A fixed sk_/JWT string, or a resolver read per request (§3.1) so a key
   * minted mid-session (register_account) is used without a restart. */
  apiKey?: ApiKeySource;
  /** "oauth" when the connection authenticated via a WorkOS token (no sk_). */
  authMode?: "oauth";
  /** Renew an expired OAuth session on a 401 (local `depix-mcp login` only). */
  onUnauthorized?: () => Promise<boolean>;
  /** Which deployment this is — steers the missing_api_key next_action (§5.1).
   * Default "hosted"; the unified npx bin passes "local". */
  deployment?: "hosted" | "local";
  /** Local vaults the boot found sealed shut — see ApiClientOptions. */
  lockedCredentials?: LockedVaults;
  apiBase: string;
  maxWaitSeconds: number;
  version?: string;
  /** Inject a preconfigured client (tests). */
  apiClient?: ApiClient;
  /**
   * PER-DEPLOYMENT handshake `instructions` (spec §1.6). Default: the hosted
   * (receive-only, 26-tool) text, because the hosted entry is the caller that
   * passes nothing. The unified npx build MUST override it — the hosted text
   * asserts this server "never signs, never holds funds", which is false once
   * the 29 wallet tools are mounted on the same server.
   */
  instructions?: string;
  /**
   * PER-DEPLOYMENT handshake `title` (spec §8/P2, moved from P4). Default
   * "DePix App Gateway", correct for the hosted receive-only deployment; the
   * unified build passes UNIFIED_SERVER_TITLE so a 62-tool local server does not
   * introduce itself as a gateway. `name` is NOT per-deployment: it is the one
   * registry identity (io.github.depixapp/depix-mcp) both deployments answer to.
   */
  title?: string;
}

export function createServer(opts: CreateServerOptions): McpServer {
  const client =
    opts.apiClient ??
    new ApiClient({
      apiKey: opts.apiKey,
      apiBase: opts.apiBase,
      authMode: opts.authMode,
      deployment: opts.deployment,
      ...(opts.lockedCredentials ? { lockedCredentials: opts.lockedCredentials } : {}),
      ...(opts.onUnauthorized ? { onUnauthorized: opts.onUnauthorized } : {}),
    });
  const version = opts.version ?? resolveServerVersion();

  const server = new McpServer(
    { name: SERVER_NAME, title: opts.title ?? SERVER_TITLE, version },
    { instructions: opts.instructions ?? hostedInstructions() },
  );

  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, openWorldHint: true };

  // ── Checkouts ──
  server.registerTool(
    "create_checkout",
    {
      title: "Create checkout",
      description:
        "Create a ONE-OFF payment (checkout) with a hosted payment page, on either settlement rail — paid once, short-lived. For a dated or recurring payment link (a \"cobrança\": rent, tuition, an instalment), use `create_product` with kind=\"charge\" instead. Default `payment_method: \"pix\"` — the payer pays a Pix QR in any bank app, and `payer_tax_number` (their CPF/CNPJ) is required. `payment_method: \"depix\"` — the payer sends DePix wallet-to-wallet on the Liquid network to the merchant's dedicated address: there is no Pix QR (the response carries `depix` instead of `pix`), no payer document is used, the merchant may grant a discount, and the payment is confirmed on-chain — `approved` at the first confirmation (~1 minute) and `completed` at the second (~2 minutes). The depix rail requires the merchant to have it enabled, otherwise the API answers `depix_not_enabled`. Requires scope `merchant_write`. Amount is BRL cents (the face value, before any DePix discount).",
      inputSchema: s.createCheckoutInput,
      outputSchema: s.checkoutCreateOutput,
      annotations: write,
    },
    (args) => run(() => createCheckout(client, args as unknown as CreateCheckoutArgs)),
  );

  server.registerTool(
    "get_checkout",
    {
      title: "Get checkout",
      description:
        "Fetch a checkout by id (owner view). `payment_method` tells you which rail it settles on; a still-payable depix checkout also carries its `depix` payment instructions (address, exact amount, URI). Requires scope `merchant_read`.",
      inputSchema: s.getCheckoutInput,
      outputSchema: s.checkoutDetailOutput,
      annotations: readOnly,
    },
    (args) => run(() => getCheckout(client, args)),
  );

  server.registerTool(
    "list_checkouts",
    {
      title: "List checkouts",
      description: "List checkouts with filters and pagination. Requires scope `merchant_read`.",
      inputSchema: s.listCheckoutsInput,
      outputSchema: s.listCheckoutsOutput,
      annotations: readOnly,
    },
    (args) => run(() => listCheckouts(client, args)),
  );

  server.registerTool(
    "simulate_checkout_payment",
    {
      title: "Simulate checkout payment (sandbox only)",
      description:
        "Mark a SANDBOX checkout as paid so you can observe checkout.completed. Live checkouts return sandbox_only. Requires scope `merchant_write`.",
      inputSchema: s.simulateCheckoutInput,
      outputSchema: s.simulateCheckoutOutput,
      annotations: write,
    },
    (args) => run(() => simulateCheckoutPayment(client, args)),
  );

  server.registerTool(
    "wait_for_checkout",
    {
      title: "Wait for checkout",
      description:
        "Wait server-side for a checkout to reach a terminal status, emitting progress. One call — no client-side polling. Returns { status, terminal, timed_out }. Requires scope `merchant_read`.",
      inputSchema: s.waitForCheckoutInput(opts.maxWaitSeconds),
      outputSchema: s.waitForCheckoutOutput,
      annotations: readOnly,
    },
    (args, extra) =>
      run(() =>
        waitForCheckout(client, args, {
          // Client disconnect/cancellation stops the poll loop immediately —
          // otherwise a dead invocation would keep polling until the budget.
          signal: extra.signal,
          onProgress: async (p) => {
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress: p.progress,
                  total: p.total,
                  message: `Checkout ${args.checkout_id} is ${p.status}`,
                },
              });
            }
          },
        }),
      ),
  );

  // ── Products ──
  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a reusable product (fixed-price checkout template with a public page), or — with kind=\"charge\" — a CHARGE (Portuguese: \"cobrança\"): a payment link with a due date and optional late fine/interest, for rent, tuition or an instalment. A charge is served at pay.depixapp.com/c/{id} and never appears on the merchant's public store. NOTE: `create_checkout` makes a ONE-OFF payment that is paid once and is short-lived; this tool with kind=\"charge\" makes a STANDING one that has a due date and can recur. Requires scope `merchant_write`.",
      inputSchema: s.createProductInput,
      outputSchema: s.createProductOutput,
      annotations: write,
    },
    (args) => run(() => createProduct(client, args as unknown as CreateProductArgs)),
  );

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List products with filters and pagination. Charges are NOT included by default — pass kind=\"charge\" to list them (each row then carries `charge_state` with the current cycle, days late and today's total) or kind=\"all\" for both. Requires scope `merchant_read`.",
      inputSchema: s.listProductsInput,
      outputSchema: s.listProductsOutput,
      annotations: readOnly,
    },
    (args) => run(() => listProducts(client, args)),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product",
      description: "Fetch a product by id with checkout aggregates. Requires scope `merchant_read`.",
      inputSchema: s.getProductInput,
      outputSchema: s.getProductOutput,
      annotations: readOnly,
    },
    (args) => run(() => getProduct(client, args)),
  );

  server.registerTool(
    "update_product",
    {
      title: "Update product",
      description:
        "Partially update a product or charge (only provided fields change). A charge's due_date, recurrence and late fees are editable here; `kind` is not — it is fixed at creation. Requires scope `merchant_write`.",
      inputSchema: s.updateProductInput,
      outputSchema: s.productActionOutput,
      annotations: write,
    },
    (args) => run(() => updateProduct(client, args as unknown as UpdateProductArgs)),
  );

  server.registerTool(
    "activate_product",
    {
      title: "Activate product",
      description: "Make a product purchasable again. Requires scope `merchant_write`.",
      inputSchema: s.productActionInput,
      outputSchema: s.productActionOutput,
      annotations: write,
    },
    (args) => run(() => activateProduct(client, args)),
  );

  server.registerTool(
    "deactivate_product",
    {
      title: "Deactivate product",
      description:
        "Hide a product from the public page and block new checkouts. On a CHARGE this also kills its live pay.depixapp.com/c/{id} link — anyone holding it sees \"cobrança indisponível\" and cannot pay. Reversible with activate_product. Requires scope `merchant_write`.",
      inputSchema: s.productActionInput,
      outputSchema: s.productActionOutput,
      annotations: write,
    },
    (args) => run(() => deactivateProduct(client, args)),
  );

  server.registerTool(
    "set_featured_products",
    {
      title: "Set featured products",
      description:
        "Reconcile the pinned product set/order on the public page in one call (empty array clears all). Requires scope `merchant_write`.",
      inputSchema: s.setFeaturedInput,
      outputSchema: s.setFeaturedOutput,
      annotations: write,
    },
    (args) => run(() => setFeaturedProducts(client, args)),
  );

  server.registerTool(
    "list_product_checkouts",
    {
      title: "List a product's checkouts",
      description: "List checkouts created from a product. Requires scope `merchant_read`.",
      inputSchema: s.listProductCheckoutsInput,
      outputSchema: s.listProductCheckoutsOutput,
      annotations: readOnly,
    },
    (args) => run(() => listProductCheckouts(client, args)),
  );

  // ── Account ──
  server.registerTool(
    "get_account",
    {
      title: "Get account",
      description:
        "Identify the authenticated merchant (connection test). Requires scope `merchant_read`.",
      inputSchema: s.getAccountInput,
      outputSchema: s.getAccountOutput,
      annotations: readOnly,
    },
    () => run(() => getAccount(client)),
  );

  // ── Pay-side status reads (read-only, scope wallet_read) ──
  server.registerTool(
    "get_deposit_status",
    {
      title: "Get deposit status",
      description:
        "Read a deposit's status (read-only). Requires scope `wallet_read`. This MCP cannot create deposits (that is the SDK, F3).",
      inputSchema: s.getDepositStatusInput,
      outputSchema: s.getDepositStatusOutput,
      annotations: readOnly,
    },
    (args) => run(() => getDepositStatus(client, args)),
  );

  server.registerTool(
    "get_withdrawal_status",
    {
      title: "Get withdrawal status",
      description:
        "Read a withdrawal's status (read-only). Requires scope `wallet_read`. This MCP cannot create withdrawals (that is the SDK, F3).",
      inputSchema: s.getWithdrawalStatusInput,
      outputSchema: s.getWithdrawalStatusOutput,
      annotations: readOnly,
    },
    (args) => run(() => getWithdrawalStatus(client, args)),
  );

  // ── Onboarding / merchant profile / vault / webhook logs (F3, §3.8/§4.3) ──
  server.registerTool(
    "get_onboarding_status",
    {
      title: "Get onboarding status",
      description:
        "Narrate what the account still needs to go live: an ordered ladder of steps (create the wallet, verify " +
        "WhatsApp, deposit+convert+withdraw to verify, create the store), each with a plain PT+EN title and " +
        "instruction to relay to the human, an absolute app deep link, and the current numbers. Composes the " +
        "verification progress with a store probe, and — when every step is complete — triggers verification itself " +
        "so the account never sits 'all green but not verified'. Read-first; the only write is that self-heal trigger. " +
        "Every incomplete step is a HUMAN step: relay its instruction and deep link to the operator and wait — no tool " +
        "here can complete one for them.",
      inputSchema: s.getOnboardingStatusInput,
      outputSchema: s.getOnboardingStatusOutput,
      annotations: write,
    },
    () => run(() => getOnboardingStatus(client)),
  );

  server.registerTool(
    "update_merchant_profile",
    {
      title: "Update merchant profile",
      description:
        "Update the store's LIGHT profile fields — business_name, logo_url, website, default_redirect_url, " +
        "default_callback_url — via PATCH /api/merchants/me. Only the fields you pass change. The money-redirecting " +
        "fields (liquid_address, split_address) are NOT here by design and cannot be changed with a key. Requires " +
        "scope `merchant_write`.",
      inputSchema: s.updateMerchantProfileInput,
      outputSchema: s.updateMerchantProfileOutput,
      annotations: write,
    },
    (args) => run(() => updateMerchantProfile(client, args as UpdateMerchantProfileArgs)),
  );

  server.registerTool(
    "get_vault_status",
    {
      title: "Get vault (Cofre) status",
      description:
        "Read the account's position in the Cofre deposit-hold mechanism (read-only): whether it is active, how long " +
        "a new deposit is held, the trust level, and the rolling receive cap with how much is left this window. " +
        "Requires scope `wallet_read`.",
      inputSchema: s.getVaultStatusInput,
      outputSchema: s.getVaultStatusOutput,
      annotations: readOnly,
    },
    () => run(() => getVaultStatus(client)),
  );

  server.registerTool(
    "list_webhook_logs",
    {
      title: "List webhook delivery logs",
      description:
        "Read recent webhook delivery attempts (read-only): the event, the endpoint, the HTTP status it returned or " +
        "the transport error, the attempt number and when it was sent — newest first. Pass `id` to fetch one " +
        "delivery. Did my webhook arrive, and what did the endpoint answer?",
      inputSchema: s.listWebhookLogsInput,
      outputSchema: s.listWebhookLogsOutput,
      annotations: readOnly,
    },
    (args) => run(() => listWebhookLogs(client, args as { id?: string })),
  );

  // ── Support tickets (one channel for humans and agents; NO scope) ──
  server.registerTool(
    "open_support_ticket",
    {
      title: "Open a support ticket",
      description:
        "Open a support ticket for a bug, unexpected behavior, or an account/payment problem. The body becomes the first message. A human replies within 1 business day — replies are NOT pushed to you: poll get_support_ticket to read them (check back in minutes, not seconds; this is not a live chat). For API or how-to questions, the docs (depixapp.com/docs and depixapp.com/llms.txt) usually answer instantly — prefer a ticket only when something is broken or account-specific. Up to 5 open tickets per account.",
      inputSchema: s.openSupportTicketInput,
      outputSchema: s.openSupportTicketOutput,
      annotations: write,
    },
    (args) => run(() => openSupportTicket(client, args as unknown as OpenTicketArgs)),
  );

  server.registerTool(
    "get_support_ticket",
    {
      title: "Get a support ticket",
      description:
        "Fetch one of your tickets with its full message thread. Poll this to read the human's reply — support answers within 1 business day, so check back in minutes, not seconds. Returns 404 if the ticket does not exist or was opened by another session/key.",
      inputSchema: s.getSupportTicketInput,
      outputSchema: s.getSupportTicketOutput,
      annotations: readOnly,
    },
    (args) => run(() => getSupportTicket(client, args)),
  );

  server.registerTool(
    "list_support_tickets",
    {
      title: "List your support tickets",
      description:
        "List the tickets you opened (this session/key), newest activity first. Use get_support_ticket to read a thread and poll for replies.",
      inputSchema: s.listSupportTicketsInput,
      outputSchema: s.listSupportTicketsOutput,
      annotations: readOnly,
    },
    (args) => run(() => listSupportTickets(client, args)),
  );

  server.registerTool(
    "reply_support_ticket",
    {
      title: "Reply to a support ticket",
      description:
        "Post a reply to one of your tickets. On an answered ticket this moves it back to awaiting a reply; on an auto-closed ticket within 7 days it reopens it. A human answers within 1 business day — poll get_support_ticket for the response (minutes, not seconds).",
      inputSchema: s.replySupportTicketInput,
      outputSchema: s.replySupportTicketOutput,
      annotations: write,
    },
    (args) => run(() => replySupportTicket(client, args as unknown as ReplyTicketArgs)),
  );

  server.registerTool(
    "close_support_ticket",
    {
      title: "Close a support ticket",
      description:
        "Close one of your tickets once you no longer need help. This is terminal — to continue later, open a new ticket.",
      inputSchema: s.closeSupportTicketInput,
      outputSchema: s.closeSupportTicketOutput,
      annotations: write,
    },
    (args) => run(() => closeSupportTicket(client, args)),
  );

  server.registerTool(
    "attach_support_ticket_file",
    {
      title: "Attach a file to a support ticket",
      description:
        "Attach ONE file to a ticket so the support team can see it — typically a diagnostic/log file or a screenshot that documents a bug. Provide the bytes base64-encoded in file_b64 (no data: URI prefix), up to ~3 MB, with content_type one of image/png, image/jpeg, image/webp, application/pdf, text/plain or application/json. The file is forwarded to a human on the support side; it is not stored or served back, so the result records only the filename and type. Attaching counts as a reply: an answered ticket returns to awaiting a reply, and an auto-closed ticket within 7 days reopens. If the response is attachment_unavailable, retry shortly or continue with reply_support_ticket.",
      inputSchema: s.attachSupportTicketFileInput,
      outputSchema: s.attachSupportTicketFileOutput,
      annotations: write,
    },
    (args) => run(() => attachSupportTicketFile(client, args as unknown as AttachTicketArgs)),
  );

  return server;
}
