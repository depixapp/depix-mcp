// Liquid engine — lwk_node (spec §2.1, SPIKE candidate B).
//
// lwk_node is the nodejs-target wasm-pack build of the SAME LWK crate the
// frontend embeds as lwk_wasm, published in lockstep (same versions). The
// module import IS the wasm init (synchronous, 1-2 ms, no flags, no loader).
//
// Bump governance (SPIKE risk 5 + memory `lwk_wasm DePix dependency`): only
// bump together with the frontend's lwk_wasm pin, and keep the golden +
// addDetails guardian tests green (test/engine.test.ts). `pset.addDetails` is
// NOT used by send/withdraw (TxBuilder.finish PSETs come complete) — it is
// load-bearing for the SideSwap/peg-out flows (PR4+), so the export check is
// mandatory on every bump.
//
// Package fallback (documented, not implemented): candidate A — lwk_wasm +
// a ~50-line fs.readFile loader, same dance as the frontend's lwk-loader.js —
// if the nodejs target ever stops being published.

import { createHmac } from "node:crypto";
import {
  Address,
  AssetId,
  EsploraClient,
  Mnemonic,
  Network,
  Pset,
  Signer,
  Transaction,
  TxBuilder,
  Update,
  Wollet,
  WolletDescriptor
} from "lwk_node";
import { WalletError } from "../errors.js";

// Re-export the classes the SDK uses so every other module goes through this
// wrapper (single import point = single place to swap in candidate A).
export { Address, AssetId, EsploraClient, Mnemonic, Network, Pset, Signer, Transaction, TxBuilder, Update, Wollet, WolletDescriptor };

// Namespace-style access for guardian checks (e.g. lwk.Pset.prototype.addDetails).
export const lwk = {
  Address,
  AssetId,
  EsploraClient,
  Mnemonic,
  Network,
  Pset,
  Signer,
  Transaction,
  TxBuilder,
  Update,
  Wollet,
  WolletDescriptor
};

let cachedMainnet: Network | null = null;

/** The SDK is mainnet-only in F3 (frontend parity — GT §1.2). */
export function mainnetNetwork(): Network {
  if (!cachedMainnet) cachedMainnet = Network.mainnet();
  return cachedMainnet;
}

/**
 * Frontend-parity mnemonic normalization (wallet.js:271-278): trim, collapse
 * any whitespace run into one space, lowercase. Non-strings become "".
 */
export function normalizeMnemonic(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Checksum validation is 100% inside LWK (`new Mnemonic(str)` throws).
 * Returns the normalized mnemonic string on success.
 */
export function validateMnemonic(raw: string): string {
  const normalized = normalizeMnemonic(raw);
  try {
    const m = new Mnemonic(normalized);
    m.free();
  } catch (err) {
    throw new WalletError("INVALID_MNEMONIC", "Invalid mnemonic (BIP39 checksum failed)", {
      cause: err
    });
  }
  return normalized;
}

/**
 * Derive the CT descriptor string (ct(slip77(...),elwpkh(...))) from a
 * mnemonic. The signer is freed before returning — callers that need to sign
 * materialize their own short-lived signer (per-op auth, spec §2.3).
 */
export function descriptorFromMnemonic(mnemonicStr: string): string {
  const normalized = validateMnemonic(mnemonicStr);
  const network = mainnetNetwork();
  const mnemonic = new Mnemonic(normalized);
  const signer = new Signer(mnemonic, network);
  try {
    return signer.wpkhSlip77Descriptor().toString();
  } finally {
    signer.free();
    mnemonic.free();
  }
}

/** Build a view-only (watch) Wollet from a CT descriptor string. */
export function buildWollet(descriptor: string): Wollet {
  return new Wollet(mainnetNetwork(), new WolletDescriptor(descriptor));
}

/** Generate a fresh 12-word mnemonic from LWK's internal RNG. */
export function generateMnemonic(): string {
  const m = Mnemonic.fromRandom(12);
  try {
    return m.toString();
  } finally {
    m.free();
  }
}

/**
 * The 32-byte SLIP-77 master blinding key, read out of a CT descriptor
 * (`ct(slip77(<64 hex>),elwpkh(...))#checksum`). It is a VIEW secret, never a
 * spending one — but it unblinds EVERY script of the wallet, so callers keep it
 * in-scope and hand out only per-script keys derived from it, one at a time.
 */
function slip77MasterFromDescriptor(descriptor: string): Buffer | null {
  const hex = /\bslip77\(([0-9a-fA-F]{64})\)/.exec(descriptor)?.[1];
  return hex ? Buffer.from(hex, "hex") : null;
}

/** The scriptPubkey bytes of a Liquid address (the confidential blinding is not part of the script). */
function addressScriptPubkeyBytes(addressStr: string): Buffer {
  let addr: Address;
  try {
    addr = new Address(addressStr);
  } catch (err) {
    throw new WalletError("INVALID_ADDRESS", "Invalid Liquid address for scriptPubkey derivation", { cause: err });
  }
  let script: ReturnType<Address["scriptPubkey"]> | undefined;
  try {
    script = addr.scriptPubkey();
    return Buffer.from(script.bytes());
  } finally {
    script?.free();
    addr.free();
  }
}

/**
 * SLIP-77 blinding PRIVATE key of ONE script, as 64-char lowercase hex:
 *
 *   blinding_privkey = HMAC-SHA256(master_blinding_key, scriptPubkey)
 *
 * This is the exact scalar the backend re-derives the blinding PUBLIC key from
 * to accept a DePix-rail activation (depix-rail.js). The master unblinds every
 * script, so it is zeroed the moment the derivation is done and never returned;
 * the caller only ever receives the per-script hex, which is what transits to
 * the backend by design (spec §3.9). Never log the result.
 */
export function deriveSlip77BlindingKeyHex(descriptor: string, addressStr: string): string {
  const script = addressScriptPubkeyBytes(addressStr);
  const master = slip77MasterFromDescriptor(descriptor);
  // A descriptor without a slip77 master is a malformed wallet, not caller input;
  // the message names neither the master nor the key.
  if (!master) throw new WalletError("UNKNOWN", "Wallet descriptor carries no SLIP-77 blinding key");
  const derived = createHmac("sha256", master).update(script).digest();
  try {
    return derived.toString("hex");
  } finally {
    master.fill(0);
    derived.fill(0);
  }
}
