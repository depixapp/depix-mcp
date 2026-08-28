// The next_action catalog (§5.1 / D13): every agent-facing code in the map has a
// next_action, its `kind` is in the closed set, `relay` is present IFF the kind
// is human_step (with both PT and EN), there is exactly one action per error, and
// the deployment-sensitive missing_api_key branches resolve as §5.1 specifies.

import { describe, expect, it } from "vitest";
import { NEXT_ACTION_KINDS, nextActionFor, withNextAction } from "../src/next-action.js";
import { mapApiError } from "../src/errors.js";
import { mapToolError } from "../src/wallet-engine/mcp/errors.js";
import { AgentError, DepixApiError } from "../src/wallet-engine/errors.js";

// The §5.1 map — the codes the builder covers that the local/gateway tools reach.
const MAPPED_CODES = [
  "missing_api_key",
  "credentials_locked",
  "api_key_required",
  "wallet_not_configured",
  "invalid_operator_token",
  "operator_token_revoked",
  "operator_oauth_failed",
  "oauth_account_not_linked",
  "merchant_required",
  "verification_required",
  "verification_requirements_not_met",
  "verification_under_review",
  "verification_tax_number_in_use",
  "verification_unavailable",
  "insufficient_scope",
  "live_access_required",
  "graduation_pending",
  "domain_required",
  "domain_txt_not_found",
  "registration_blocked",
  "account_blocked",
  "account_suspended",
  "agents_disabled",
  "rate_limited",
  "operator_register_cap_exceeded",
  "agent_pubkey_exists",
  "username_taken",
];

describe("next_action catalog (§5.1)", () => {
  it("has a next_action with a valid shape for every mapped code", () => {
    for (const code of MAPPED_CODES) {
      const action = nextActionFor(code, { deployment: "local", retryAfterSeconds: 30 });
      expect(action, `missing next_action for ${code}`).toBeDefined();
      // kind is in the closed set of 5.
      expect(NEXT_ACTION_KINDS).toContain(action!.kind);
      // relay is present IFF human_step, and then carries BOTH languages.
      if (action!.kind === "human_step") {
        expect(action!.relay, `human_step ${code} needs relay`).toBeDefined();
        expect(typeof action!.relay!.pt).toBe("string");
        expect(typeof action!.relay!.en).toBe("string");
        expect(action!.relay!.pt.length).toBeGreaterThan(0);
        expect(action!.relay!.en.length).toBeGreaterThan(0);
      } else {
        expect(action!.relay, `${code} (${action!.kind}) must not carry relay`).toBeUndefined();
      }
      // call_tool carries a tool name.
      if (action!.kind === "call_tool") expect(typeof action!.tool).toBe("string");
    }
  });

  it("returns undefined for an unmapped code", () => {
    expect(nextActionFor("some_unmapped_code")).toBeUndefined();
  });

  it("missing_api_key branches by deployment/authMode (§5.1)", () => {
    // hosted, no bearer → human_step (signup)
    expect(nextActionFor("missing_api_key", { deployment: "hosted" })).toMatchObject({ kind: "human_step" });
    // OAuth session lost its bearer → reconnect
    expect(nextActionFor("missing_api_key", { authMode: "oauth" })).toMatchObject({ kind: "reconnect" });
    // local (npx) → mint the key in-process
    expect(nextActionFor("missing_api_key", { deployment: "local" })).toEqual({
      kind: "call_tool",
      tool: "register_account",
    });
  });

  it("wait actions mirror retry_after only (never invent it)", () => {
    expect(nextActionFor("rate_limited", { retryAfterSeconds: 42 })).toEqual({
      kind: "wait",
      retry_after_seconds: 42,
    });
    expect(nextActionFor("rate_limited")).toEqual({ kind: "wait" });
  });

  it("the ladder codes point the agent at get_onboarding_status / verify_domain", () => {
    expect(nextActionFor("merchant_required")).toMatchObject({ kind: "call_tool", tool: "get_onboarding_status" });
    expect(nextActionFor("verification_required")).toMatchObject({ kind: "call_tool", tool: "get_onboarding_status" });
    expect(nextActionFor("domain_required")).toMatchObject({ kind: "call_tool", tool: "verify_domain" });
    expect(nextActionFor("graduation_pending")).toMatchObject({ kind: "call_tool", tool: "verify_domain" });
  });

  describe("withNextAction", () => {
    it("attaches next_action + docs_url for a mapped code", () => {
      const data = withNextAction({}, "merchant_required");
      expect(data.next_action).toMatchObject({ kind: "call_tool", tool: "get_onboarding_status" });
      expect(typeof data.docs_url).toBe("string");
    });

    it("never overwrites a next_action an error factory already set", () => {
      const preset = { next_action: { kind: "human_step", relay: { pt: "x", en: "y" } } };
      const data = withNextAction({ ...preset }, "merchant_required");
      expect(data.next_action).toEqual(preset.next_action);
    });

    it("leaves an unmapped code untouched", () => {
      const data = withNextAction({}, "totally_unknown");
      expect(data.next_action).toBeUndefined();
      expect(data.docs_url).toBeUndefined();
    });
  });

  describe("both error mappers attach next_action (§5.1 wiring)", () => {
    it("the gateway mapApiError attaches it, mirroring retry_after", () => {
      const merchant = mapApiError(403, { error: { code: "merchant_required" } });
      expect(merchant.data.next_action).toMatchObject({ kind: "call_tool", tool: "get_onboarding_status" });

      const limited = mapApiError(429, { error: { code: "rate_limited", retry_after: 12 } });
      expect(limited.data.next_action).toEqual({ kind: "wait", retry_after_seconds: 12 });
    });

    it("the wallet mapToolError attaches it for a server-side agent code (DepixApiError)", () => {
      const err = mapToolError(new DepixApiError("graduation_pending", "not graduated", { status: 403 }));
      expect(err.data.next_action).toMatchObject({ kind: "call_tool", tool: "verify_domain" });
    });

    it("the wallet mapToolError surfaces an AgentError as its own code, not a provider error", () => {
      const err = mapToolError(new AgentError("agent_already_initialized", "already exists"));
      expect(err.code).toBe("agent_already_initialized");
      // SDK-authored message surfaces verbatim (not the canned 'Upstream provider error').
      expect(err.message).toBe("already exists");
      expect(err.data.untrusted_api_message).toBeUndefined();
    });
  });
});
