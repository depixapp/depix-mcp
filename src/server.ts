// Server factory (spec §2.8). Registers all 22 tools on a McpServer bound to an
// ApiClient carrying the caller's key (16 gateway tools + 6 support-ticket
// proxies, SPEC_TICKETS §8). Stateless: a fresh server is built per HTTP request
// (the key comes from that request's Authorization header) and once for the
// whole process in stdio mode. cancel_checkout is intentionally absent (removed
// by product decision 2026-07-09).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiClient } from "./apiClient.js";
import { SERVER_NAME, SERVER_TITLE, resolveServerVersion } from "./config.js";
import { ToolError } from "./errors.js";
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

const INSTRUCTIONS = [
  "DePix App Gateway MCP — receive Pix payments (checkouts/products) and read transaction status via the public DePix App API.",
  "Authentication is a DePix App API key (sk_test_… for sandbox, sk_live_… for production), configured on the connection itself: over HTTP it is the `Authorization: Bearer sk_…` header; in local stdio mode it is the DEPIX_API_KEY environment variable.",
  "Tools cannot set the key — if a tool reports a missing key, ask the user to reconnect with their key configured.",
  "Always test with an sk_test_ key first. `get_account` is the recommended connection test.",
  "This server is a pure, non-custodial API client: it never signs, never holds funds, and never stores your key.",
].join(" ");

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
  apiKey?: string;
  /** "oauth" when the connection authenticated via a WorkOS token (no sk_). */
  authMode?: "oauth";
  apiBase: string;
  maxWaitSeconds: number;
  version?: string;
  /** Inject a preconfigured client (tests). */
  apiClient?: ApiClient;
}

export function createServer(opts: CreateServerOptions): McpServer {
  const client = opts.apiClient ?? new ApiClient({ apiKey: opts.apiKey, apiBase: opts.apiBase, authMode: opts.authMode });
  const version = opts.version ?? resolveServerVersion();

  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version },
    { instructions: INSTRUCTIONS },
  );

  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, openWorldHint: true };

  // ── Checkouts ──
  server.registerTool(
    "create_checkout",
    {
      title: "Create checkout",
      description:
        "Create a Pix charge (checkout) with a hosted payment page. Requires scope `merchant_write`. Amount is BRL cents.",
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
      description: "Fetch a checkout by id (owner view). Requires scope `merchant_read`.",
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
        "Create a reusable product (fixed-price checkout template with a public page). Requires scope `merchant_write`.",
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
      description: "List products with filters and pagination. Requires scope `merchant_read`.",
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
        "Partially update a product (only provided fields change). Requires scope `merchant_write`.",
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
        "Hide a product from the public page and block new checkouts. Requires scope `merchant_write`.",
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
