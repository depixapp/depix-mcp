// Swap-provider registry, liveness probe and per-call routing (§5.3).
//
// The probe is the whole point: a backend with swap creation switched off still
// answers every GET with a healthy-looking pair matrix, so liveness has to come
// from the creation path and be read from the MESSAGE, not the status code.
// Nothing here touches the network — every probe fetch is injected.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureBoltzConfig,
  resetBoltzConfigForTests
} from "../../src/wallet-engine/convert/boltz/client.js";
import {
  SWAP_PROVIDERS,
  STABLECOIN_PROVIDER,
  assertStablecoinProviderLive,
  currentBoltzApiUrl,
  forceSwapProvider,
  getProviderById,
  getSelectedProvider,
  invalidateSelectionOnCreationFailure,
  isStablecoinProviderLive,
  probeProvider,
  resetSwapProviderSelection,
  selectSwapProvider,
  withProvider,
  type ProbeFetch,
  type SwapProvider
} from "../../src/wallet-engine/convert/boltz/providers.js";
import { isDepixSdkError } from "../../src/wallet-engine/errors.js";

const BOLTZ = SWAP_PROVIDERS[0]!;
const COINOS = SWAP_PROVIDERS[1]!;

const DISABLED = { status: 400, body: '{"error":"swap creation is disabled"}' };
const ALIVE = { status: 400, body: '{"error":"1 is less than minimal of 25000"}' };

/** A probe fetch scripted per provider host, recording every request it saw. */
function scriptedProbe(byHost: Record<string, { status: number; body: string } | "throw">) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: ProbeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const key = Object.keys(byHost).find((h) => url.startsWith(h));
    const scripted = key ? byHost[key]! : "throw";
    if (scripted === "throw") throw new TypeError("fetch failed");
    return { status: scripted.status, text: async () => scripted.body };
  };
  return { fetchImpl, calls };
}

beforeEach(() => {
  resetSwapProviderSelection();
});
afterEach(() => {
  resetSwapProviderSelection();
});

