// /.well-known/mcp.json publishes the closed-sum catalog breakdown of BOTH levels.
// Those numbers are literals in a hosted file that must stay engine-free, so the
// tripwire lives here: the served document must agree with the source lists.

import { describe, expect, it } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "../api/well-known-mcp.js";
import { GATEWAY_TOOL_COUNT } from "../src/server.js";
import { UNIFIED_TOOL_COUNT } from "../src/unified.js";
import { WALLET_TOOL_NAMES } from "../src/wallet-engine/mcp/server.js";
import { AGENT_TOOL_NAMES } from "../src/agent-tools.js";

function makeRes(): { res: VercelResponse; body: () => unknown } {
  let captured: unknown;
  const res = {
    setHeader() {
      return res;
    },
    status() {
      return res;
    },
    json(body: unknown) {
      captured = body;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as VercelResponse;
  return { res, body: () => captured };
}

describe("/.well-known/mcp.json counts follow the catalog", () => {
  it("hosted + local breakdown equals the source lists", () => {
    const { res, body } = makeRes();
    handler({} as VercelRequest, res);
    const doc = body() as {
      description: string;
      levels: {
        hosted: { tool_count: number };
        local: { tool_count: number; tool_count_gateway: number; tool_count_wallet: number; tool_count_local: number };
      };
    };
    expect(doc.levels.hosted.tool_count).toBe(GATEWAY_TOOL_COUNT);
    expect(doc.levels.local.tool_count_gateway).toBe(GATEWAY_TOOL_COUNT);
    expect(doc.levels.local.tool_count_wallet).toBe(WALLET_TOOL_NAMES.length);
    expect(doc.levels.local.tool_count_local).toBe(AGENT_TOOL_NAMES.length);
    expect(doc.levels.local.tool_count).toBe(UNIFIED_TOOL_COUNT);
    expect(doc.description).toContain(`${UNIFIED_TOOL_COUNT} in total`);
    expect(doc.description).toContain(`${AGENT_TOOL_NAMES.length} agent-local`);
  });
});
