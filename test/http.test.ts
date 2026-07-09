// HTTP endpoint behavior: GET short-circuit (no SSE stream to offer, so 405 per
// the Streamable HTTP spec) and the Bearer extraction helper.

import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearer, handleMcpHttp } from "../src/http.js";

interface FakeRes {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  ended: boolean;
}

function makeRes(): { res: ServerResponse; state: FakeRes } {
  const state: FakeRes = { ended: false };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      state.statusCode = status;
      state.headers = headers;
      return res;
    },
    end(body?: string) {
      state.body = body;
      state.ended = true;
      return res;
    },
    on() {
      return res;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

describe("GET /mcp is 405 (stateless server offers no standalone SSE stream)", () => {
  it("short-circuits before the transport with Allow: POST, DELETE", async () => {
    const req = { method: "GET", headers: {} } as unknown as IncomingMessage;
    const { res, state } = makeRes();
    await handleMcpHttp(req, res, undefined);
    expect(state.statusCode).toBe(405);
    expect(state.headers?.Allow).toBe("POST, DELETE");
    expect(state.ended).toBe(true);
    // Body is valid JSON (JSON-RPC error shape).
    const body = JSON.parse(state.body ?? "{}");
    expect(body.error.code).toBe(-32000);
  });
});

describe("extractBearer", () => {
  it("extracts the raw token", () => {
    expect(extractBearer("Bearer sk_test_ABC")).toBe("sk_test_ABC");
    expect(extractBearer("bearer sk_live_x")).toBe("sk_live_x");
  });
  it("returns undefined for missing/malformed headers", () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer("Basic dXNlcjpwYXNz")).toBeUndefined();
  });
});
