/*
 * Copyright 2026 DePix App
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at http://www.apache.org/licenses/LICENSE-2.0 — see LICENSE.
 *
 * VENDORED ENGINE SOURCE — DO NOT EDIT HERE.
 * Origin:    https://github.com/depixapp/depix-sdk
 * Commit:    20b0765ca529f9e38b0de20b0c3265a5c9a8dc58
 * Path:      src/convert/boltz/keys.ts
 * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)
 *
 * DePix App owns this code and distributes THIS copy under Apache-2.0. The
 * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing
 * from that published tarball is reused here (spec §2.2).
 */
// Swap-scoped keypair + reverse-swap secret generation (spec §5.3). These keys
// are NOT the wallet seed — a refund key authorizes only refunding a specific
// submarine lockup; a claim key + preimage authorize only claiming a specific
// reverse lockup into the wallet. secp256k1 from @noble/curves + WebCrypto RNG
// (frontend parity: boltzSecp.utils.randomSecretKey / getPublicKey compressed).

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

export interface Keypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  privHex: string;
  pubHex: string;
}

/** A fresh compressed-pubkey secp256k1 keypair for a swap's refund/claim leaf. */
export function randomKeypair(): Keypair {
  const privateKey = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true); // compressed (33 bytes)
  return { privateKey, publicKey, privHex: hex.encode(privateKey), pubHex: hex.encode(publicKey) };
}

/** Reverse-swap secrets: our own preimage, its SHA256 hash, and a claim keypair. */
export function deriveReverseSecrets(): {
  preimage: Uint8Array;
  preimageHash: Uint8Array;
  claimKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
} {
  const preimage = new Uint8Array(32);
  globalThis.crypto.getRandomValues(preimage);
  const preimageHash = sha256(preimage);
  const kp = randomKeypair();
  return { preimage, preimageHash, claimKeys: { privateKey: kp.privateKey, publicKey: kp.publicKey } };
}
