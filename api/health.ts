// Health endpoint (served at / and /api/health). Stage is "operational" now
// that the MCP server is live (spec §2.8).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveServerVersion } from "../src/config.js";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    service: "depix-mcp",
    status: "ok",
    stage: "operational",
    version: resolveServerVersion(),
    mcp_endpoint: "/mcp",
    transport: "streamable-http",
    docs: "https://depixapp.com/docs",
  });
}
