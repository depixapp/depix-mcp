// update_merchant_profile (§3.8) — PATCH /api/merchants/me with the 5 LIGHT
// profile fields (scope merchant_write). liquid_address/split_address are
// DELIBERATELY absent: they redirect money and are owner/admin-only, and the
// server rejects them here regardless — this tool never even offers them.

import type { ApiClient } from "../apiClient.js";
import { ToolError } from "../errors.js";
import { rec, str } from "./access.js";

export interface UpdateMerchantProfileArgs {
  business_name?: string;
  logo_url?: string;
  website?: string;
  default_redirect_url?: string;
  default_callback_url?: string;
}

// SDK snake_case → wire snake_case (the wire names happen to match). This map IS
// the allow-list: nothing outside it can be sent.
const LIGHT_FIELDS: Array<keyof UpdateMerchantProfileArgs> = [
  "business_name",
  "logo_url",
  "website",
  "default_redirect_url",
  "default_callback_url",
];

export async function updateMerchantProfile(client: ApiClient, args: UpdateMerchantProfileArgs) {
  const body: Record<string, unknown> = {};
  for (const field of LIGHT_FIELDS) {
    if (args[field] !== undefined) body[field] = args[field];
  }
  if (Object.keys(body).length === 0) {
    throw new ToolError(
      "Provide at least one profile field to change (business_name, logo_url, website, default_redirect_url, default_callback_url).",
      "validation_error",
      { data: { details: { field: "business_name" } } },
    );
  }
  const { data } = await client.request({
    method: "PATCH",
    path: "/api/merchants/me",
    body,
    tool: "update_merchant_profile",
  });
  const d = rec(data);
  return { merchant_slug: str(d.merchant_slug) };
}
