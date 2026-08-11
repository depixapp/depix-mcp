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
 * Path:      src/convert/boltz/index.ts
 * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)
 *
 * DePix App owns this code and distributes THIS copy under Apache-2.0. The
 * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing
 * from that published tarball is reused here (spec §2.2).
 */
// Boltz Lightning + stablecoin namespace (spec §5.3) — public surface + internals barrel.

export {
  BoltzConvert,
  type BoltzWalletContext,
  type BoltzConvertDeps,
  type PayLightningResult,
  type ReceiveLightningResult,
  type SubmarineOutcome,
  type BoltzResumeSummary,
  type ToStablecoinResult,
  type StablecoinOutcome
} from "./convert.js";
export {
  boltzVariantKey,
  checkStablecoinAmount,
  deriveStablecoinKeys,
  estimateStablecoinOut,
  isValidTronAddress,
  mapChainSwapStatus,
  // prepareStablecoinRoute / PreparedStablecoinRoute stay internal (return raw
  // ephemeral key bytes) — reachable only via toStablecoin, never the barrel.
  executeStablecoinRoute,
  withEphemeralEvmSigner,
  buildLocalSigner,
  loadViem,
  ensureStablecoinConfig,
  resetStablecoinConfigForTests,
  BOLTZ_STABLECOIN_NETWORKS,
  MAX_CHAIN_TIMEOUT_BLOCKS,
  STABLECOIN_MAX_FEE_RATIO,
  STABLECOIN_DECIMALS,
  type StablecoinAsset,
  type StablecoinParams,
  type StablecoinEstimate,
  type CheckStablecoinAmountResult,
  type LocalEvmSigner
} from "./stablecoin.js";
export {
  refundChainSwap,
  buildChainRefundTx,
  type ChainRefundRecord,
  type ChainRefundDeps
} from "./refund.js";
export { type StoredStablecoinSwap } from "./store.js";
export { BoltzClient, BOLTZ_API_BASE, BOLTZ_WS_URL, ensureBoltzConfig } from "./client.js";
export { BoltzApiError, ConversionError } from "../../errors.js";
export {
  decodeInvoiceAmountSats,
  decodeInvoicePaymentHash,
  assertLockupNotInflated,
  assertTimeoutInBounds,
  mapSubmarineStatus,
  MAX_SUBMARINE_TIMEOUT_BLOCKS,
  LOCKUP_FEE_MARGIN,
  LOCKUP_FIXED_ALLOWANCE_SATS,
  type SubmarineBucket
} from "./lightning.js";
export { assertLockupAddressBindsToUser, type VerifyLockupParams } from "./verify-lockup.js";
export { prepareSubmarineSwap, type PreparedSubmarineSwap, type PrepareSubmarineDeps } from "./submarine.js";
export {
  refundSubmarineSwap,
  buildSubmarineRefundTx,
  RefundPendingError,
  refundLockTime,
  type RefundResult,
  type RefundDeps,
  type SubmarineRefundRecord
} from "./refund.js";
export {
  receiveViaLightning,
  resumeReverseSwap,
  buildReverseClaimTx,
  getReverseLimits,
  estimateReverseReceive,
  mapReverseStatus,
  REVERSE_PHASE,
  type ReverseSwapRecord,
  type ReverseOutcome,
  type ReverseDeps,
  type ReverseBucket,
  type ReversePhase
} from "./reverse.js";
export { randomKeypair, deriveReverseSecrets, type Keypair } from "./keys.js";
export {
  BoltzSwapStore,
  BOLTZ_SWAPS_FILE,
  type StoredBoltzSwap,
  type StoredSubmarineSwap,
  type StoredReverseSwap
} from "./store.js";
export { resetBoltzConfigForTests } from "./client.js";
export { resetBoltzSecpForTests } from "./secp.js";
