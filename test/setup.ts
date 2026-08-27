// Per-file test setup.
//
// Creating a swap resolves the backend by PROBING the provider list over the
// network (convert/boltz/providers.ts). A unit suite must never do that: it
// would be slow, flaky, and would post a (rejected) creation request to a real
// operator. Pin the selection to Boltz — the engine's historical default, so
// every pre-fallback expectation still reads the same — and let the suites that
// exercise the fallback seed the selection themselves (`selectSwapProvider`
// with an injected fetch, or `forceSwapProvider`).
//
// Pinning Boltz also answers the stablecoin route's liveness (the kill switch
// is backend-wide), so no suite probes on that path either.
//
// Module state is per test file under Vitest's default isolation, so this pin
// cannot leak between files.
import { forceSwapProvider } from "../src/wallet-engine/convert/boltz/providers.js";

forceSwapProvider("boltz");
