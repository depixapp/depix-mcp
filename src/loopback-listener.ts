// The one-shot loopback listener the sign-in redirect lands on.
//
// BINDING IS THE PROMISE. waitForLoopbackCallback resolves only after the
// socket is `listening`, and hands back the callback as a SECOND promise. That
// split is not cosmetic: `login` awaits the bind before it opens the browser,
// so a port conflict is a failure with no browser window and no authorization
// code in flight. The earlier shape — one promise for both — let the browser
// open first and delivered the code to whoever held the port.
//
// Bound to 127.0.0.1 ONLY (never 0.0.0.0): the authorization code arrives in
// the query string, and a listener on every interface would accept it from the
// network. The port is fixed because the redirect URI is registered byte for
// byte with the authorization server, so a busy port cannot be worked around by
// moving — it is a hard, loud EADDRINUSE.
//
// "One shot" means one CALLBACK: the first request on the callback path is the
// one, and the server closes as soon as it has answered. Requests to any other
// path (a browser asking for /favicon.ico, say) get a 404 and do NOT consume
// it — otherwise the favicon would win the race against the redirect.

import { createServer } from "node:http";
import type { LoopbackCallback, LoopbackListener, WaitForCallback } from "./login-flow.js";

export const waitForLoopbackCallback: WaitForCallback = (opts) =>
  new Promise<LoopbackListener>((bound, failedToBind) => {
    let settled = false;
    let closed = false;
    let deliver: (cb: LoopbackCallback) => void;
    let abandon: (err: Error) => void;
    const callback = new Promise<LoopbackCallback>((resolve, reject) => {
      deliver = resolve;
      abandon = reject;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
      if (settled || url.pathname !== opts.path) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      settled = true;
      clearTimeout(timer);
      deliver({
        query: url.searchParams,
        respond: (page) => {
          res.writeHead(page.status, { "Content-Type": "text/html; charset=utf-8" }).end(page.html);
          close();
        },
      });
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.close();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      close();
      abandon(new Error(`No sign-in reply arrived within ${Math.round(opts.timeoutMs / 1000)}s.`));
    }, opts.timeoutMs);
    timer.unref?.();

    server.on("error", (err) => {
      // Before `listening`, an error is a failure to bind and belongs to the
      // OUTER promise — that is what keeps the browser shut on EADDRINUSE.
      if (!listening) {
        clearTimeout(timer);
        failedToBind(err);
        return;
      }
      if (settled) return;
      settled = true;
      close();
      abandon(err);
    });

    let listening = false;
    server.on("listening", () => {
      listening = true;
      bound({ callback, close });
    });
    server.listen(opts.port, "127.0.0.1");
  });