describe("probeProvider — liveness comes from the creation path, read as a message", () => {
  it("posts a creation request no backend can accept, and never asks for a swap it could get", async () => {
    const { fetchImpl, calls } = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    await probeProvider(BOLTZ, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BOLTZ.apiUrl}/v2/swap/reverse`);
    // 1 sat is below every known backend minimum, so the creation path runs and
    // rejects before anything is created.
    expect(calls[0]!.body).toMatchObject({ from: "BTC", to: "L-BTC", invoiceAmount: 1 });
  });

  it("reads the complaint, not the status: both answers are HTTP 400", async () => {
    const disabled = scriptedProbe({ [BOLTZ.apiUrl]: DISABLED });
    const alive = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    expect(await probeProvider(BOLTZ, disabled.fetchImpl)).toBe(false);
    expect(await probeProvider(BOLTZ, alive.fetchImpl)).toBe(true);
  });

  it("treats a 5xx, an unreachable host and a maintenance notice as dead", async () => {
    for (const scripted of [
      { status: 502, body: "bad gateway" },
      { status: 400, body: "backend is under maintenance" },
      { status: 400, body: '{"error":"swaps are currently disabled"}' }
    ]) {
      const { fetchImpl } = scriptedProbe({ [BOLTZ.apiUrl]: scripted });
      expect(await probeProvider(BOLTZ, fetchImpl)).toBe(false);
    }
    const { fetchImpl } = scriptedProbe({});
    expect(await probeProvider(BOLTZ, fetchImpl)).toBe(false);
  });

  it("uses a random preimage hash with no known preimage", async () => {
    const { fetchImpl, calls } = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    await probeProvider(BOLTZ, fetchImpl);
    await probeProvider(BOLTZ, fetchImpl);
    const hashes = calls.map((c) => (c.body as { preimageHash: string }).preimageHash);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});

describe("selectSwapProvider — ordered walk, cached per process", () => {
  it("keeps Boltz while it is healthy and never probes the fallback", async () => {
    const { fetchImpl, calls } = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE, [COINOS.apiUrl]: ALIVE });
    expect((await selectSwapProvider({ fetchImpl })).id).toBe("boltz");
    expect(calls).toHaveLength(1);
  });

  it("falls through to Coinos when Boltz has creation switched off", async () => {
    const { fetchImpl, calls } = scriptedProbe({ [BOLTZ.apiUrl]: DISABLED, [COINOS.apiUrl]: ALIVE });
    expect((await selectSwapProvider({ fetchImpl })).id).toBe("coinos");
    expect(calls.map((c) => c.url)).toEqual([
      `${BOLTZ.apiUrl}/v2/swap/reverse`,
      `${COINOS.apiUrl}/v2/swap/reverse`
    ]);
    expect(getSelectedProvider()?.id).toBe("coinos");
  });

  it("caches the answer, and a forced re-probe bypasses the cache", async () => {
    const { fetchImpl, calls } = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    await selectSwapProvider({ fetchImpl });
    await selectSwapProvider({ fetchImpl });
    expect(calls).toHaveLength(1);
    await selectSwapProvider({ fetchImpl, force: true });
    expect(calls).toHaveLength(2);
  });

  it("throws a typed, retryable error when every backend is off — and does NOT cache it", async () => {
    const dead = scriptedProbe({ [BOLTZ.apiUrl]: DISABLED, [COINOS.apiUrl]: DISABLED });
    await expect(selectSwapProvider({ fetchImpl: dead.fetchImpl })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "SWAP_PROVIDER_UNAVAILABLE")
    );
    await expect(selectSwapProvider({ fetchImpl: dead.fetchImpl })).rejects.toThrow();
    expect(dead.calls).toHaveLength(4); // both probes ran twice — nothing was cached

    const recovered = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    expect((await selectSwapProvider({ fetchImpl: recovered.fetchImpl })).id).toBe("boltz");
  });

  it("carries the contact of every provider in the unavailable error (G3 actionable)", async () => {
    const { fetchImpl } = scriptedProbe({ [BOLTZ.apiUrl]: DISABLED, [COINOS.apiUrl]: DISABLED });
    try {
      await selectSwapProvider({ fetchImpl });
      expect.unreachable();
    } catch (e) {
      const details = (e as { details?: Record<string, unknown> }).details ?? {};
      expect(details.retryable).toBe(true);
      expect(details.nextStep).toEqual(expect.any(String));
      expect(details.providers).toEqual(
        SWAP_PROVIDERS.map((p) => ({ id: p.id, name: p.name, contact: p.contact }))
      );
    }
  });
});

describe("invalidateSelectionOnCreationFailure — a dead pick is not retried forever", () => {
  it("re-probes after a provider-side creation failure", async () => {
    const first = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    await selectSwapProvider({ fetchImpl: first.fetchImpl });

    expect(invalidateSelectionOnCreationFailure(new Error("swap creation is disabled"))).toBe(true);

    const second = scriptedProbe({ [BOLTZ.apiUrl]: DISABLED, [COINOS.apiUrl]: ALIVE });
    expect((await selectSwapProvider({ fetchImpl: second.fetchImpl })).id).toBe("coinos");
  });

  it("blames the provider on 5xx and on transport failures, but not on our own bad input", async () => {
    expect(invalidateSelectionOnCreationFailure(Object.assign(new Error("boom"), { status: 502 }))).toBe(true);
    expect(invalidateSelectionOnCreationFailure(new TypeError("fetch failed"))).toBe(true);
    expect(invalidateSelectionOnCreationFailure(new Error("invoice has no amount"))).toBe(false);
    expect(invalidateSelectionOnCreationFailure(Object.assign(new Error("bad"), { status: 400 }))).toBe(false);
  });

  it("keeps the cached selection when the failure was ours", async () => {
    const { fetchImpl, calls } = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    await selectSwapProvider({ fetchImpl });
    invalidateSelectionOnCreationFailure(new Error("invoice has no amount"));
    await selectSwapProvider({ fetchImpl });
    expect(calls).toHaveLength(1);
  });
});

describe("getProviderById — a swap belongs to whoever created it", () => {
  it("resolves each known id and falls back to Boltz for a record written before providers existed", () => {
    expect(getProviderById("coinos").id).toBe("coinos");
    expect(getProviderById("boltz").id).toBe("boltz");
    expect(getProviderById(undefined).id).toBe("boltz");
    expect(getProviderById(null).id).toBe("boltz");
    expect(getProviderById("someone-else").id).toBe("boltz");
  });
});

describe("the stablecoin route stays pinned to Boltz", () => {
  it("is Boltz, and its liveness is probed on its own (never the selection's)", async () => {
    expect(STABLECOIN_PROVIDER.id).toBe("boltz");
    const { fetchImpl, calls } = scriptedProbe({ [BOLTZ.apiUrl]: DISABLED, [COINOS.apiUrl]: ALIVE });
    expect((await selectSwapProvider({ fetchImpl })).id).toBe("coinos");
    expect(await isStablecoinProviderLive({ fetchImpl })).toBe(false);
    expect(calls.every((c) => !c.url.startsWith(COINOS.apiUrl) || c.url === `${COINOS.apiUrl}/v2/swap/reverse`)).toBe(
      true
    );
    await expect(assertStablecoinProviderLive({ fetchImpl })).rejects.toSatisfy((e) =>
      isDepixSdkError(e, "SWAP_PROVIDER_UNAVAILABLE")
    );
  });

  it("passes through when Boltz is creating swaps", async () => {
    const { fetchImpl } = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    await expect(assertStablecoinProviderLive({ fetchImpl })).resolves.toBeUndefined();
  });
});

describe("forceSwapProvider — the dry-run harness pins a provider the probe would skip", () => {
  it("selects without probing, and rejects an unknown id", async () => {
    expect(forceSwapProvider("coinos").id).toBe("coinos");
    const { fetchImpl, calls } = scriptedProbe({ [BOLTZ.apiUrl]: ALIVE });
    expect((await selectSwapProvider({ fetchImpl })).id).toBe("coinos");
    expect(calls).toHaveLength(0);
    expect(() => forceSwapProvider("nope" as never)).toThrow(/Unknown swap provider/);
  });
});

// The part the browser port never needed: boltz-swaps keeps ONE config for the
// whole process, and the engine runs swaps concurrently.
describe("withProvider — each call chain resolves its OWN backend", () => {
  beforeEach(() => {
    resetBoltzConfigForTests();
  });

  async function configuredApiUrl(): Promise<() => string> {
    await ensureBoltzConfig();
    const { getBoltzApiUrl } = (await import("boltz-swaps/config")) as unknown as {
      getBoltzApiUrl: () => string;
    };
    return getBoltzApiUrl;
  }

  it("defaults to Boltz outside any context", async () => {
    const getBoltzApiUrl = await configuredApiUrl();
    expect(currentBoltzApiUrl()).toBe(BOLTZ.apiUrl);
    expect(getBoltzApiUrl()).toBe(BOLTZ.apiUrl);
  });

  it("survives an await inside the context", async () => {
    const getBoltzApiUrl = await configuredApiUrl();
    await withProvider(COINOS, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getBoltzApiUrl()).toBe(COINOS.apiUrl);
    });
    expect(getBoltzApiUrl()).toBe(BOLTZ.apiUrl);
  });

  it("keeps a Lightning flow on Coinos while a stablecoin flow interleaves on Boltz", async () => {
    const getBoltzApiUrl = await configuredApiUrl();
    // Interleave deliberately: each step of each flow reads the config AFTER the
    // other flow has had a chance to re-point it.
    const observe = (provider: SwapProvider, delays: number[]): Promise<string[]> =>
      withProvider(provider, async () => {
        const seen: string[] = [];
        for (const d of delays) {
          await new Promise((r) => setTimeout(r, d));
          seen.push(getBoltzApiUrl());
        }
        return seen;
      });

    const [lightning, stablecoin] = await Promise.all([
      observe(COINOS, [0, 4, 8, 12]),
      observe(STABLECOIN_PROVIDER, [2, 6, 10, 14])
    ]);

    expect(lightning).toEqual(Array(4).fill(COINOS.apiUrl));
    expect(stablecoin).toEqual(Array(4).fill(BOLTZ.apiUrl));
  });
});
