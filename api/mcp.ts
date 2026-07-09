// Vercel Function serving the MCP Streamable HTTP endpoint at /mcp
// (POST for requests, DELETE to end a session; GET returns 405 — this stateless
// server offers no standalone SSE stream, so an open GET would only pin the
// invocation until maxDuration while never delivering anything).
// Node.js runtime (not Edge) — the SDK and fetch fan-out run on Node (spec §2.5).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleMcpHttp } from "../src/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Pass req.body already-parsed by Vercel (spec §2.2 load-bearing note).
  await handleMcpHttp(req, res, req.body);
}
