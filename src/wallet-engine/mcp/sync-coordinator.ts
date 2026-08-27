// The sync coordinator (SPEC_AGENT_ONBOARDING §3.8) — the MCP-facade layer that
// decides WHEN the wallet scans the chain. It lives HERE, in the facade, and NOT
// inside the engine: DepixWallet.sync() is a pure primitive, and the RULE ("read
// or spend → sync first; spend → sync after") is a product decision the facade
// owns.
//
// THE RULE
//   before(): a read or a pre-spend refresh. FAIL-SOFT — a provider outage
//             returns { stale: true } and the caller serves the last persisted
//             snapshot. A read never throws; a spend still proceeds (any failure
//             here lands BEFORE money moves, and broadcast rejects a double-spend
//             anyway — never wedge the whole wallet on an esplora blip).
//   after():  money just moved — refresh so the very next read reflects it.
//             NEVER throws: the money is already gone/received, so a failed
//             post-sync is reported as { postSyncFailed: true } beside the txid,
//             not as a tool error.
//
// DEDUP (~10s): N tools in one turn must not pay for N scans. before() treats a
// sync that succeeded within the window as fresh and skips. after() bypasses the
// window (a spend dirties the view regardless) and RESETS it, so the following
// read dedups off the post-spend scan. The engine already coalesces concurrent
// sync() calls in flight; this window sits on top of that.

/** The minimal surface the coordinator drives — DepixWallet satisfies it. */
export interface Syncable {
  sync(options?: { rescan?: boolean }): Promise<{ updated: boolean }>;
}

export interface SyncCoordinatorOptions {
  /** Dedup window in ms — skip a pre-op sync if one succeeded this recently. Default 10_000. */
  windowMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/** Default dedup window (§3.8): ~10s covers a single agent turn's fan-out. */
export const DEFAULT_SYNC_DEDUP_WINDOW_MS = 10_000;

export class SyncCoordinator {
  private lastSyncAtMs = Number.NEGATIVE_INFINITY;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: SyncCoordinatorOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_SYNC_DEDUP_WINDOW_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Refresh before a read or a spend. Returns { stale: true } when the refresh
   * failed and the caller must serve the persisted snapshot — never throws.
   * Deduped: a successful sync within the window is treated as fresh.
   */
  async before(wallet: Syncable): Promise<{ stale: boolean }> {
    if (this.now() - this.lastSyncAtMs < this.windowMs) return { stale: false };
    try {
      await wallet.sync();
      this.lastSyncAtMs = this.now();
      return { stale: false };
    } catch {
      // Provider outage: the read/spend proceeds off the snapshot with a warning.
      return { stale: true };
    }
  }

  /**
   * Refresh after money moved. Returns { postSyncFailed: true } when the refresh
   * failed — NEVER throws (the money already moved). Bypasses the dedup window
   * and resets it so the next read dedups off this scan.
   */
  async after(wallet: Syncable): Promise<{ postSyncFailed: boolean }> {
    try {
      await wallet.sync();
      this.lastSyncAtMs = this.now();
      return { postSyncFailed: false };
    } catch {
      return { postSyncFailed: true };
    }
  }
}
