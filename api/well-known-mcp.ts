// Minimal, best-effort /.well-known/mcp.json (spec §6.1). Nice-to-have discovery
// document — the standard is emergent and no client depends on it yet. It is NOT
// /.well-known/oauth-protected-resource (there is no OAuth in the MVP, §3.4).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveServerVersion } from "../src/config.js";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({
    name: "com.depixapp/gateway",
    title: "DePix Gateway",
    description:
      "Non-custodial Pix payment gateway on Liquid. Receive Pix payments (checkouts/products) and read transaction status via MCP.",
    version: resolveServerVersion(),
    transports: [{ type: "streamable-http", url: "https://mcp.depixapp.com/mcp" }],
    auth: {
      type: "http_bearer",
      header: "Authorization",
      description:
        "Provide your DePix API key: Bearer sk_test_… (sandbox) or sk_live_… (production).",
      is_secret: true,
    },
    docs: "https://depixapp.com/docs/en/",
    openapi: "https://depixapp.com/openapi.json",
  });
}
