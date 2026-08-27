// MCP `instructions` — PER DEPLOYMENT (unified-MCP spec §1.6).
//
// The same package ships two deployments with DIFFERENT truths:
//
//   hosted  (mcp.depixapp.com)  — 26 tools, no seed, receive-only. "It never
//                                 signs, never holds funds" is TRUE here.
//   unified (npx @depixapp/mcp) — 58 tools, the operator's seed, local signing.
//                                 That same sentence is FALSE here, and shipping
//                                 it would tell the model the wallet cannot pay.
//
// So the "never signs" sentence lives in ONE named constant that the unified
// composition never includes (src/unified.ts + a test assert it is absent), and
// each deployment builds its own text from the shared sentences.
//
// This module deliberately has NO import of the wallet engine: it is reachable
// from `api/mcp.ts` (hosted) and must stay on the keyless side of the structural
// separation (§2.1). The unified half — which merges the engine's own wallet
// instructions — lives in src/unified.ts, reachable only from the stdio bin.

/** Canonical run command for the full (58-tool) local deployment. */
export const UNIFIED_RUN_COMMAND = "npx -y @depixapp/mcp";
/** The first-run ceremony. A human act at a terminal — never an MCP tool (§1.5). */
export const UNIFIED_INIT_COMMAND = "npx -y @depixapp/mcp init";

/**
 * TRUE for the hosted deployment ONLY. Exported by name so the unified build can
 * be proven not to contain it — the whole point of §1.6 fix #4.
 */
export const HOSTED_ONLY_CUSTODY_SENTENCE =
  "This server is a pure, non-custodial API client: it never signs, never holds funds, and never stores your key.";

/**
 * The Level-1 → Level-2 signpost (§1.6). The hosted deployment structurally lacks
 * the 29 wallet tools, so a connected agent cannot discover that they exist. It is
 * closed with WORDS, not code: no wallet symbol enters the hosted bundle.
 */
export const LEVEL_TWO_SIGNPOST =
  "This is the HOSTED, receive-only level of the DePix App MCP. The same MCP has a second level with 32 more tools — " +
  `a non-custodial Liquid wallet (hold, send, convert, pay Lightning invoices, buy gift cards) plus local account setup — which runs LOCALLY via \`${UNIFIED_RUN_COMMAND}\` ` +
  "on the operator's own machine, because signing happens in-process and the seed never leaves that machine. " +
  `First run is a human ceremony at a terminal: \`${UNIFIED_INIT_COMMAND}\`. If the user asks this server to hold, send or convert funds, ` +
  "point them there — no tool here can do it.";

/** Catalog sentence, per deployment: the counts differ, everything else does not. */
function catalogSentence(deployment: "hosted" | "unified"): string {
  const base =
    "DePix App MCP — receive payments on either rail (a Pix QR, or DePix sent directly on Liquid) via checkouts and products, " +
    "plus dated charges (cobranças, Pix), read transaction status, and manage support tickets (open/get/list/reply/close a ticket, attach a file) via the public DePix App API.";
  return deployment === "hosted"
    ? `${base} 26 tools total: 20 gateway + 6 support-ticket.`
    : `${base} 58 tools total: 20 gateway + 6 support-ticket + 29 local wallet_* tools + 3 account tools.`;
}

/**
 * Where a "cobrança" goes.
 *
 * The merchants this serves speak Portuguese, and *cobrança* covers BOTH the
 * one-off QR and the dated payment link. Nothing in the handshake said the
 * second one existed, and `create_checkout` — whose description opened by
 * calling itself "a charge" — was the tool the word pointed at. So the routing
 * rested entirely on a note inside `create_product`, which a host that
 * pre-filters tools by similarity may never put in front of the model.
 *
 * This sentence closes it from the front: both spellings of the intent, the
 * tool that serves each, and the default that otherwise returns an empty list
 * to an agent looking for the charge it just created.
 */
export const CHARGES_SENTENCE =
  'A dated charge — "cobrança" in Portuguese: rent, tuition, an instalment — is `create_product` with kind="charge": ' +
  "a payment link with a DUE DATE, optional late fine and monthly interest, and optional recurrence, paid by Pix, served at " +
  "pay.depixapp.com/c/{id} and never shown on the merchant's public store. For a one-off amount paid once (not dated, not " +
  "recurring), use `create_checkout` instead. `list_products` omits charges unless you pass kind=\"charge\" (or kind=\"all\").";

/**
 * The gateway sentences both deployments share. `HOSTED_ONLY_CUSTODY_SENTENCE` is
 * NOT among them — a caller adds it explicitly, and only the hosted one does.
 */
export function gatewaySentences(deployment: "hosted" | "unified"): string[] {
  return [
    catalogSentence(deployment),
    CHARGES_SENTENCE,
    "Authentication is a DePix App API key (sk_test_… for sandbox, sk_live_… for production), configured on the connection itself: over HTTP it is the `Authorization: Bearer sk_…` header; in local stdio mode it is the DEPIX_API_KEY environment variable.",
    "Tools cannot set the key — if a tool reports a missing key, ask the user to reconnect with their key configured.",
    "Always test with an sk_test_ key first. `get_account` is the recommended connection test.",
  ];
}

/**
 * `instructions` for the DePix App-hosted deployment (mcp.depixapp.com): the 26
 * gateway tools, the honest custody sentence, and the Level-2 signpost.
 */
export function hostedInstructions(): string {
  return [...gatewaySentences("hosted"), HOSTED_ONLY_CUSTODY_SENTENCE, LEVEL_TWO_SIGNPOST].join(" ");
}
