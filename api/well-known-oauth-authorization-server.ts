// Compatibility shim (WorkOS-recommended): older MCP clients skip RFC 9728 and
// fetch /.well-known/oauth-authorization-server directly from the MCP origin.
// Proxy AuthKit's AS metadata so they still discover the endpoints. Cached per
// warm instance (5 min) — the document is effectively static.
//
// 404 when AUTHKIT_DOMAIN is unset (OAuth surface feature-flagged off).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveAuthkitDomain } from "../src/config.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { domain: string; fetchedAt: number; body: unknown } | null = null;

/** Test hook — resets the module cache. */
export function _resetAsMetadataCache(): void {
  cache = null;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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

  if (!cache || cache.domain !== authkitDomain || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    try {
      const upstream = await fetch(`${authkitDomain}/.well-known/oauth-authorization-server`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) {
        res.status(502).json({ error: "authorization_server_unreachable" });
        return;
      }
      cache = { domain: authkitDomain, fetchedAt: Date.now(), body: await upstream.json() };
    } catch {
      res.status(502).json({ error: "authorization_server_unreachable" });
      return;
    }
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json(cache.body);
}
