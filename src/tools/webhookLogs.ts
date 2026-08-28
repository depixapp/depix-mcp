// list_webhook_logs (§3.8) — GET /api/webhook-logs (list) and /api/webhook-logs/:id
// (one delivery). Read-only: did the webhook arrive, and what did the endpoint
// answer? Newest first.
//
// The backend route is auth "jwt-or-api" with scope merchant_read (§3.9b), so a
// key or the OAuth-forwarded credential this gateway uses both reach it. The
// Ed25519 agent has its own twin at /api/agents/webhook-logs.

import type { ApiClient } from "../apiClient.js";
import { arr, numOrNull, rec, str, strOrNull } from "./access.js";

function logToOutput(l: Record<string, unknown>) {
  return {
    id: str(l.id),
    checkout_id: strOrNull(l.checkout_id),
    event: str(l.event),
    url: strOrNull(l.url),
    status_code: numOrNull(l.status_code),
    error: strOrNull(l.error),
    attempt: numOrNull(l.attempt),
    sent_at: strOrNull(l.sent_at),
  };
}

export async function listWebhookLogs(client: ApiClient, args: { id?: string }) {
  if (args.id !== undefined) {
    const { data } = await client.request({
      method: "GET",
      path: `/api/webhook-logs/${encodeURIComponent(args.id)}`,
      tool: "list_webhook_logs",
    });
    const d = rec(data);
    // Detail may return the row directly or under a `log` key — handle both.
    const log = rec(d.log ?? d);
    return { logs: [logToOutput(log)] };
  }
  const { data } = await client.request({ method: "GET", path: "/api/webhook-logs", tool: "list_webhook_logs" });
  const d = rec(data);
  return { logs: arr(d.logs).map((l) => logToOutput(rec(l))) };
}
