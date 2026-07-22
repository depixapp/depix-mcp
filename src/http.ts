// Streamable HTTP glue (spec §2.2, §2.4). A FRESH McpServer + transport is built
// per request in stateless mode (sessionIdGenerator: undefined): the caller's key
// is read from that request's Authorization header and lives only for the
// invocation. The body is passed already-parsed (Vercel drains req.body), so the
// transport never reads the raw stream (load-bearing note, spec §2.2).

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import {
  resolveAllowedHosts,
  resolveApiBase,
  resolveAuthkitDomain,
  resolveMaxWaitSeconds,
  resolveResourceUrl,
  resolveServerVersion,
} from "./config.js";
import { OAuthTokenError, buildWwwAuthenticate, verifyWorkosAccessToken } from "./oauth.js";
import { logger } from "./log.js";

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
export function extractBearer(header?: string | string[]): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : undefined;
}

export async function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
): Promise<void> {
  // This stateless server never delivers server-initiated messages, so the
  // standalone GET SSE stream would hang open (and pin a serverless invocation
  // up to maxDuration) while never sending anything. Per the Streamable HTTP
  // spec, a server that does not offer that stream MUST return 405 — clients
  // (Claude Code included) handle it gracefully and just skip the stream.
  if (req.method === "GET") {
    res.writeHead(405, { Allow: "POST, DELETE", "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method Not Allowed: this server does not offer a standalone SSE stream." },
        id: null,
      }),
    );
    return;
  }

  const token = extractBearer(req.headers.authorization);

  // ── Auth chain (F4 §2.9). With AUTHKIT_DOMAIN unset the OAuth surface is
  // OFF and behavior is byte-identical to before: any token (or none) flows
  // through as the apiKey and tools fail per-call with typed errors. With it
  // set, this becomes a proper OAuth 2.1 Resource Server:
  //   Bearer sk_…          → legacy path, untouched (terminal clients);
  //   Bearer <workos JWT>  → verified against the AuthKit JWKS;
  //   missing/invalid      → REAL 401 + WWW-Authenticate (the challenge that
  //                          triggers claude.ai/ChatGPT OAuth discovery —
  //                          a 200 with the header is ignored by clients).
  const authkitDomain = resolveAuthkitDomain();
  let apiKey = token;
  let authMode: "oauth" | undefined;

  if (authkitDomain && !token?.startsWith("sk_")) {
    const resourceUrl = resolveResourceUrl();
    const challenge = (error?: "invalid_token") => {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": buildWwwAuthenticate(resourceUrl, error),
      });
      res.end(JSON.stringify({ error: error ?? "unauthorized" }));
    };
    if (!token) {
      challenge();
      return;
    }
    try {
      const identity = await verifyWorkosAccessToken(token, { authkitDomain, resourceUrl });
      logger.info("oauth session", { sub: identity.sub, orgId: identity.orgId });
      // Forward the verified WorkOS JWT to the API as the bearer. The backend
      // accepts it as a third auth method and resolves the DePix App account linked
      // to this operator identity — or answers 403 oauth_account_not_linked when
      // no account is linked yet (the typed dead-end the tools surface). The
      // session is capped to read + merchant scopes server-side (never
      // wallet_write), so an OAuth connection can never move money. apiKey
      // already holds `token`; keep it and just mark the session mode.
      apiKey = token;
      authMode = "oauth";
    } catch (err) {
      if (err instanceof OAuthTokenError) {
        logger.info("oauth token rejected", { reason: err.message });
        challenge("invalid_token");
        return;
      }
      throw err;
    }
  }

  const server = createServer({
    apiKey,
    authMode,
    apiBase: resolveApiBase(),
    maxWaitSeconds: resolveMaxWaitSeconds(),
    version: resolveServerVersion(),
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // DNS-rebinding protection (official MCP guidance): reject requests whose
    // Host header is not ours. MCP_ALLOWED_HOSTS extends it for previews.
    enableDnsRebindingProtection: true,
    allowedHosts: resolveAllowedHosts(),
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}
