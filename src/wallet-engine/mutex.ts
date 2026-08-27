/*
 * Copyright 2026 DePix App
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at http://www.apache.org/licenses/LICENSE-2.0 — see LICENSE.
 *
 * VENDORED ENGINE SOURCE — DO NOT EDIT HERE.
 * Origin:    https://github.com/depixapp/depix-sdk
 * Commit:    88228a10ca5fa275d64de9b3150bc75cc6a0bb8c
 * Path:      src/mutex.ts
 * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)
 *
 * DePix App owns this code and distributes THIS copy under Apache-2.0. The
 * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing
 * from that published tarball is reused here (spec §2.2).
 */
// Minimal async mutex — serializes a critical section WITHIN one process.
//
// The dataDir lock (§2.4) only guards ACROSS processes. It does nothing for
// concurrent async calls inside ONE process — e.g. Promise.all([send(a),
// send(b)]) or an injected LLM emitting parallel wallet_send tool calls, which
// is exactly the adversary the guardrails target (§4.1). Those interleave at
// every `await`, defeating any check→act sequence (TOCTOU): two sends both read
// used=0, both pass the daily cap, both sign. A per-instance mutex makes the
// enforce→sign→record section (and the nextReceiveIndex read-modify-write, and
// the guardrails-state read-modify-write) atomic units.
//
// Implementation: a promise chain. Each caller waits on the previous holder's
// tail; the tail is kept non-rejecting so one op's failure never wedges the
// queue (release-on-error), while the caller still observes its own rejection.

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` with exclusive access, queued behind any in-flight holder.
   * Resolves/rejects with `fn`'s result; the lock is released either way.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    // Keep the chain alive regardless of this op's outcome: swallow so a
    // rejection here does not reject the next waiter's `tail`.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
