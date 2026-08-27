// list_webhook_logs (§3.8) — GET /api/webhook-logs (list) and /api/webhook-logs/:id
// (one delivery). Read-only: did the webhook arrive, and what did the endpoint
// answer? Newest first.
//
// REACHABILITY (documented divergence): on origin/main the backend exposes webhook
// logs at /api/webhook-logs (auth "jwt", app dashboard) and /api/agents/webhook-logs
// (auth "agent-key", the Ed25519 agent). NEITHER accepts an sk_ API key or the
// OAuth-forwarded WorkOS JWT this gateway uses — so until a jwt-or-api variant
// lands on the backend (F4), this tool surfaces a typed unauthorized/invalid_token
// (with its next_action) rather than a log list. The tool + schema are shipped now
// so the catalog is complete and the client is ready the moment the route is.

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
