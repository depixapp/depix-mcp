// Support-ticket tools (SPEC_TICKETS §8) — pure proxies over the backend
// /api/tickets endpoints. Mirrors tools-checkouts.test.ts: mocks fetch, asserts
// the outgoing path/method/body + the explicit output mapping, and checks that
// no request carries a Bearer other than the caller's key.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiClient } from "../src/apiClient.js";
import {
  closeSupportTicket,
  getSupportTicket,
  listSupportTickets,
  openSupportTicket,
  replySupportTicket,
} from "../src/tools/tickets.js";
import * as s from "../src/schemas.js";
import { makeFetch, type MockResponseSpec } from "./helpers/mockFetch.js";

const BASE = "https://api.depixapp.com";
const KEY = "sk_test_ABC";

function makeClient(specs: MockResponseSpec[]) {
  const { fetchImpl, requests } = makeFetch(specs);
  return {
    client: new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl, sleep: async () => {} }),
    requests,
  };
}

const TICKET = {
  id: "tkt_ab12cd34ef",
  opener_type: "human",
  status: "awaiting_reply",
  subject: "Não recebi meu depósito",
  category: "payment",
  created_at: "2026-07-22 12:00:00",
  last_activity_at: "2026-07-22 12:00:00",
  closed_reason: null,
  closed_at: null,
};

describe("open_support_ticket (spec §8)", () => {
  it("POSTs subject/category/body to /api/tickets and normalizes { ticket }", async () => {
    const { client, requests } = makeClient([{ status: 201, json: { ticket: TICKET } }]);
    const out = await openSupportTicket(client, {
      subject: "Não recebi meu depósito",
      category: "payment",
      body: "Paguei o Pix mas o DePix não chegou.",
    });
    const req = requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/api/tickets`);
    const body = JSON.parse(req.body!);
    expect(body).toEqual({
      subject: "Não recebi meu depósito",
      category: "payment",
      body: "Paguei o Pix mas o DePix não chegou.",
    });
    // Tickets have no server-side idempotency — the proxy must NOT invent a key
    // (that would flip the POST to retry-safe and risk a double-create).
    expect(req.headers["Idempotency-Key"]).toBeUndefined();
    expect(out).toEqual({ ticket: TICKET });
    expect(z.object(s.openSupportTicketOutput).safeParse(out).success).toBe(true);
  });

  it("omits category from the wire body when not provided", async () => {
    const { client, requests } = makeClient([
      { status: 201, json: { ticket: { ...TICKET, category: "other" } } },
    ]);
    await openSupportTicket(client, { subject: "Erro estranho", body: "Algo quebrou." });
    const body = JSON.parse(requests[0].body!);
    expect(body).toEqual({ subject: "Erro estranho", body: "Algo quebrou." });
    expect(body).not.toHaveProperty("category");
  });

  it("forwards ONLY the caller's Bearer, verbatim", async () => {
    const { client, requests } = makeClient([{ status: 201, json: { ticket: TICKET } }]);
    await openSupportTicket(client, { subject: "Assunto", body: "Corpo da mensagem." });
    expect(requests[0].headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("get_support_ticket (spec §8)", () => {
  it("GETs /api/tickets/:id and maps ticket + messages explicitly", async () => {
    const { client, requests } = makeClient([
      {
        status: 200,
        json: {
          ticket: TICKET,
          messages: [
            {
              id: "tmsg_1",
              sender: "user",
              body: "Paguei o Pix mas o DePix não chegou.",
              created_at: "2026-07-22 12:00:00",
              // An unexpected extra field must be dropped (no blind passthrough).
              tg_update_id: 999,
            },
            {
              id: "tmsg_2",
              sender: "admin",
              body: "Já estamos verificando.",
              created_at: "2026-07-22 13:00:00",
            },
          ],
        },
      },
    ]);
    const out = await getSupportTicket(client, { id: "tkt_ab12cd34ef" });
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe(`${BASE}/api/tickets/tkt_ab12cd34ef`);
    expect(out.ticket).toEqual(TICKET);
    expect(out.messages).toEqual([
      { id: "tmsg_1", sender: "user", body: "Paguei o Pix mas o DePix não chegou.", created_at: "2026-07-22 12:00:00" },
      { id: "tmsg_2", sender: "admin", body: "Já estamos verificando.", created_at: "2026-07-22 13:00:00" },
    ]);
    expect((out.messages[0] as Record<string, unknown>).tg_update_id).toBeUndefined();
    expect(z.object(s.getSupportTicketOutput).safeParse(out).success).toBe(true);
  });
});

describe("list_support_tickets (spec §8)", () => {
  it("GETs /api/tickets with limit/offset and derives has_more from total", async () => {
    const { client, requests } = makeClient([
      {
        status: 200,
        json: {
          tickets: [TICKET, { ...TICKET, id: "tkt_zz99", status: "closed", closed_reason: "user", closed_at: "2026-07-22 15:00:00" }],
          total: 5,
          limit: 2,
          offset: 0,
        },
      },
    ]);
    const out = await listSupportTickets(client, { limit: 2, offset: 0 });
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe(`${BASE}/api/tickets?limit=2&offset=0`);
    expect(out.tickets).toHaveLength(2);
    expect(out.total).toBe(5);
    expect(out.has_more).toBe(true); // 0 + 2 < 5
    expect(z.object(s.listSupportTicketsOutput).safeParse(out).success).toBe(true);
  });

  it("has_more is false on the last page", async () => {
    const { client } = makeClient([
      { status: 200, json: { tickets: [TICKET], total: 1, limit: 50, offset: 0 } },
    ]);
    const out = await listSupportTickets(client, { limit: 50, offset: 0 });
    expect(out.has_more).toBe(false);
  });
});

describe("reply_support_ticket (spec §8)", () => {
  it("POSTs { body } only to /api/tickets/:id/messages (id is a path param, not a body field)", async () => {
    const answered = { ...TICKET, status: "answered", last_activity_at: "2026-07-22 14:00:00" };
    const message = { id: "tmsg_3", sender: "user", body: "Segue o comprovante.", created_at: "2026-07-22 14:00:00" };
    const { client, requests } = makeClient([{ status: 201, json: { message, ticket: answered } }]);
    const out = await replySupportTicket(client, { id: "tkt_ab12cd34ef", body: "Segue o comprovante." });
    const req = requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/api/tickets/tkt_ab12cd34ef/messages`);
    const body = JSON.parse(req.body!);
    expect(body).toEqual({ body: "Segue o comprovante." });
    expect(body).not.toHaveProperty("id");
    expect(out).toEqual({ message, ticket: answered });
    expect(z.object(s.replySupportTicketOutput).safeParse(out).success).toBe(true);
  });
});

