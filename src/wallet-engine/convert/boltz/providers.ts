// Which swap backend serves a swap (§5.3).
//
// Boltz is one deployment of `boltz-backend`, not the only one: independent
// operators run the same server and speak the same v2 API, so the engine can
// walk a list and use whichever is answering. Boltz stays first — while it is
// healthy nothing about the engine changes.
//
// The catch that shapes this whole module: a backend with swap creation
// switched off still answers every GET with a full, healthy-looking pair matrix
// — limits, fees, pair hashes, HTTP 200. Boltz has been in exactly that state
// since 2026-08-03. So liveness CANNOT be read from `/v2/version` or
// `/v2/swap/*`; it has to come from the creation path itself.
//
// Port of depix-frontend/wallet/boltz/providers.js, with one addition the
// browser never needed: the engine is a long-lived process that runs swaps
// CONCURRENTLY, and `boltz-swaps` keeps a single process-wide config. See
// `withProvider` for how a per-call provider survives that.

import { AsyncLocalStorage } from "node:async_hooks";
import { ConversionError, GuardrailError, WalletError } from "../../errors.js";
import { defaultLogger, type Logger } from "../../logger.js";

export type SwapProviderId = "boltz" | "coinos";

export interface SwapProvider {
  readonly id: SwapProviderId;
  readonly name: string;
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly contact: string;
}

export const SWAP_PROVIDERS: readonly SwapProvider[] = Object.freeze([
  Object.freeze({
    id: "boltz" as const,
    name: "Boltz",
    apiUrl: "https://api.boltz.exchange",
    wsUrl: "wss://api.boltz.exchange/v2/ws",
    contact: "https://boltz.exchange"
  }),
  Object.freeze({
    id: "coinos" as const,
    name: "Coinos",
    apiUrl: "https://swap.coinos.io",
    wsUrl: "wss://swap.coinos.io/v2/ws",
    contact: "https://t.me/coinoswallet"
  })
]);

/**
 * The L-BTC → USDC/USDT route is not a plain swap. It rides Boltz's own hosted
 * engine — an EVM leg, a DEX, a bridge and a gas sponsor — none of which ships
 * with `boltz-backend`. A fallback operator can serve Lightning and still have
 * no such route, so this one stays PINNED rather than following the selection.
 */
export const STABLECOIN_PROVIDER: SwapProvider = SWAP_PROVIDERS[0]!;

/**
 * Resolve a provider id persisted in a swap record. A swap belongs to whoever
 * created it: watching, claiming and refunding must go back to that backend
 * even when the process has since selected another (Boltz recovering must not
 * strand a Coinos swap, and vice versa). Records written before providers
 * existed carry no id — those are all Boltz swaps, so Boltz is the default.
 */
export function getProviderById(id: string | null | undefined): SwapProvider {
  return SWAP_PROVIDERS.find((p) => p.id === id) ?? SWAP_PROVIDERS[0]!;
}

/** No backend is creating swaps right now — typed, retryable, actionable (G3). */
export function noSwapProviderError(what = "Lightning swaps"): ConversionError {
  return new ConversionError(
    "SWAP_PROVIDER_UNAVAILABLE",
    `No swap provider is accepting swaps right now — ${what} cannot be created.`,
    {
      details: {
        retryable: true,
        providers: SWAP_PROVIDERS.map((p) => ({ id: p.id, name: p.name, contact: p.contact })),
        nextStep:
          "the backends have swap creation switched off; in-flight swaps still claim and refund normally. " +
          "Retry later, or use a route that does not transit a swap provider (wallet.quote() marks the " +
          "unavailable ones)."
      }
    }
  );
}

/**
 * Every backend was ASKED to create this swap and every one refused — a stronger
 * statement than the probe's, and worth its own message: it names each operator
 * with what it actually said, so the agent reporting it is not guessing.
 */
export function allProvidersRefusedError(
  attempts: readonly { provider: SwapProvider; error: unknown }[],
  what = "Lightning swaps"
): ConversionError {
  const said = attempts.map(
    ({ provider, error }) => `${provider.name}: ${String((error as Error)?.message ?? error)}`
  );
  return new ConversionError(
    "SWAP_PROVIDER_UNAVAILABLE",
    `No swap provider accepted the swap — ${what} cannot be created. ${said.join(" | ")}`,
    {
      ...(attempts[0] ? { cause: attempts[0].error } : {}),
      details: {
        retryable: true,
        providers: attempts.map(({ provider, error }) => ({
          id: provider.id,
          name: provider.name,
          contact: provider.contact,
          refusal: String((error as Error)?.message ?? error)
        })),
        nextStep:
          "the swap was offered to every backend in turn and each refused it; nothing was locked. " +
          "Retry later, or use a route that does not transit a swap provider (wallet.quote() marks the " +
          "unavailable ones)."
      }
    }
  );
}

