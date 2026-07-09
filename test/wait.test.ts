// wait_for_checkout loop (spec §5). Time and IO are injected, so no real timers.

import { describe, expect, it } from "vitest";
import { runWaitLoop, type WaitProgress } from "../src/tools/wait.js";
import { ToolError } from "../src/errors.js";

/** A fake clock advanced by the injected sleep. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("runWaitLoop", () => {
  it("emits progress on each status transition and ends terminal", async () => {
    const clock = fakeClock();
    const statuses = ["pending", "processing", "approved", "completed"];
    let i = 0;
    const progress: WaitProgress[] = [];
    const res = await runWaitLoop({
      checkoutId: "chk_1",
      timeoutSeconds: 300,
      pollStatus: async () => ({ status: statuses[Math.min(i++, statuses.length - 1)], is_live: false }),
      sleep: clock.sleep,
      now: clock.now,
      onProgress: (p) => {
        progress.push(p);
      },
      pollIntervalMs: 5000,
    });
    expect(res).toMatchObject({ status: "completed", terminal: true, timed_out: false, is_live: false });
    expect(progress.map((p) => p.status)).toEqual(["pending", "processing", "approved", "completed"]);
  });

  it("returns timed_out with the last observed status when the budget elapses", async () => {
    const clock = fakeClock();
    const res = await runWaitLoop({
      checkoutId: "chk_1",
      timeoutSeconds: 12, // 12s budget, 5s interval → times out still pending
      pollStatus: async () => ({ status: "pending", is_live: true }),
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 5000,
    });
    expect(res).toMatchObject({ status: "pending", terminal: false, timed_out: true, is_live: true });
  });

  it("never sleeps past the deadline (defensive cap; returns instead of being killed)", async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    await runWaitLoop({
      checkoutId: "chk_1",
      timeoutSeconds: 7,
      pollStatus: async () => ({ status: "pending", is_live: false }),
      sleep: async (ms) => {
        sleeps.push(ms);
        await clock.sleep(ms);
      },
      now: clock.now,
      pollIntervalMs: 5000,
    });
    // Second sleep is clamped to the remaining budget (2s), not the full 5s.
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(5000);
    expect(sleeps).toContain(2000);
  });

  it("tolerates a retryable poll error and keeps waiting", async () => {
    const clock = fakeClock();
    const seq: Array<() => Promise<{ status: string; is_live: boolean }>> = [
      async () => {
        throw new ToolError("rate limited", "merchant_rate_limited", { retryable: true });
      },
      async () => ({ status: "completed", is_live: false }),
    ];
    let i = 0;
    const res = await runWaitLoop({
      checkoutId: "chk_1",
      timeoutSeconds: 300,
      pollStatus: () => seq[i++](),
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 5000,
    });
    expect(res.terminal).toBe(true);
    expect(res.status).toBe("completed");
  });

  it("propagates a non-retryable poll error", async () => {
    const clock = fakeClock();
    await expect(
      runWaitLoop({
        checkoutId: "chk_1",
        timeoutSeconds: 300,
        pollStatus: async () => {
          throw new ToolError("nope", "invalid_api_key", { retryable: false });
        },
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toMatchObject({ code: "invalid_api_key" });
  });

  it("treats a per-poll fetch timeout (TimeoutError) as transient and keeps waiting", async () => {
    const clock = fakeClock();
    const seq: Array<() => Promise<{ status: string; is_live: boolean }>> = [
      async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      },
      async () => ({ status: "completed", is_live: false }),
    ];
    let i = 0;
    const res = await runWaitLoop({
      checkoutId: "chk_1",
      timeoutSeconds: 300,
      pollStatus: () => seq[i++](),
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 5000,
    });
    expect(res.terminal).toBe(true);
  });

  it("passes the remaining budget to each poll (bounded fetch)", async () => {
    const clock = fakeClock();
    const budgets: number[] = [];
    const statuses = ["pending", "completed"];
    let i = 0;
    await runWaitLoop({
      checkoutId: "chk_1",
      timeoutSeconds: 12,
      pollStatus: async (remainingMs) => {
        budgets.push(remainingMs);
        return { status: statuses[Math.min(i++, 1)], is_live: false };
      },
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 5000,
    });
    expect(budgets[0]).toBe(12_000);
    expect(budgets[1]).toBe(7_000); // 12s budget minus the 5s sleep
  });

  it("stops immediately when the client-disconnect signal is aborted", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    controller.abort();
    let polls = 0;
    await expect(
      runWaitLoop({
        checkoutId: "chk_1",
        timeoutSeconds: 300,
        pollStatus: async () => {
          polls++;
          return { status: "pending", is_live: false };
        },
        sleep: clock.sleep,
        now: clock.now,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(polls).toBe(0); // aborted before the first poll
  });

  it("timed_out edge: retryable error AFTER the deadline with an observed status → timed_out, not throw", async () => {
    const clock = fakeClock();
    const seq: Array<() => Promise<{ status: string; is_live: boolean }>> = [
      async () => ({ status: "processing", is_live: true }),
      async () => {
        throw new ToolError("rate limited", "merchant_rate_limited", { retryable: true });
      },
    ];
    let i = 0;
    const res = await runWaitLoop({
      checkoutId: "chk_1",
      timeoutSeconds: 6, // first poll ok, 5s sleep, second poll fails at t=5s; deadline hits during the next sleep
      pollStatus: () => seq[Math.min(i++, 1)](),
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 5000,
    });
    expect(res).toMatchObject({ status: "processing", timed_out: true, terminal: false, is_live: true });
  });

  it("timed_out edge: never-observed status does NOT fabricate 'pending' — it throws", async () => {
    const clock = fakeClock();
    await expect(
      runWaitLoop({
        checkoutId: "chk_1",
        timeoutSeconds: 6,
        pollStatus: async () => {
          throw new ToolError("unavailable", "service_unavailable", { retryable: true });
        },
        sleep: clock.sleep,
        now: clock.now,
        pollIntervalMs: 5000,
      }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });
});

describe("wait_for_checkout schema announces the env-driven maximum (spec §2.5)", async () => {
  const { waitForCheckoutInput } = await import("../src/schemas.js");
  it("uses MCP_MAX_WAIT_SECONDS as the schema maximum", () => {
    const shape = waitForCheckoutInput(120);
    const parsed = shape.timeout_seconds.safeParse(200);
    expect(parsed.success).toBe(false); // 200 > 120 announced max
    expect(shape.timeout_seconds.safeParse(100).success).toBe(true);
  });
});
