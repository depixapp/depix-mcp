// wait_for_checkout — server-side polling with MCP progress notifications
// (spec §5). The agent makes ONE tool call; the poll loop lives here and emits
// progress on each status transition. The internal deadline ALWAYS fires with
// margin below the platform cap, returning { status: last-observed,
// timed_out: true } rather than being killed (spec §2.5, §5.2):
//   - every poll fetch is bounded by AbortSignal.timeout(min(10s, remaining)),
//   - every sleep (including apiClient retry sleeps) respects the same signal,
//   - a client disconnect (the handler's AbortSignal) stops the loop at once.

import type { ApiClient } from "../apiClient.js";
import { ToolError } from "../errors.js";
import { TERMINAL_CHECKOUT_STATUSES } from "../schemas.js";
import { fetchCheckoutStatus, type CheckoutStatusSnapshot } from "./checkouts.js";

const POLL_INTERVAL_MS = 5000; // never below 5s — protects the merchant budget.
const MAX_POLL_FETCH_MS = 10_000; // per-poll HTTP budget.

// Symbolic progress lifecycle for progress notifications.
const LIFECYCLE = ["pending", "processing", "approved", "completed"];
const LIFECYCLE_TOTAL = LIFECYCLE.length;

function progressFor(status: string): number {
  const i = LIFECYCLE.indexOf(status);
  return i >= 0 ? i + 1 : LIFECYCLE_TOTAL;
}

export interface WaitProgress {
  progress: number;
  total: number;
  status: string;
}

export interface WaitLoopDeps {
  checkoutId: string;
  timeoutSeconds: number;
  /** Poll once; receives the remaining budget so the fetch can be bounded. */
  pollStatus: (remainingMs: number) => Promise<CheckoutStatusSnapshot>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onProgress?: (p: WaitProgress) => Promise<void> | void;
  pollIntervalMs?: number;
  /** Client-disconnect signal; aborts the loop (nobody will read the result). */
  signal?: AbortSignal;
}

export interface WaitResult {
  checkout_id: string;
  status: string;
  terminal: boolean;
  timed_out: boolean;
  is_live: boolean;
}

function isAbortLike(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

function throwIfClientGone(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Client disconnected", "AbortError");
  }
}

/** Pure-ish loop; all time/IO injected so tests need no real timers. */
export async function runWaitLoop(deps: WaitLoopDeps): Promise<WaitResult> {
  const interval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const start = deps.now();
  const deadline = start + deps.timeoutSeconds * 1000;

  let lastStatus = "";
  let isLive = false;

  // timed_out edge (review item): only return timed_out with an OBSERVED
  // status — never fabricate one. If no poll ever succeeded, propagate the
  // last error instead.
  const timedOutOrThrow = (err?: unknown): WaitResult => {
    if (lastStatus) {
      return {
        checkout_id: deps.checkoutId,
        status: lastStatus,
        terminal: false,
        timed_out: true,
        is_live: isLive,
      };
    }
    throw err ??
      new ToolError(
        "Wait budget elapsed before the checkout status could be observed.",
        "wait_timeout",
        { retryable: true },
      );
  };

  for (;;) {
    throwIfClientGone(deps.signal);
    let snap: CheckoutStatusSnapshot;
    try {
      snap = await deps.pollStatus(Math.max(1, deadline - deps.now()));
    } catch (err) {
      // Client disconnect: stop immediately — nobody will read the result.
      if (deps.signal?.aborted) throw err;
      // Transient blips (retryable API errors, per-poll fetch timeouts) must
      // not abort the wait; non-retryable errors propagate.
      const transient = (err instanceof ToolError && err.retryable) || isAbortLike(err);
      if (!transient) throw err;
      if (deps.now() >= deadline) return timedOutOrThrow(err);
      await deps.sleep(Math.min(interval, Math.max(0, deadline - deps.now())));
      if (deps.now() >= deadline) return timedOutOrThrow(err);
      continue;
    }

    isLive = snap.is_live;
    if (snap.status !== lastStatus) {
      lastStatus = snap.status;
      await deps.onProgress?.({
        progress: progressFor(snap.status),
        total: LIFECYCLE_TOTAL,
        status: snap.status,
      });
    }

    if ((TERMINAL_CHECKOUT_STATUSES as readonly string[]).includes(snap.status)) {
      return {
        checkout_id: deps.checkoutId,
        status: snap.status,
        terminal: true,
        timed_out: false,
        is_live: isLive,
      };
    }

    if (deps.now() >= deadline) return timedOutOrThrow();
    const remaining = deadline - deps.now();
    await deps.sleep(Math.min(interval, remaining));
    if (deps.now() >= deadline) return timedOutOrThrow();
  }
}

export interface WaitContext {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (p: WaitProgress) => Promise<void> | void;
  /** Handler abort signal (client disconnect / cancellation). */
  signal?: AbortSignal;
}

function realSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  return (ms: number) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => resolve(), ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
}

/** Combine the client-disconnect signal with a per-poll timeout. */
function pollSignal(remainingMs: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.min(MAX_POLL_FETCH_MS, Math.max(1, remainingMs)));
  if (!outer) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([outer, timeout]);
  // Degraded (Node <20.3): the timeout still bounds the fetch; disconnect is
  // detected between polls by the loop's own signal checks.
  return timeout;
}

export async function waitForCheckout(
  client: ApiClient,
  args: { checkout_id: string; timeout_seconds: number },
  ctx: WaitContext = {},
): Promise<WaitResult> {
  return runWaitLoop({
    checkoutId: args.checkout_id,
    timeoutSeconds: args.timeout_seconds,
    pollStatus: (remainingMs) =>
      fetchCheckoutStatus(client, args.checkout_id, pollSignal(remainingMs, ctx.signal)),
    sleep: ctx.sleep ?? realSleep(ctx.signal),
    now: ctx.now ?? Date.now,
    onProgress: ctx.onProgress,
    signal: ctx.signal,
  });
}
