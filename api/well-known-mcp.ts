// Minimal, best-effort /.well-known/mcp.json (spec §6.1). Nice-to-have discovery
// document — the standard is emergent and no client depends on it yet. The
// normative OAuth discovery lives at /.well-known/oauth-protected-resource
// (RFC 9728) when AUTHKIT_DOMAIN is configured.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveAuthkitDomain, resolveServerVersion, SERVER_NAME, SERVER_TITLE } from "../src/config.js";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({
    name: SERVER_NAME,
    title: SERVER_TITLE,
    // TWO-LEVEL description (spec §1.6). This endpoint is level 1 and serves 26
    // tools; the SAME MCP has a level 2 that runs on the operator's own machine
    // with 32 more (29 wallet_* + 3 agent-local). A descriptor that only said "26
    // tools" left every reader of this document unable to discover the wallet.
    description:
      "The DePix App MCP — one MCP, two levels of access. THIS hosted endpoint is level 1: receive Pix (checkouts, products and dated charges), read transaction status, onboarding/vault/webhook reads, and support tickets — 26 tools, no seed, holds nothing. Level 2 runs locally (`npx -y @depixapp/mcp`, first run `npx -y @depixapp/mcp init`) and adds 29 wallet_* tools — a non-custodial Liquid wallet that signs on the operator's own machine — plus 3 agent-local account tools, for 58 in total.",
    version: resolveServerVersion(),
    transports: [{ type: "streamable-http", url: "https://mcp.depixapp.com/mcp" }],
    levels: {
      hosted: { transport: "streamable-http", url: "https://mcp.depixapp.com/mcp", tool_count: 26, custody: "none" },
      local: {
        transport: "stdio",
        package: "@depixapp/mcp",
        command: "npx -y @depixapp/mcp",
        first_run: "npx -y @depixapp/mcp init",
        tool_count: 58,
        // The closed-sum breakdown (§3.6): full = gateway + wallet + agent_local.
        tool_count_gateway: 26,
        tool_count_wallet: 29,
        tool_count_local: 3,
        custody: "operator holds the seed; signing is in-process",
      },
    },
    auth: {
      type: "http_bearer",
      header: "Authorization",
      description:
        "Provide your DePix App API key: Bearer sk_test_… (sandbox) or sk_live_… (production)." +
        (resolveAuthkitDomain()
          ? " OAuth 2.1 is also available for web clients (see /.well-known/oauth-protected-resource)."
          : ""),
      is_secret: true,
    },
    docs: "https://depixapp.com/docs/en/",
    openapi: "https://depixapp.com/openapi.json",
  });
}
