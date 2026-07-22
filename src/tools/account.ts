// Account tool: get_account (GET /api/me) — also the quickstart "connection
// test" (spec §4.4). A 404 means "valid key, no merchant profile" (not 403);
// it is translated into an actionable message. The API never echoes the key's
// scopes and this tool does NOT synthesize them (spec §3.3, §4.4).

import type { ApiClient } from "../apiClient.js";
import { ToolError } from "../errors.js";
import { normalizeIsLive } from "../normalize.js";
import { rec, str, strOrNull } from "./access.js";

export async function getAccount(client: ApiClient) {
  let data: unknown;
  try {
    ({ data } = await client.request({ method: "GET", path: "/api/me", tool: "get_account" }));
  } catch (err) {
    if (err instanceof ToolError && (err.code === "not_found" || err.code === "merchant_required")) {
      throw new ToolError(
        "Your key is valid but has no merchant profile. Create one in the DePix App dashboard (this MCP cannot create merchants).",
        "merchant_required",
        { data: err.data },
      );
    }
    throw err;
  }
  const d = rec(data);
  return {
    merchant_id: str(d.merchant_id),
    name: str(d.name),
    username: strOrNull(d.username),
    merchant_slug: str(d.merchant_slug),
    is_live: normalizeIsLive(d),
    created_at: str(d.created_at),
  };
}
