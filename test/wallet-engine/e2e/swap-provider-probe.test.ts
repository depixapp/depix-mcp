// ─────────────────────────────────────────────────────────────────────────────
// LIVE probe check — OPT-IN, read-only, moves nothing.
//
// The whole provider fallback rests on one claim: a backend with swap creation
// switched off can only be told apart by the MESSAGE its creation path returns,
// because a GET answers 200 with a healthy-looking pair matrix either way. That
// claim is about PRODUCTION behaviour, so the unit suite can only assert our
// parsing of a canned string. This harness checks the real thing.
//
// What it sends: exactly what probeProvider sends — a reverse-swap creation for
// 1 sat. Every known backend rejects that below its minimum (Boltz's is 25_000)
// before creating anything, and the preimage hash is random with no known
// preimage, so even a hypothetical acceptance would be a hold invoice that can
// never settle and locks nothing. No key, no funds, no account.
//
// Run it with:
//     RUN_PROVIDER_PROBE=1 npx vitest run test/wallet-engine/e2e/swap-provider-probe.test.ts
//
// It asserts only that each host gives a DECIDABLE answer and reports which —
// never that a particular backend is up, since that is exactly what changes.
import { describe, expect, it } from "vitest";
import {
  SWAP_PROVIDERS,
  probeProvider
} from "../../../src/wallet-engine/convert/boltz/providers.js";

const RUN = process.env.RUN_PROVIDER_PROBE === "1";

describe.skipIf(!RUN)("live swap-provider probe (opt-in, read-only)", () => {
  for (const provider of SWAP_PROVIDERS) {
    it(`${provider.name} answers the creation path decidably`, async () => {
      const live = await probeProvider(provider);
      expect(typeof live).toBe("boolean");
      console.log(`[probe] ${provider.name} (${provider.apiUrl}) creating swaps: ${live}`);
    });
  }

  it("at least one provider is creating swaps — otherwise Lightning is down for everyone", async () => {
    const results = await Promise.all(SWAP_PROVIDERS.map((p) => probeProvider(p)));
    expect(results.some(Boolean)).toBe(true);
  });
});
