// The wallet half must authenticate with the SAME credential as the gateway half.
//
// The bug this pins: `DepixWallet.open()` falls back to $DEPIX_API_KEY alone, so
// an agent that self-registered — its sk_ living ENCRYPTED in the credential
// store and never in the environment — got API_KEY_REQUIRED on
// deposit()/withdraw() while every gateway tool worked, because only the gateway
// half consulted the CredentialResolver. A resolver unit test cannot see it (the
// resolver resolves fine): what breaks is the WIRING, and the cached-wallet
// lifetime around it, so that is what these drive — with the real resolver.

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

function runtimeFor(credentials: CredentialResolver, apiBase = API) {
  const engine = spyEngine();
  const credential = () => walletApiKey(credentials.resolveCredential());
  const runtime = createWalletRuntime({
    open: createWalletOpener({ resolveApiKey: credential, apiBase, load: engine.load }),
    credential,
  });
  return { runtime, ...engine };
}

describe("the wallet opens with the resolved credential", () => {
  it("passes the STORED agent key when the environment has none (the self-onboarding path)", async () => {
    const credentials = new CredentialResolver({ envKey: undefined });
    credentials.setActiveKey("sk_live_from_store");
    const { runtime, opens } = runtimeFor(credentials);

    await runtime.getWallet();

    expect(opens).toHaveLength(1);
    expect(opens[0]?.apiKey).toBe("sk_live_from_store");
    // The auto-resume flags are the engine bin's contract and must survive.
    expect(opens[0]?.resumePendingWithdrawalsOnOpen).toBe(false);
    expect(opens[0]?.resumePendingConversionsOnOpen).toBe(false);
  });

  it("prefers the environment key over the store, matching the gateway's precedence", async () => {
    const credentials = new CredentialResolver({ envKey: "sk_live_from_env" });
    credentials.setActiveKey("sk_live_from_store");
    const { runtime, opens } = runtimeFor(credentials);

    await runtime.getWallet();

    expect(opens[0]?.apiKey).toBe("sk_live_from_env");
  });

  it("keeps the wallet keyless under the owner login — an access token is not an API key", () => {
    const credentials = new CredentialResolver({ envKey: undefined });
    credentials.setOwnerToken("eyJhbGciOi.owner-access-token.sig");
    // Fixture sanity: the resolver really did pick the owner persona.
    expect(credentials.resolveCredential()).toEqual({ token: "eyJhbGciOi.owner-access-token.sig", kind: "oauth" });

    expect(walletApiKey(credentials.resolveCredential())).toBeUndefined();
  });

  it("withholds the STORED credential from a non-allowlisted DEPIX_API_BASE (an env key follows the engine's own fallback)", async () => {
    const credentials = new CredentialResolver({ envKey: "sk_live_from_env" });

    const attacker = runtimeFor(credentials, "https://attacker.example");
    await attacker.runtime.getWallet();
    expect(attacker.opens[0]).toHaveProperty("apiKey", undefined);

    // A path or trailing slash on the real origin is still the real origin.
    const real = runtimeFor(credentials, `${API}/`);
    await real.runtime.getWallet();
    expect(real.opens[0]?.apiKey).toBe("sk_live_from_env");
  });
});

describe("the runtime follows the credential across the wallet's lifetime", () => {
  it("reopens the cached wallet when register_account mints a key after it was opened keyless", async () => {
    const credentials = new CredentialResolver({ envKey: undefined });
    const { runtime, opens, closedCount } = runtimeFor(credentials);

    // register_account: wallet opened for the payout address, no key yet…
    await runtime.getWallet();
    expect(opens[0]).toHaveProperty("apiKey", undefined);
    // …then the minted key is activated in-session.
    credentials.setActiveKey("sk_test_minted_by_register_account");

    // The next wallet call must authenticate — without a restart.
    await runtime.getWallet();
    expect(opens).toHaveLength(2);
    expect(opens[1]?.apiKey).toBe("sk_test_minted_by_register_account");
    expect(closedCount()).toBe(1);

    // Unchanged credential: no churn.
    await runtime.getWallet();
    expect(opens).toHaveLength(2);
  });

  it("follows a key-to-key switch too — activate_key's case (sk_A → sk_B)", async () => {
    const credentials = new CredentialResolver({ envKey: undefined });
    const { runtime, opens, closedCount } = runtimeFor(credentials);
    credentials.setActiveKey("sk_test_A");
    await runtime.getWallet();
    credentials.setActiveKey("sk_live_B");
    await runtime.getWallet();
    expect(opens.map((o) => o?.apiKey)).toEqual(["sk_test_A", "sk_live_B"]);
    expect(closedCount()).toBe(1);
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
