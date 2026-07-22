// Minimal, best-effort /.well-known/mcp.json (spec §6.1). Nice-to-have discovery
// document — the standard is emergent and no client depends on it yet. The
// normative OAuth discovery lives at /.well-known/oauth-protected-resource
// (RFC 9728) when AUTHKIT_DOMAIN is configured.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveAuthkitDomain, resolveServerVersion } from "../src/config.js";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({
    name: "com.depixapp/gateway",
    title: "DePix App Gateway",
    description:
      "Non-custodial Pix payment gateway on Liquid. Receive Pix payments (checkouts/products) and read transaction status via MCP.",
    version: resolveServerVersion(),
    transports: [{ type: "streamable-http", url: "https://mcp.depixapp.com/mcp" }],
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
