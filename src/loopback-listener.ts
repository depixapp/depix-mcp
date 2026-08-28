// The one-shot loopback listener the sign-in redirect lands on.
//
// Bound to 127.0.0.1 ONLY (never 0.0.0.0): the authorization code arrives in
// the query string, and a listener on every interface would accept it from the
// network. The port is fixed because the redirect URI is registered byte for
// byte with the authorization server — a busy port is therefore a hard, loud
// failure (EADDRINUSE) rather than a silent move to another port the server
// would refuse to redirect to.
//
// "One shot" means one CALLBACK: the first request on the callback path is the
// one, and the server closes as soon as it has answered. Requests to any other
// path (a browser asking for /favicon.ico, say) get a 404 and do NOT consume
// it — otherwise the favicon would win the race against the redirect.

import { createServer } from "node:http";
import type { LoopbackCallback, WaitForCallback } from "./login-flow.js";

export const waitForLoopbackCallback: WaitForCallback = (opts) =>
  new Promise<LoopbackCallback>((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
      if (settled || url.pathname !== opts.path) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        query: url.searchParams,
        respond: (page) => {
          res.writeHead(page.status, { "Content-Type": "text/html; charset=utf-8" }).end(page.html);
          server.close();
        },
      });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error(`No sign-in reply arrived within ${Math.round(opts.timeoutMs / 1000)}s.`));
    }, opts.timeoutMs);
    timer.unref?.();

    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    server.listen(opts.port, "127.0.0.1");
  });
