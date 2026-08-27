// get_vault_status (§3.8) — GET /api/vault/status (scope wallet_read). Read-only:
// the account's position in the Cofre (deposit-hold) mechanism — the trust level,
// the rolling receive cap and how much is left, and how long a new deposit is
// held. Reshapes the known fields; the mechanism's on/off state comes first
// because every number is meaningless when the Cofre is switched off.

import type { ApiClient } from "../apiClient.js";
import { numOrNull, rec, strOrNull } from "./access.js";

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export async function getVaultStatus(client: ApiClient) {
  const { data } = await client.request({ method: "GET", path: "/api/vault/status", tool: "get_vault_status" });
  const d = rec(data);
  const level = rec(d.level);
  const cap = rec(d.cap);
  return {
    vault_active: d.vault_active === true,
    vault_window_hours: numOrNull(d.vault_window_hours),
    level: {
      current: numOrNull(level.current),
      max: numOrNull(level.max),
      eligible: numOrNull(level.eligible),
      pinned: boolOrNull(level.pinned) ?? false,
      frozen_until: strOrNull(level.frozen_until),
    },
    cap: {
      enforced: boolOrNull(cap.enforced) ?? false,
      cents: numOrNull(cap.cents),
      used_cents: numOrNull(cap.used_cents),
      available_cents: numOrNull(cap.available_cents),
      window_days: numOrNull(cap.window_days),
      resets_at: strOrNull(cap.resets_at),
      first_deposit_pending: boolOrNull(cap.first_deposit_pending) ?? false,
    },
  };
}