/** Boltz specifically is down, and this route cannot move to another operator. */
export function stablecoinProviderUnavailableError(): ConversionError {
  return new ConversionError(
    "SWAP_PROVIDER_UNAVAILABLE",
    `${STABLECOIN_PROVIDER.name} is not creating swaps right now — the L-BTC → stablecoin route is unavailable.`,
    {
      details: {
        retryable: true,
        provider: STABLECOIN_PROVIDER.id,
        nextStep:
          "this route rides the provider's own hosted EVM engine, so it cannot fall back to another " +
          "operator. Retry later, or deliver USDT through the sideshift route (custodial — wallet.quote() " +
          "lists it)."
      }
    }
  );
}

// ─── honest liveness probe ────────────────────────────────────────────────────

/**
 * An amount every backend rejects before it does any work. The probe therefore
 * exercises the real creation path — the only honest liveness signal — without
 * ever creating a swap. Raising it above the smallest known minimum (100 sats
 * on Boltz) would turn every probe into a real swap.
 */
const PROBE_AMOUNT_SATS = 1;

/**
 * secp256k1's generator point — a well-formed public key that passes input
 * validation. It is NOT secret (its private key is 1); the probe's real safety
 * is elsewhere: the response is discarded, and the preimage hash is random with
 * no known preimage, so even a hypothetical accepted probe would produce a hold
 * invoice that can never settle and never locks anything.
 */
const PROBE_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const PROBE_TIMEOUT_MS = 8_000;

/**
 * The one complaint that PROVES the creation path ran. `invoiceAmount: 1` is
 * below every backend's minimum, so a backend that got as far as validating the
 * amount is a backend that would have created the swap for a real one.
 *
 * This is an ALLOWLIST, and that direction is the whole point. Reading liveness
 * as "not one of the maintenance phrases I know" fails OPEN: the first refusal
 * an operator words differently is read as alive, the selection pins to a
 * backend that creates nothing, and every swap fails while a healthy fallback
 * sits unused. Reading it as "alive only if the amount complaint came back"
 * fails the other way — reword THIS phrase and the healthy backend is passed
 * over for the fallback, which costs a slower operator and no money at all.
 */
const AMOUNT_REFUSAL = /less than minimal|beneath.?minimal|below the minimum|too small|minimum amount/i;

export type ProbeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ status: number; text(): Promise<string> }>;

function probeBody(): string {
  const preimageHash = new Uint8Array(32);
  globalThis.crypto.getRandomValues(preimageHash);
  return JSON.stringify({
    from: "BTC",
    to: "L-BTC",
    claimPublicKey: PROBE_PUBLIC_KEY,
    preimageHash: Array.from(preimageHash, (b) => b.toString(16).padStart(2, "0")).join(""),
    invoiceAmount: PROBE_AMOUNT_SATS
  });
}

/**
 * Reports whether `provider` is currently creating swaps.
 *
 * The reply is read for WHICH complaint came back, not for the status code —
 * both answers are HTTP 400:
 *   "swap creation is disabled"        -> the switch is off
 *   "1 is less than minimal of 25000"  -> the creation path ran; it is alive
 *
 * Only the second answer counts as alive. Everything else a 4xx can say is
 * "dead", including wordings nobody here has seen — see AMOUNT_REFUSAL for why
 * the unknown case belongs on that side.
 *
 * `swap creation is disabled` is a backend-wide switch (reverse, submarine and
 * chain creation return it identically), so one probe stands for every swap type.
 */
