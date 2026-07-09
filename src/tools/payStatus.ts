// Pay-side status reads — READ-ONLY (spec §4.5). scope `wallet_read`. These do
// NOT move funds. There is no create_deposit / create_withdrawal in F2 (§1.4);
// an agent uses these with ids obtained elsewhere (SDK F3, dashboard, sandbox_*).

import type { ApiClient } from "../apiClient.js";
import { isTerminal } from "../normalize.js";
import {
  SANDBOX_WITHDRAWAL_STATUS,
  TERMINAL_DEPOSIT_STATUSES,
  TERMINAL_WITHDRAWAL_STATUSES,
} from "../schemas.js";
import { numOrNull, rec, str, strOrNull, stringArray } from "./access.js";

export async function getDepositStatus(client: ApiClient, args: { deposit_id: string }) {
  const { data } = await client.request({
    method: "GET",
    path: `/api/deposits/${encodeURIComponent(args.deposit_id)}`,
    tool: "get_deposit_status",
  });
  const d = rec(data);
  const status = str(d.status);
  return {
    id: str(d.id),
    type: "deposit" as const,
    amount_cents: numOrNull(d.amount_cents),
    status,
    terminal: isTerminal(status, TERMINAL_DEPOSIT_STATUSES),
    sandbox: d.sandbox === true,
    // Required non-nullable array on the agent surface; [] when not refused.
    rejection_reasons: stringArray(d.rejection_reasons),
    created_at: strOrNull(d.created_at),
    updated_at: strOrNull(d.updated_at),
  };
}

export async function getWithdrawalStatus(client: ApiClient, args: { withdrawal_id: string }) {
  const { data } = await client.request({
    method: "GET",
    path: `/api/withdrawals/${encodeURIComponent(args.withdrawal_id)}`,
    tool: "get_withdrawal_status",
  });
  const d = rec(data);
  const status = str(d.status);
  const out: {
    id: string;
    type: "withdraw";
    amount_cents: number | null;
    status: string;
    terminal: boolean;
    sandbox: boolean;
    liquid_txid?: string;
    created_at: string | null;
    updated_at: string | null;
  } = {
    id: str(d.id),
    type: "withdraw",
    amount_cents: numOrNull(d.amount_cents),
    status,
    // `confirmed` is the sandbox-only synthetic terminal success (spec §4.5).
    terminal: isTerminal(status, TERMINAL_WITHDRAWAL_STATUSES) || status === SANDBOX_WITHDRAWAL_STATUS,
    sandbox: d.sandbox === true,
    created_at: strOrNull(d.created_at),
    updated_at: strOrNull(d.updated_at),
  };
  const liquidTxid = strOrNull(d.liquid_txid);
  if (liquidTxid) out.liquid_txid = liquidTxid;
  return out;
}
