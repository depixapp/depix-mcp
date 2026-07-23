// Support-ticket tools (SPEC_TICKETS §8): open / get / list / reply / close.
// PURE PROXIES over the backend /api/tickets endpoints (OpenAPI 0.17.0) — one
// channel for humans and agents, NO scope required. No business logic lives
// here: the backend owns the open-ticket cap, the compare-and-set state machine,
// ownership scoping and the 7-day reopen window. This module only builds the
// wire request and maps the response fields explicitly (never a blind
// passthrough), stripping any extra keys the API row might carry.
//
// There is deliberately NO wait_for_ticket tool: a human answers within ~1
// business day, which cannot be polled inside a tool budget — the agent polls
// get_support_ticket instead (spec §8).

import type { ApiClient } from "../apiClient.js";
import {
  buildAttachTicketBody,
  buildOpenTicketBody,
  buildReplyTicketBody,
  type AttachTicketArgs,
  type OpenTicketArgs,
  type ReplyTicketArgs,
} from "../requestMap.js";
import { deriveHasMore, unwrap } from "../normalize.js";
import { arr, numOrNull, rec, str, strOrNull } from "./access.js";

/** Map a backend ticket row to the tool shape (explicit fields; extras dropped). */
function normalizeTicket(raw: Record<string, unknown>) {
  return {
    id: str(raw.id),
    opener_type: str(raw.opener_type),
    status: str(raw.status),
    subject: str(raw.subject),
    category: str(raw.category),
    created_at: str(raw.created_at),
    last_activity_at: str(raw.last_activity_at),
    closed_reason: strOrNull(raw.closed_reason),
    closed_at: strOrNull(raw.closed_at),
  };
}

/** Map a backend ticket_messages row to the tool shape (explicit fields). */
function normalizeMessage(raw: Record<string, unknown>) {
  const att = rec(raw.attachment);
  return {
    id: str(raw.id),
    sender: str(raw.sender),
    body: str(raw.body),
    created_at: str(raw.created_at),
    // Present on every message (null for plain text). The bytes are forwarded to
    // support, never returned — only name/mime are exposed.
    attachment: raw.attachment ? { name: str(att.name), mime: strOrNull(att.mime) } : null,
  };
}

export async function openSupportTicket(client: ApiClient, args: OpenTicketArgs) {
  // No Idempotency-Key: the backend has no idempotency for ticket creation, and
  // sending one would make this POST auto-retryable — risking a duplicate ticket
  // against the 5-open cap. Without it the client never retries this write.
  const { data } = await client.request({
    method: "POST",
    path: "/api/tickets",
    body: buildOpenTicketBody(args),
    tool: "open_support_ticket",
  });
  return { ticket: normalizeTicket(rec(unwrap(data, "ticket"))) };
}

export async function getSupportTicket(client: ApiClient, args: { id: string }) {
  const { data } = await client.request({
    method: "GET",
    path: `/api/tickets/${encodeURIComponent(args.id)}`,
    tool: "get_support_ticket",
  });
  const d = rec(data);
  return {
    ticket: normalizeTicket(rec(d.ticket)),
    messages: arr(d.messages).map((m) => normalizeMessage(rec(m))),
  };
}

export async function listSupportTickets(client: ApiClient, args: { limit: number; offset: number }) {
  const { data } = await client.request({
    method: "GET",
    path: "/api/tickets",
    query: { limit: args.limit, offset: args.offset },
    tool: "list_support_tickets",
  });
  const d = rec(data);
  const tickets = arr(d.tickets).map((t) => normalizeTicket(rec(t)));
  const total = numOrNull(d.total) ?? tickets.length;
  const limit = numOrNull(d.limit) ?? args.limit;
  const offset = numOrNull(d.offset) ?? args.offset;
  return { tickets, total, limit, offset, has_more: deriveHasMore(offset, tickets.length, total) };
}

export async function replySupportTicket(client: ApiClient, args: ReplyTicketArgs) {
  const { data } = await client.request({
    method: "POST",
    path: `/api/tickets/${encodeURIComponent(args.id)}/messages`,
    body: buildReplyTicketBody(args),
    tool: "reply_support_ticket",
  });
  const d = rec(data);
  return {
    message: normalizeMessage(rec(d.message)),
    ticket: normalizeTicket(rec(d.ticket)),
  };
}

export async function closeSupportTicket(client: ApiClient, args: { id: string }) {
  const { data } = await client.request({
    method: "POST",
    path: `/api/tickets/${encodeURIComponent(args.id)}/close`,
    tool: "close_support_ticket",
  });
  return { ticket: normalizeTicket(rec(unwrap(data, "ticket"))) };
}

export async function attachSupportTicketFile(client: ApiClient, args: AttachTicketArgs) {
  // No Idempotency-Key (same reasoning as the other ticket writes): without it a
  // transient failure never auto-retries, so a large upload is never duplicated.
  const { data } = await client.request({
    method: "POST",
    path: `/api/tickets/${encodeURIComponent(args.id)}/attachments`,
    body: buildAttachTicketBody(args),
    tool: "attach_support_ticket_file",
  });
  const d = rec(data);
  return {
    message: normalizeMessage(rec(d.message)),
    ticket: normalizeTicket(rec(d.ticket)),
  };
}
