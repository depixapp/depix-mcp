// The wallet half must authenticate with the SAME credential as the gateway half.
//
// The bug this pins: `DepixWallet.open()` used to be called without apiKey, so
// an agent that self-registered — its sk_ living ENCRYPTED in the credential
// store and never in the environment — got API_KEY_REQUIRED on
// deposit()/withdraw() while every gateway tool worked. Since 2.8.6 the wallet
// receives a FUNCTION the engine reads on every request, so a key that appears
// or changes mid-session is in force on the next call — no re-open. These tests
// drive the real CredentialResolver through the real opener and runtime; only
// the engine is a fake that records what it was opened with.

import { describe, expect, it } from "vitest";
import { CredentialResolver } from "../src/credentials.js";
import {
  createWalletOpener,
  createWalletRuntime,
  walletApiKey,
  type OpenedWallet,
  type WalletEngineModule,
  type WalletOpenOptions,
} from "../src/unified.js";

const API = "https://api.depixapp.com";

/** A fake engine that records every open() and every close(). */
function spyEngine() {
  const opens: WalletOpenOptions[] = [];
  let closed = 0;
  const wallet = {
    resumePendingWithdrawals: async () => ({ resumed: 0, rebroadcast: 0, reposted: 0, discarded: 0, failed: 0 }),
    resumePendingConversions: async () => ({
      boltz: null,
      pegin: { pending: 0, cleared: 0, failed: 0 },
      sideshift: { checked: 0, refreshed: 0, failed: 0 },
      plans: { checked: 0, advanced: 0, completed: 0, needsReview: 0, discarded: 0, failed: 0 },
    }),
    close: async () => {
      closed += 1;
    },
  } as never as OpenedWallet;
  const load = async (): Promise<WalletEngineModule> => ({
    DepixWallet: {
      open: async (options) => {
        opens.push(options);
        return wallet;
      },
    },
  });
  return { opens, load, closedCount: () => closed };
}

/** What the engine would see if it read the credential right now. */
function keyInForce(options: WalletOpenOptions | undefined): string | undefined {
  const source = options?.apiKey;
  return typeof source === "function" ? source() : source;
}

function runtimeFor(credentials: CredentialResolver, apiBase = API) {
  const engine = spyEngine();
  const credential = () => walletApiKey(credentials.resolveCredential());
  const runtime = createWalletRuntime({
    open: createWalletOpener({ resolveApiKey: credential, apiBase, load: engine.load }),
  });
  return { runtime, ...engine };
}

describe("the wallet is handed the resolved credential as a function", () => {
  it("the STORED agent key is in force when the environment has none (the self-onboarding path)", async () => {
    const credentials = new CredentialResolver({ envKey: undefined });
    credentials.setActiveKey("sk_live_from_store");
    const { runtime, opens } = runtimeFor(credentials);

    await runtime.getWallet();

    expect(opens).toHaveLength(1);
    expect(typeof opens[0]?.apiKey).toBe("function");
    expect(keyInForce(opens[0])).toBe("sk_live_from_store");
    // The auto-resume flags are the engine bin's contract and must survive.
    expect(opens[0]?.resumePendingWithdrawalsOnOpen).toBe(false);
    expect(opens[0]?.resumePendingConversionsOnOpen).toBe(false);
  });

  it("the environment key wins over the store, matching the gateway's precedence", async () => {
    const credentials = new CredentialResolver({ envKey: "sk_live_from_env" });
    credentials.setActiveKey("sk_live_from_store");
    const { runtime, opens } = runtimeFor(credentials);
    await runtime.getWallet();
    expect(keyInForce(opens[0])).toBe("sk_live_from_env");
  });

  it("keeps the wallet keyless under the owner login — an access token is not an API key", () => {
    const credentials = new CredentialResolver({ envKey: undefined });
    credentials.setOwnerToken("eyJhbGciOi.owner-access-token.sig");
    expect(credentials.resolveCredential()).toEqual({ token: "eyJhbGciOi.owner-access-token.sig", kind: "oauth" });
    expect(walletApiKey(credentials.resolveCredential())).toBeUndefined();
  });

  it("answers undefined for a non-allowlisted DEPIX_API_BASE, even with an env key — no fallback behind it", async () => {
    const credentials = new CredentialResolver({ envKey: "sk_live_from_env" });
    const attacker = runtimeFor(credentials, "https://attacker.example");
    await attacker.runtime.getWallet();
    expect(keyInForce(attacker.opens[0])).toBeUndefined();

    const real = runtimeFor(credentials, `${API}/`);
    await real.runtime.getWallet();
    expect(keyInForce(real.opens[0])).toBe("sk_live_from_env");
  });
});

describe("a credential that changes mid-session needs no re-open", () => {
  it("register_account: opened keyless for the payout address, the key minted afterwards is in force on the next read", async () => {
    const credentials = new CredentialResolver({ envKey: undefined });
    const { runtime, opens, closedCount } = runtimeFor(credentials);

    await runtime.getWallet();
    expect(keyInForce(opens[0])).toBeUndefined();

    credentials.setActiveKey("sk_test_minted_by_register_account");
    await runtime.getWallet();

    expect(opens).toHaveLength(1);
    expect(closedCount()).toBe(0);
    expect(keyInForce(opens[0])).toBe("sk_test_minted_by_register_account");
  });

  it("activate_key: sk_A → sk_B is seen by the same instance", async () => {
    const credentials = new CredentialResolver({ envKey: undefined });
    credentials.setActiveKey("sk_test_A");
    const { runtime, opens, closedCount } = runtimeFor(credentials);
    await runtime.getWallet();
    credentials.setActiveKey("sk_live_B");
    await runtime.getWallet();
    expect(opens).toHaveLength(1);
    expect(closedCount()).toBe(0);
    expect(keyInForce(opens[0])).toBe("sk_live_B");
  });

  it("opens once for concurrent first calls", async () => {
    const credentials = new CredentialResolver({ envKey: "sk_test_env" });
    const { runtime, opens } = runtimeFor(credentials);
    const [a, b, c] = await Promise.all([runtime.getWallet(), runtime.getWallet(), runtime.getWallet()]);
    expect(opens).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
