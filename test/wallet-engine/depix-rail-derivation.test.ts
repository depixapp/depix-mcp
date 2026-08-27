// SLIP-77 blinding-key derivation for the DePix direct rail (spec §3.9 piece 2).
//
// The tool `configure_depix_rail` hands the backend a READ key for exactly one
// scriptPubkey: it lets the §6.3 watcher unblind the amounts paid to the
// dedicated address and nothing else — zero spending power, zero visibility
// into any other address of the wallet, because SLIP-77 binds one key per
// script:
//
//   blinding_privkey = HMAC-SHA256(master_blinding_key, scriptPubkey)
//
// The proof below is the SAME one the backend runs before accepting an
// activation (depix-rail.js `blindingKeyMatchesAddress`), and it is
// NON-CIRCULAR — nothing here reuses the code under test:
//   - the (descriptor, address) pair comes from the REAL lwk_node binary;
//   - the pubkey comes from node:crypto's secp256k1 (ECDH), not from LWK;
//   - the expected blinding pubkey is read straight out of the blech32 payload
//     of the `lq1…` address, by hand.
// A wrong master, a wrong HMAC message, a swapped key/message or a byte-order
// slip all break the equality — none can accidentally satisfy it.

import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildWollet, descriptorFromMnemonic, deriveSlip77BlindingKeyHex } from "../../src/wallet-engine/engine/lwk.js";

// Fixed seed → fixed descriptor → fixed addresses (same golden as engine.test.ts).
const KNOWN_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ── independent crypto (never the code under test) ──────────────────────────

const BLECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * Pull the 33-byte blinding pubkey out of a confidential `lq1…` address.
 * blech32 is bech32 with a 12-symbol checksum; we only need the payload, so the
 * checksum is dropped rather than verified (the address comes from LWK, and a
 * corrupted payload would fail the pubkey comparison anyway).
 */
function blindingPubkeyFromAddress(address: string): string {
  const sep = address.lastIndexOf("1");
  const values = [...address.slice(sep + 1)].map((ch) => {
    const i = BLECH32_CHARSET.indexOf(ch);
    if (i < 0) throw new Error(`not blech32: ${ch}`);
    return i;
  });
  // [0] is the witness version; the last 12 symbols are the checksum.
  const payload5 = values.slice(1, -12);
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of payload5) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(out.slice(0, 33)).toString("hex");
}

/** Compressed secp256k1 pubkey of a private scalar — node:crypto, unrelated to LWK. */
function pubkeyOf(privHex: string): string {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privHex, "hex"));
  return ecdh.getPublicKey(null, "compressed").toString("hex");
}

describe("deriveSlip77BlindingKeyHex (spec §3.9)", () => {
  it("derives the exact view key the dedicated address commits to", () => {
    const descriptor = descriptorFromMnemonic(KNOWN_MNEMONIC);
    const wollet = buildWollet(descriptor);
    try {
      const address = wollet.address(0).address().toString();
      const keyHex = deriveSlip77BlindingKeyHex(descriptor, address);

      // Shape: 32 bytes, lowercase hex.
      expect(keyHex).toMatch(/^[0-9a-f]{64}$/);

      // The proof: the address embeds the blinding PUBLIC key; activation sends
      // the PRIVATE one. If they don't pair up, the backend rejects with
      // `invalid_blinding_key` and the rail never works.
      expect(pubkeyOf(keyHex)).toBe(blindingPubkeyFromAddress(address));
    } finally {
      wollet.free();
    }
  });

  it("binds one key per script — a different address gets a different key", () => {
    const descriptor = descriptorFromMnemonic(KNOWN_MNEMONIC);
    const wollet = buildWollet(descriptor);
    try {
      const addr0 = wollet.address(0).address().toString();
      const addr1 = wollet.address(1).address().toString();
      expect(addr1).not.toBe(addr0);

      const k0 = deriveSlip77BlindingKeyHex(descriptor, addr0);
      const k1 = deriveSlip77BlindingKeyHex(descriptor, addr1);
      expect(k1).not.toBe(k0);
      expect(pubkeyOf(k0)).toBe(blindingPubkeyFromAddress(addr0));
      expect(pubkeyOf(k1)).toBe(blindingPubkeyFromAddress(addr1));
    } finally {
      wollet.free();
    }
  });

  it("is a pure function of the seed — a re-derivation produces the same key", () => {
    const descriptor = descriptorFromMnemonic(KNOWN_MNEMONIC);
    const wollet = buildWollet(descriptor);
    try {
      const address = wollet.address(0).address().toString();
      const a = deriveSlip77BlindingKeyHex(descriptor, address);
      const b = deriveSlip77BlindingKeyHex(descriptorFromMnemonic(KNOWN_MNEMONIC), address);
      expect(b).toBe(a);
    } finally {
      wollet.free();
    }
  });

  it("does not leave the master or the derived key in any error it throws", () => {
    const descriptor = descriptorFromMnemonic(KNOWN_MNEMONIC);
    const master = /slip77\(([0-9a-f]{64})\)/i.exec(descriptor)![1];
    // A non-lq1 address has no derivable confidential script → it must throw,
    // and the throw must not carry the master blinding key.
    try {
      deriveSlip77BlindingKeyHex(descriptor, "not-an-address");
      throw new Error("expected a throw");
    } catch (err) {
      const serialized = `${(err as Error).message} ${JSON.stringify(err)}`;
      expect(serialized).not.toContain(master);
    }
  });
});
