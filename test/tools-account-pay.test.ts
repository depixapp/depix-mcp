import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiClient } from "../src/apiClient.js";
import { getAccount } from "../src/tools/account.js";
import { getDepositStatus, getWithdrawalStatus } from "../src/tools/payStatus.js";
import * as s from "../src/schemas.js";
import { makeFetch, errorEnvelope, type MockResponseSpec } from "./helpers/mockFetch.js";

const BASE = "https://api.depixapp.com";
const KEY = "sk_test_ABC";

function makeClient(specs: MockResponseSpec[]) {
  const { fetchImpl, requests } = makeFetch(specs);
  return {
    client: new ApiClient({ apiKey: KEY, apiBase: BASE, fetchImpl, sleep: async () => {} }),
    requests,
  };
}

describe("get_account (spec §4.4)", () => {
  it("returns the merchant with is_live normalized; no scopes field", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          merchant_id: "mrc_1",
          name: "Loja Teste",
          username: "owner",
          merchant_slug: "loja-teste",
          is_live: false,
          created_at: "2026-01-01 00:00:00",
        },
      },
    ]);
    const out = await getAccount(client);
    expect(out).toMatchObject({ merchant_id: "mrc_1", is_live: false });
    expect(out).not.toHaveProperty("scopes");
    expect(z.object(s.getAccountOutput).safeParse(out).success).toBe(true);
  });

  it("translates a 404 into an actionable 'no merchant profile' error", async () => {
    const { client } = makeClient([{ status: 404, json: errorEnvelope("not_found", { request_id: "req_1" }) }]);
    await expect(getAccount(client)).rejects.toMatchObject({
      code: "merchant_required",
    });
  });
});

describe("get_deposit_status (spec §4.5)", () => {
  it("derives terminal, surfaces rejection_reasons, marks sandbox", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          id: "sandbox_dep_1",
          type: "deposit",
          amount_cents: 5000,
          status: "depix_sent",
          created_at: "2026-07-01 12:00:00",
          updated_at: "2026-07-01 12:00:00",
          sandbox: true,
          rejection_reasons: [],
        },
      },
    ]);
    const out = await getDepositStatus(client, { deposit_id: "sandbox_dep_1" });
    expect(out).toMatchObject({
      type: "deposit",
      status: "depix_sent",
      terminal: true,
      sandbox: true,
      rejection_reasons: [],
    });
    expect(z.object(s.getDepositStatusOutput).safeParse(out).success).toBe(true);
  });

  it("surfaces provider rejection reasons on a non-success terminal state", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          id: "dep_2",
          type: "deposit",
          amount_cents: 10000,
          status: "refunded",
          created_at: "2026-07-01 12:00:00",
          updated_at: "2026-07-01 12:05:00",
          rejection_reasons: ["PAYER_MISMATCH", "HIGH_VELOCITY"],
        },
      },
    ]);
    const out = await getDepositStatus(client, { deposit_id: "dep_2" });
    expect(out.terminal).toBe(true);
    expect(out.sandbox).toBe(false);
    expect(out.rejection_reasons).toEqual(["PAYER_MISMATCH", "HIGH_VELOCITY"]);
  });
});

describe("get_withdrawal_status (spec §4.5)", () => {
  it("treats sandbox 'confirmed' as terminal and omits liquid_txid when absent", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          id: "sandbox_wd_1",
          type: "withdraw",
          amount_cents: 5000,
          status: "confirmed",
          created_at: "2026-07-01 12:00:00",
          updated_at: "2026-07-01 12:00:00",
          sandbox: true,
        },
      },
    ]);
    const out = await getWithdrawalStatus(client, { withdrawal_id: "sandbox_wd_1" });
    expect(out).toMatchObject({ status: "confirmed", terminal: true, sandbox: true });
    expect(out).not.toHaveProperty("liquid_txid");
    expect(z.object(s.getWithdrawalStatusOutput).safeParse(out).success).toBe(true);
  });

  it("includes liquid_txid when present on a live terminal row", async () => {
    const { client } = makeClient([
      {
        status: 200,
        json: {
          id: "wd_2",
          type: "withdraw",
          amount_cents: 5000,
          status: "sent",
          created_at: "2026-07-01 12:00:00",
          updated_at: "2026-07-01 12:05:00",
          liquid_txid: "ab".repeat(32),
        },
      },
    ]);
    const out = await getWithdrawalStatus(client, { withdrawal_id: "wd_2" });
    expect(out.terminal).toBe(true);
    expect(out.liquid_txid).toBe("ab".repeat(32));
  });
});