describe("close_support_ticket (spec §8)", () => {
  it("POSTs to /api/tickets/:id/close (no body) and returns { ticket }", async () => {
    const closed = { ...TICKET, status: "closed", closed_reason: "user", closed_at: "2026-07-22 16:00:00" };
    const { client, requests } = makeClient([{ status: 200, json: { ticket: closed } }]);
    const out = await closeSupportTicket(client, { id: "tkt_ab12cd34ef" });
    const req = requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/api/tickets/tkt_ab12cd34ef/close`);
    expect(req.body).toBeUndefined();
    expect(out).toEqual({ ticket: closed });
    expect(z.object(s.closeSupportTicketOutput).safeParse(out).success).toBe(true);
  });
});

describe("ticket input schema validation (spec §8 / backend contract)", () => {
  const openSchema = z.object(s.openSupportTicketInput);

  it("accepts each category in the enum", () => {
    for (const category of ["bug", "question", "account", "payment", "other"]) {
      expect(openSchema.safeParse({ subject: "Assunto", body: "Corpo", category }).success).toBe(true);
    }
  });

  it("rejects a category outside the enum", () => {
    expect(openSchema.safeParse({ subject: "Assunto", body: "Corpo", category: "urgent" }).success).toBe(false);
  });

  it("accepts an omitted category (optional, defaults server-side)", () => {
    expect(openSchema.safeParse({ subject: "Assunto", body: "Corpo" }).success).toBe(true);
  });

  it("enforces subject 4–120 and body 1–4000", () => {
    expect(openSchema.safeParse({ subject: "abc", body: "Corpo" }).success).toBe(false); // subject < 4
    expect(openSchema.safeParse({ subject: "a".repeat(121), body: "Corpo" }).success).toBe(false); // subject > 120
    expect(openSchema.safeParse({ subject: "Assunto", body: "" }).success).toBe(false); // body < 1
    expect(openSchema.safeParse({ subject: "Assunto", body: "x".repeat(4001) }).success).toBe(false); // body > 4000
  });

  it("get/reply/close ids must be tkt_-prefixed", () => {
    expect(z.object(s.getSupportTicketInput).safeParse({ id: "tkt_1" }).success).toBe(true);
    expect(z.object(s.getSupportTicketInput).safeParse({ id: "chk_1" }).success).toBe(false);
    expect(z.object(s.replySupportTicketInput).safeParse({ id: "tkt_1", body: "oi" }).success).toBe(true);
    expect(z.object(s.closeSupportTicketInput).safeParse({ id: "nope" }).success).toBe(false);
  });
});
