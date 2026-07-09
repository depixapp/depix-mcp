#!/usr/bin/env node
// Local stdio mode (spec §3.4, gate decision 2026-07-09). The SAME server runs
// over a stdio transport for Claude Desktop and other local hosts: read the key
// from DEPIX_API_KEY (env), never a flag, and it becomes the same Bearer header
// on every API call. `npx depix-mcp` runs this. STDOUT is the JSON-RPC channel;
// everything human goes to STDERR.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { resolveApiBase, resolveMaxWaitSeconds, resolveServerVersion } from "./config.js";
import { logger, redact } from "./log.js";

async function main(): Promise<void> {
  const apiKey = process.env.DEPIX_API_KEY;
  if (!apiKey || !apiKey.startsWith("sk_")) {
    process.stderr.write(
      "depix-mcp: set DEPIX_API_KEY to your DePix API key (sk_test_… for sandbox, sk_live_… for production).\n",
    );
    process.exit(1);
  }

  const version = resolveServerVersion();
  const server = createServer({
    apiKey,
    apiBase: resolveApiBase(),
    maxWaitSeconds: resolveMaxWaitSeconds(),
    version,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio_started", { version });
}

main().catch((err: unknown) => {
  // Redact defensively — a fatal error message must never carry the key.
  process.stderr.write(redact(`depix-mcp: fatal error: ${String(err)}`) + "\n");
  process.exit(1);
});
