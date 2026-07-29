// MCP `instructions` — PER DEPLOYMENT (unified-MCP spec §1.6).
//
// The same package ships two deployments with DIFFERENT truths:
//
//   hosted  (mcp.depixapp.com)  — 22 tools, no seed, receive-only. "It never
//                                 signs, never holds funds" is TRUE here.
//   unified (npx @depixapp/mcp) — 49 tools, the operator's seed, local signing.
//                                 That same sentence is FALSE here, and shipping
//                                 it would tell the model the wallet cannot pay.
//
// So the "never signs" sentence lives in ONE named constant that the unified
// composition never includes (src/unified.ts + a test assert it is absent), and
// each deployment builds its own text from the shared sentences.
//
// This module deliberately has NO import of the vendored engine: it is reachable
// from `api/mcp.ts` (hosted) and must stay on the keyless side of the structural
// separation (§2.1). The unified half — which merges the engine's own wallet
// instructions — lives in src/unified.ts, reachable only from the stdio bin.

/** Canonical run command for the full (49-tool) local deployment. */
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
 * the 27 wallet tools, so a connected agent cannot discover that they exist. It is
 * closed with WORDS, not code: no wallet symbol enters the hosted bundle.
 */
export const LEVEL_TWO_SIGNPOST =
  "This is the HOSTED, receive-only level of the DePix App MCP. The same MCP has a second level with 27 more tools — " +
  `a non-custodial Liquid wallet (hold, send, convert, pay Lightning invoices, buy gift cards) — which runs LOCALLY via \`${UNIFIED_RUN_COMMAND}\` ` +
  "on the operator's own machine, because signing happens in-process and the seed never leaves that machine. " +
  `First run is a human ceremony at a terminal: \`${UNIFIED_INIT_COMMAND}\`. If the user asks this server to hold, send or convert funds, ` +
  "point them there — no tool here can do it.";

/** Catalog sentence, per deployment: the counts differ, everything else does not. */
function catalogSentence(deployment: "hosted" | "unified"): string {
  const base =
    "DePix App MCP — receive payments on either rail (a Pix QR, or DePix sent directly on Liquid) via checkouts/products, " +
    "read transaction status, and manage support tickets (open/get/list/reply/close a ticket, attach a file) via the public DePix App API.";
  return deployment === "hosted"
    ? `${base} 22 tools total: 16 gateway + 6 support-ticket.`
    : `${base} 49 tools total: 16 gateway + 6 support-ticket + 27 local wallet_* tools.`;
}

/**
 * The gateway sentences both deployments share. `HOSTED_ONLY_CUSTODY_SENTENCE` is
 * NOT among them — a caller adds it explicitly, and only the hosted one does.
 */
export function gatewaySentences(deployment: "hosted" | "unified"): string[] {
  return [
    catalogSentence(deployment),
    "Authentication is a DePix App API key (sk_test_… for sandbox, sk_live_… for production), configured on the connection itself: over HTTP it is the `Authorization: Bearer sk_…` header; in local stdio mode it is the DEPIX_API_KEY environment variable.",
    "Tools cannot set the key — if a tool reports a missing key, ask the user to reconnect with their key configured.",
    "Always test with an sk_test_ key first. `get_account` is the recommended connection test.",
  ];
}

/**
 * `instructions` for the DePix App-hosted deployment (mcp.depixapp.com): the 22
 * gateway tools, the honest custody sentence, and the Level-2 signpost.
 */
export function hostedInstructions(): string {
  return [...gatewaySentences("hosted"), HOSTED_ONLY_CUSTODY_SENTENCE, LEVEL_TWO_SIGNPOST].join(" ");
}
