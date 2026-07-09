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
  resolveMaxWaitSeconds,
  resolveServerVersion,
} from "./config.js";

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

  const apiKey = extractBearer(req.headers.authorization);

  const server = createServer({
    apiKey,
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