export async function probeProvider(
  provider: SwapProvider,
  fetchImpl?: ProbeFetch,
  logger: Pick<Logger, "warn"> = defaultLogger
): Promise<boolean> {
  const doFetch =
    fetchImpl ?? (typeof fetch === "function" ? (fetch.bind(globalThis) as unknown as ProbeFetch) : null);
  if (!doFetch) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(`${provider.apiUrl}/v2/swap/reverse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: probeBody(),
      signal: controller.signal
    });
    // An accepted probe is alive by the strongest possible evidence and a
    // surprise worth saying out loud: 1 sat cleared a minimum, so either the
    // limit moved or this backend does not enforce one, and the probe now
    // leaves a real (unsettleable, unfunded) swap behind on every call.
    if (res.status < 300) {
      logger.warn("swap provider ACCEPTED the 1-sat liveness probe — it created a swap", {
        provider: provider.id,
        status: res.status
      });
      return true;
    }
    if (res.status >= 500) return false;
    return AMOUNT_REFUSAL.test(await res.text());
  } catch {
    // Unreachable, aborted, DNS failure — all mean "not this one".
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ─── selection (cached per process) ───────────────────────────────────────────

export interface SelectProviderOptions {
  fetchImpl?: ProbeFetch;
  /** Re-probe even when a selection is cached. */
  force?: boolean;
  /** Injected clock for the cache TTL (tests). Default: Date.now. */
  now?: () => number;
}

/**
 * How long a probed answer — the Lightning selection and the pinned stablecoin
 * route's liveness alike — is trusted before the list is walked again.
 *
 * Both are cached because a quote must belong to whoever will serve the swap,
 * and an uncached answer would probe on every call. Without an expiry, though,
 * the cache outlives the outage that filled it: an operator flips creation back
 * on and a process that fell to the fallback stays there until it restarts.
 * Ten minutes is short enough that recovery is measured in minutes, long enough
 * that a busy process probes at most a handful of times an hour.
 */
export const SELECTION_TTL_MS = 10 * 60_000;

let selection: Promise<SwapProvider> | null = null;
let selected: SwapProvider | null = null;
let selectedAt = 0;
/** A selection the operator PINNED (forceSwapProvider) rather than probed. */
let selectionPinned = false;

/**
 * Resolve the provider this process creates Lightning swaps with, probing the
 * list in order.
 *
 * The result is cached for SELECTION_TTL_MS, after which the walk starts from
 * the TOP again — Boltz first — so a recovered operator is used again without a
 * restart. A REJECTED selection is not cached at all, so the next attempt
 * re-probes a list that may have come back. A PINNED selection never expires:
 * `forceSwapProvider` is someone saying they know better, and the dry-run
 * harness (and the unit suite) must stay where they were put.
 */
export function selectSwapProvider(options: SelectProviderOptions = {}): Promise<SwapProvider> {
  const now = (options.now ?? Date.now)();
  const fresh = selectionPinned || now - selectedAt < SELECTION_TTL_MS;
  if (selection && fresh && !options.force) return selection;
  const pending = (async () => {
    for (const provider of SWAP_PROVIDERS) {
      if (await probeProvider(provider, options.fetchImpl)) {
        selected = provider;
        return provider;
      }
    }
    throw noSwapProviderError();
  })();
  selection = pending;
  selectedAt = now;
  selectionPinned = false;
  pending.catch(() => {
    if (selection === pending) selection = null;
  });
  return pending;
}

/**
 * The provider already chosen, or null before the first selection settles.
 * Synchronous on purpose — callers labelling a swap must never block on a probe.
 */
export function getSelectedProvider(): SwapProvider | null {
  return selected;
}

/**
 * Reports whether a failed CREATION call was the BACKEND refusing, as opposed to
 * one of OUR OWN typed guards firing.
 *
 * The test is DELIBERATELY inverted — anything that is not one of our typed
 * errors counts as the backend refusing. Matching the refusal by its wording
 * instead would fail in both directions at once the day an operator rewords it:
 * the probe would read the new text as alive, and this would read it as our
 * fault, pinning the process to a dead backend for its whole life with the
 * fallback silently never firing. The cost of being wrong the other way is one
 * re-probe and one extra creation attempt.
 */
export function isProviderRefusal(err: unknown): boolean {
  return !(err instanceof ConversionError || err instanceof WalletError || err instanceof GuardrailError);
}

/**
 * Drop the cached selection when a CREATION call failed in a way that blames the
 * provider, so the next attempt re-probes the list instead of retrying a dead
 * backend for the life of the process. Reports whether it invalidated.
 */
export function invalidateSelectionOnCreationFailure(err: unknown): boolean {
  if (!isProviderRefusal(err)) return false;
  selection = null;
  return true;
}

/**
 * The whole list to offer a swap to, starting with `first`. Everyone else keeps
 * the registry's order, so a fallback that answers is still only used until the
 * one above it is creating swaps again.
 */
export function providersFrom(first: SwapProvider): readonly SwapProvider[] {
  return [first, ...SWAP_PROVIDERS.filter((p) => p.id !== first.id)];
}

/**
 * Pin the selection to one provider by id, skipping the probe. For the dry-run
 * harness: the probe picks whoever is healthy, but validating a provider means
 * running against THAT provider, including one the probe would have skipped.
 */
export function forceSwapProvider(id: SwapProviderId): SwapProvider {
  const provider = SWAP_PROVIDERS.find((p) => p.id === id);
  if (!provider) {
    throw new ConversionError(
      "SWAP_PROVIDER_UNAVAILABLE",
      `Unknown swap provider "${id}" — known: ${SWAP_PROVIDERS.map((p) => p.id).join(", ")}`
    );
  }
  selected = provider;
  selection = Promise.resolve(provider);
  selectionPinned = true;
  return provider;
}

/** Test hook — forget the cached selection and the stablecoin liveness answer. */
export function resetSwapProviderSelection(): void {
  selection = null;
  selected = null;
  selectedAt = 0;
  selectionPinned = false;
  stablecoinLiveness = null;
  stablecoinLivenessAt = 0;
}

// ─── the pinned stablecoin route's own liveness ───────────────────────────────

let stablecoinLiveness: Promise<boolean> | null = null;
let stablecoinLivenessAt = 0;

/** Reports whether the PINNED stablecoin provider is creating swaps (cached). */
export function isStablecoinProviderLive(options: SelectProviderOptions = {}): Promise<boolean> {
  // The kill switch is backend-WIDE (reverse, submarine and chain creation all
  // return it), so a selection that already landed on this provider answers the
  // question — no second probe. A forced selection is the operator saying they
  // know better, and is trusted here for the same reason.
  if (!options.force && getSelectedProvider()?.id === STABLECOIN_PROVIDER.id) return Promise.resolve(true);
  const now = (options.now ?? Date.now)();
  // This route has no fallback to fall to, so a stale "dead" here is the whole
  // rail staying off after the operator switched it back on — the same TTL.
  if (stablecoinLiveness && !options.force && now - stablecoinLivenessAt < SELECTION_TTL_MS) {
    return stablecoinLiveness;
  }
  const pending = probeProvider(STABLECOIN_PROVIDER, options.fetchImpl);
  stablecoinLiveness = pending;
  stablecoinLivenessAt = now;
  // A probe that threw tells us nothing — don't cache the ignorance.
  pending.catch(() => {
    if (stablecoinLiveness === pending) stablecoinLiveness = null;
  });
  return pending;
}

/** Throw the typed, actionable error unless the pinned stablecoin route is live. */
export async function assertStablecoinProviderLive(options: SelectProviderOptions = {}): Promise<void> {
  if (!(await isStablecoinProviderLive(options))) throw stablecoinProviderUnavailableError();
}

// ─── what the route table may honestly offer right now ────────────────────────

/** The two rails a route can be created on; they fail independently. */
export type BoltzRail = "lightning" | "stablecoin";

/** Which provider-backed rails can be CREATED right now. Recovery is unaffected. */
export interface BoltzRouteAvailability {
  /** Lightning send + receive — follows the provider list. */
  lightning: boolean;
  /** L-BTC → USDC/USDT — pinned to Boltz, so it can be down while Lightning is up. */
  stablecoin: boolean;
  /** Who would serve a Lightning swap, when one is answering. */
  lightningProvider: SwapProvider | null;
}

/**
 * Probe both rails so route discovery can flag a route the backend will refuse.
 * Never throws — an unavailable rail is an answer, not an error.
 */
export async function boltzRouteAvailability(
  options: SelectProviderOptions = {}
): Promise<BoltzRouteAvailability> {
  const lightningProvider = await selectSwapProvider(options).catch(() => null);
  const stablecoin = await isStablecoinProviderLive(options).catch(() => false);
  return { lightning: lightningProvider !== null, stablecoin, lightningProvider };
}

// ─── per-call provider routing over a process-wide SDK config ─────────────────

/**
 * `boltz-swaps` keeps ONE active config for the whole process and offers no
 * per-call base URL, so "re-point the SDK, then call it" is not a strategy here:
 * the engine runs swaps concurrently (a Lightning send on the fallback operator
 * while a stablecoin swap is mid-flight on Boltz), and any `await` between the
 * re-point and the request is a window for the other flow to re-point it back.
 *
 * The config is therefore installed ONCE with a DYNAMIC `boltzApiUrl` getter,
 * and the answer is read from an async-context store: every request resolves the
 * URL belonging to ITS OWN call chain, at the moment the request is built. No
 * lock, so a 20-minute stablecoin execution never blocks a Lightning send.
 *
 * Outside any `withProvider` the answer is Boltz — the historical default. A
 * flow that forgot to declare its provider therefore talks to Boltz and fails
 * loudly, instead of silently inheriting whatever another flow selected.
 */
const activeApiUrl = new AsyncLocalStorage<string>();

/** Run `fn` with every boltz-swaps request inside it routed to `provider`. */
export function withProvider<T>(provider: SwapProvider, fn: () => Promise<T>): Promise<T> {
  return activeApiUrl.run(provider.apiUrl, fn);
}

/** The API base the CURRENT call chain talks to. */
export function currentBoltzApiUrl(): string {
  return activeApiUrl.getStore() ?? SWAP_PROVIDERS[0]!.apiUrl;
}

/**
 * The mainnet preset with `boltzApiUrl` turned into a live getter. boltz-swaps
 * reads config keys through getters on every access (`mergeWithDefaults` /
 * `createBoltzClient`'s proxy), so this stays dynamic however it is installed.
 */
export function dynamicMainnetConfig<T extends object>(mainnetConfig: T): T {
  return {
    ...mainnetConfig,
    get boltzApiUrl(): string {
      return currentBoltzApiUrl();
    }
  };
}
