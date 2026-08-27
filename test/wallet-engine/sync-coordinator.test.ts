// The sync coordinator (§3.8): the dedup window, fail-soft before(), and the
// never-throw after().

import { describe, expect, it } from "vitest";
import { SyncCoordinator } from "../../src/wallet-engine/mcp/sync-coordinator.js";

class SpyWallet {
  syncs = 0;
  fail = false;
  async sync(): Promise<{ updated: boolean }> {
    this.syncs++;
    if (this.fail) throw new Error("esplora down");
    return { updated: false };
  }
}

describe("SyncCoordinator (§3.8)", () => {
  it("before(): syncs the first time, then dedups within the window", async () => {
    let now = 1_000;
    const coord = new SyncCoordinator({ windowMs: 10_000, now: () => now });
    const w = new SpyWallet();

    expect(await coord.before(w)).toEqual({ stale: false });
    expect(w.syncs).toBe(1);

    now = 5_000; // within the 10s window → no second scan
    expect(await coord.before(w)).toEqual({ stale: false });
    expect(w.syncs).toBe(1);

    now = 12_000; // past the window → scans again
    expect(await coord.before(w)).toEqual({ stale: false });
    expect(w.syncs).toBe(2);
  });

  it("before(): a provider outage is FAIL-SOFT → { stale: true }, never throws", async () => {
    const coord = new SyncCoordinator();
    const w = new SpyWallet();
    w.fail = true;
    await expect(coord.before(w)).resolves.toEqual({ stale: true });
    // A failed sync does not advance the window, so the next call retries.
    w.fail = false;
    expect((await coord.before(w)).stale).toBe(false);
  });

  it("after(): NEVER throws — a failed post-sync is reported, not raised", async () => {
    const coord = new SyncCoordinator();
    const w = new SpyWallet();
    w.fail = true;
    await expect(coord.after(w)).resolves.toEqual({ postSyncFailed: true });
  });

  it("after(): bypasses the window and RESETS it so the next read dedups off this scan", async () => {
    let now = 1_000;
    const coord = new SyncCoordinator({ windowMs: 10_000, now: () => now });
    const w = new SpyWallet();

    await coord.before(w); // scan #1 at t=1000
    now = 2_000;
    await coord.after(w); // forced scan #2 at t=2000 (bypasses the window)
    expect(w.syncs).toBe(2);

    now = 5_000; // within 10s of the after() scan → dedup
    expect((await coord.before(w)).stale).toBe(false);
    expect(w.syncs).toBe(2);
  });
});
