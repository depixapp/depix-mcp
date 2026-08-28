// The engine reaches boltz-swaps only through `await import()` behind
// `as any` / `as unknown` casts, so neither tsc nor the rest of the suite
// notices when a bump renames or drops an entrypoint or an export — 0.0.9
// renamed chains→networks and dropped execute, and the surface had to be
// checked by hand against the exports map. This file is that check made
// executable: it loads every specifier the engine imports and touches every
// name the call sites destructure, so the next surface change fails here
// instead of mid-swap.
//
// The specifier KEYS are self-policing: a test scans the call sites and fails
// when the sets diverge. The NAMES under each key are still a manual mirror —
// when a call site starts using a new name, add it here.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// specifier -> the names the engine's call sites destructure from it.
const SURFACE: Record<string, string[]> = {
  "boltz-swaps": ["createBoltzClient", "getPairs", "quoteRouteAmountOut"],
  "boltz-swaps/client": [
    "broadcastApiTransaction",
    "createReverseSwap",
    "getChainSwapTransactions",
    "getFeeEstimations",
    "getLockupTransaction",
    "getPairs",
    "getPartialRefundSignature",
    "getPartialReverseClaimSignature",
    "getReverseTransaction",
    "quoteDexAmountOut",
  ],
  "boltz-swaps/config": ["setBoltzSwapsConfig"],
  "boltz-swaps/evm": ["isKnownTokenAddress"],
  "boltz-swaps/lazy/utxo": ["utxoSecp"],
  "boltz-swaps/presets/mainnet": ["mainnetConfig"],
  "boltz-swaps/routeExecute": ["createRoute", "executeRoute"],
  "boltz-swaps/types": ["SwapType"],
  "boltz-swaps/utxo": [
    "createMusig",
    "decodeAddress",
    "getConstructClaimTransaction",
    "getNetwork",
    "getOutputAmount",
    "getTransaction",
    "hashForWitnessV1",
    "setCooperativeWitness",
    "tweakMusig",
    "txToHex",
    "txToId",
  ],
};

// Everything the engine destructures is a function except these three values.
const OBJECT_EXPORTS = new Set(["utxoSecp", "mainnetConfig", "SwapType"]);

describe("boltz-swaps import surface", () => {
  it("SURFACE's specifiers are exactly the ones the engine imports", () => {
    const root = join(process.cwd(), "src");
    const found = new Set<string>();
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
      for (const m of text.matchAll(/(?:import\(|require\.resolve\()\s*["'](boltz-swaps[^"']*)["']/g)) {
        if (m[1] !== undefined) found.add(m[1]);
      }
    }
    expect([...found].sort()).toEqual(Object.keys(SURFACE).sort());
  });

  for (const [specifier, names] of Object.entries(SURFACE)) {
    it(`${specifier} loads and keeps its exports`, async () => {
      const mod = (await import(specifier)) as Record<string, unknown>;
      for (const name of names) {
        const kind = OBJECT_EXPORTS.has(name) ? "object" : "function";
        expect(typeof mod[name], `${specifier} no longer exports ${name} as a ${kind}`).toBe(kind);
      }
    });
  }

  it("SwapType still names the Submarine and Chain variants", async () => {
    const { SwapType } = (await import("boltz-swaps/types")) as { SwapType: Record<string, unknown> };
    expect(SwapType.Submarine, "SwapType.Submarine is gone").toBeDefined();
    expect(SwapType.Chain, "SwapType.Chain is gone").toBeDefined();
  });

  // The documented boundary (see convert/boltz/client.ts header): ./invoice
  // statically requires bolt11 + bolt12-utils, peerOptional and not installed,
  // so the entrypoint must stay unloadable. If this starts PASSING to import,
  // the peers landed in the tree and the header note is stale.
  it("boltz-swaps/invoice stays unloadable without the optional peers", async () => {
    await expect(import("boltz-swaps/invoice")).rejects.toThrowError(/bolt11|bolt12|Cannot find/);
  });
});
