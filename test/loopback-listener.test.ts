// The one real socket in the login flow. Everything else is injected, so this
// is the only place the actual bind/accept/close behaviour is proven.
//
// The load-bearing property is R1's: the returned promise resolves ONLY after
// the socket is listening. `login` awaits it before opening the browser, so a
// busy port can never end with the authorization code delivered to whoever
// holds it.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { waitForLoopbackCallback } from "../src/loopback-listener.js";

/** A port high enough to be free, distinct per test to avoid TIME_WAIT races. */
let nextPort = 47_800;
const port = () => nextPort++;

const opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
});

function squat(p: number, host = "127.0.0.1"): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => res.end("squatter"));
    server.once("error", reject);
    server.listen(p, host, () => {
      opened.push(server);
      resolve(server);
    });
  });
}

function firstNonLoopbackIpv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

describe("waitForLoopbackCallback", () => {
  it("resolves only once the socket is LISTENING", async () => {
    const p = port();
    const listener = await waitForLoopbackCallback({ port: p, path: "/callback", timeoutMs: 5000 });
    opened.push({ close: () => listener.close() });
    // Bound: a second bind on the same port must now be refused.
    await expect(squat(p)).rejects.toMatchObject({ code: "EADDRINUSE" });
    listener.close();
  });

  it("rejects with EADDRINUSE when the port is already held — and never resolves", async () => {
    const p = port();
    await squat(p);
    await expect(
      waitForLoopbackCallback({ port: p, path: "/callback", timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("delivers the callback query and closes the server after respond()", async () => {
    const p = port();
    const listener = await waitForLoopbackCallback({ port: p, path: "/callback", timeoutMs: 5000 });
    // NOT awaited yet: the response only exists once respond() is called, so
    // awaiting here would deadlock against the very handshake being tested.
    const res = fetch(`http://127.0.0.1:${p}/callback?code=AUTHCODE&state=S`);
    const callback = await listener.callback;
    expect(callback.query.get("code")).toBe("AUTHCODE");
    expect(callback.query.get("state")).toBe("S");

    callback.respond({ status: 200, html: "<p>done</p>" });
    expect(await (await res).text()).toContain("done");

    // Closed: the port is free again, which is what makes a second `login` work.
    await expect(squat(p)).resolves.toBeDefined();
  });

  it("a decoy request (favicon) gets a 404 and does NOT consume the one shot", async () => {
    // A browser asks for /favicon.ico on its own. If that consumed the single
    // callback, the real redirect would arrive at a closed socket.
    const p = port();
    const listener = await waitForLoopbackCallback({ port: p, path: "/callback", timeoutMs: 5000 });
    const decoy = await fetch(`http://127.0.0.1:${p}/favicon.ico`);
    expect(decoy.status).toBe(404);

    const real = fetch(`http://127.0.0.1:${p}/callback?code=REAL&state=S`);
    const callback = await listener.callback;
    expect(callback.query.get("code")).toBe("REAL");
    callback.respond({ status: 200, html: "ok" });
    expect(await (await real).text()).toBe("ok");
  });

  it("binds 127.0.0.1 ONLY — the code in the query is never offered to the network", async () => {
    const lan = firstNonLoopbackIpv4();
    if (lan === undefined) return; // no routable interface here; nothing to prove
    const p = port();
    const listener = await waitForLoopbackCallback({ port: p, path: "/callback", timeoutMs: 5000 });
    // Binding the SAME port on the LAN address only succeeds because the
    // listener took 127.0.0.1 alone. On 0.0.0.0 this would be EADDRINUSE.
    await expect(squat(p, lan)).resolves.toBeDefined();
    listener.close();
  });

  it("gives up on the timeout and frees the port", async () => {
    const p = port();
    const listener = await waitForLoopbackCallback({ port: p, path: "/callback", timeoutMs: 60 });
    await expect(listener.callback).rejects.toThrow(/sign-in reply/i);
    await expect(squat(p)).resolves.toBeDefined();
  });

  it("close() is idempotent and frees the port", async () => {
    const p = port();
    const listener = await waitForLoopbackCallback({ port: p, path: "/callback", timeoutMs: 5000 });
    listener.close();
    listener.close();
    await expect(squat(p)).resolves.toBeDefined();
  });
});
