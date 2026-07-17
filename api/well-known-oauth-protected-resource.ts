// RFC 9728 Protected Resource Metadata (F4 §2.9). This is what an MCP client
// fetches after our 401 challenge to discover the Authorization Server
// (AuthKit). Served on BOTH /.well-known/oauth-protected-resource and the
// path-suffixed /.well-known/oauth-protected-resource/mcp — claude.ai probes
// the suffixed form FIRST when the 401 lacks resource_metadata.
//
// 404 when AUTHKIT_DOMAIN is unset: the OAuth surface is feature-flagged off.
// Public metadata → permissive CORS (browser-based inspectors).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveAuthkitDomain, resolveResourceUrl } from "../src/config.js";
import { buildProtectedResourceMetadata } from "../src/oauth.js";

export default function handler(req: VercelRequest, res: VercelResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const authkitDomain = resolveAuthkitDomain();
  if (!authkitDomain) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json(
    buildProtectedResourceMetadata({ resourceUrl: resolveResourceUrl(), authkitDomain }),
  );
}
