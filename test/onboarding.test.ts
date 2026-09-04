// get_onboarding_status (§4.3): the narrated ladder, self-heal, the merchant
// 404 probe, the prepended wallet step-zero, and the __unknown fallback that
// keeps an unrecognized backend step from vanishing.

import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/apiClient.js";
import { getOnboardingStatus } from "../src/tools/onboarding.js";
import { makeFetch } from "./helpers/mockFetch.js";

const BASE = "https://api.depixapp.com";
const client = (responses: Parameters<typeof makeFetch>[0]) =>
  new ApiClient({ apiKey: "sk_test_ABC", apiBase: BASE, fetchImpl: makeFetch(responses).fetchImpl });

const step = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  state,
  target_cents: null,
  remaining_cents: null,
  target_days: null,
  remaining_days: null,
  ...extra,
});

describe("get_onboarding_status (§4.3)", () => {
  it("reads whatsapp_verified as the wire spells it (0/1), not booleans", async () => {
    for (const [wire, want] of [
      [1, "done"],
      [0, "pending"],
    ] as const) {
      const out = await getOnboardingStatus(
        client([
          { status: 200, json: { verified: false, enabled: true, whatsapp_verified: wire, steps: [] } },
          { status: 404, json: { error: { code: "not_found" } } },
        ]),
      );
      const wa = out.steps.find((s) => s.id === "whatsapp")!;
      expect(wa.state).toBe(want);
    }
  });

  it("unverified/no store: prepends the wallet step, includes WhatsApp, ends with merchant", async () => {
    const out = await getOnboardingStatus(
      client([
        {
          status: 200,
          json: {
            verified: false,
            enabled: true,
            method: "round_trip",
            eligible: false,
            steps: [
              step("deposit", "pending", { target_cents: 2000, remaining_cents: 2000 }),
              step("convert_lbtc", "unknown"),
              step("withdraw", "pending", { target_cents: 1500, remaining_cents: 1500 }),
            ],
          },
        },
        { status: 404, json: { error: { code: "not_found" } } }, // /api/me → no merchant
      ]),
    );

    expect(out.verified).toBe(false);
    expect(out.verification_enabled).toBe(true);
    expect(out.merchant_exists).toBe(false);
    expect(out.self_healed).toBe(false);
    const ids = out.steps.map((s) => s.id);
    // wallet is step-zero, whatsapp before deposit, merchant last.
    expect(ids).toEqual(["wallet", "whatsapp", "deposit", "convert_lbtc", "withdraw", "merchant"]);
    expect(out.next_step).toBe("wallet");
    // Step-zero must narrate without claiming knowledge the MCP does not have
    // (smoke S4.17): the wallet lives client-side, so its state is "unknown",
    // never "pending" or "done".
    const wallet = out.steps.find((s) => s.id === "wallet")!;
    expect(wallet.state).toBe("unknown");
    // Copy is bilingual and hardcoded in the MCP.
    const deposit = out.steps.find((s) => s.id === "deposit")!;
    expect(deposit.title.pt.length).toBeGreaterThan(0);
    expect(deposit.title.en.length).toBeGreaterThan(0);
    // The verification deposit deep link declares the Cofre exemption.
    expect(deposit.app_url).toContain("flow=verification");
    expect(deposit.numbers).toMatchObject({ target_cents: 2000, remaining_cents: 2000 });
  });

  it("eligible: self-heals by POSTing verification, then reports verified + store", async () => {
    const out = await getOnboardingStatus(
      client([
        {
          status: 200,
          json: {
            verified: false,
            enabled: true,
            method: "round_trip",
            eligible: true,
            steps: [step("deposit", "done"), step("convert_lbtc", "done"), step("withdraw", "done")],
          },
        },
        { status: 200, json: { verified: true } }, // POST /api/verification promotes
        { status: 200, json: { merchant_id: "mrc_1", merchant_slug: "acme" } }, // /api/me
      ]),
    );
    expect(out.self_healed).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.merchant_exists).toBe(true);
    // No wallet step once verified; merchant is done.
    expect(out.steps.map((s) => s.id)).not.toContain("wallet");
    expect(out.steps.find((s) => s.id === "merchant")!.state).toBe("done");
    expect(out.next_step).toBe("ready");
  });

  it("self-heal that is stuck (under review) surfaces a verification step, never fails the read", async () => {
    const out = await getOnboardingStatus(
      client([
        {
          status: 200,
          json: { verified: false, enabled: true, method: "round_trip", eligible: true, steps: [step("deposit", "done")] },
        },
        { status: 409, json: { error: { code: "verification_requirements_not_met" } } }, // POST rejected
        { status: 404, json: { error: { code: "not_found" } } },
      ]),
    );
    expect(out.self_healed).toBe(false);
    expect(out.verified).toBe(false);
    expect(out.steps.map((s) => s.id)).toContain("verification");
  });

  it("an UNKNOWN backend step id falls back to __unknown copy — it never vanishes", async () => {
    const out = await getOnboardingStatus(
      client([
        {
          status: 200,
          json: {
            verified: false,
            enabled: true,
            method: "round_trip",
            eligible: false,
            steps: [step("a_brand_new_backend_step", "pending")],
          },
        },
        { status: 404, json: { error: { code: "not_found" } } },
      ]),
    );
    const unknown = out.steps.find((s) => s.id === "a_brand_new_backend_step");
    expect(unknown).toBeDefined();
    // It kept its real id but used the __unknown copy (so it is still narratable).
    expect(unknown!.title.en.length).toBeGreaterThan(0);
    expect(unknown!.state).toBe("pending");
  });

  it("an AGENT account (domain method) shows the domain step, not WhatsApp", async () => {
    const out = await getOnboardingStatus(
      client([
        {
          status: 200,
          json: { verified: false, enabled: true, method: "domain", eligible: false, steps: [step("domain_proof", "pending")] },
        },
        { status: 404, json: { error: { code: "not_found" } } },
      ]),
    );
    const ids = out.steps.map((s) => s.id);
    expect(ids).toContain("domain_proof");
    expect(ids).not.toContain("whatsapp");
  });
});
