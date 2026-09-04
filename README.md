# depix-mcp

[![smithery badge](https://smithery.ai/badge/depixapp/depix-mcp)](https://smithery.ai/servers/depixapp/depix-mcp)

The MCP (Model Context Protocol) server for [DePix App](https://depixapp.com) —
the agent-facing interface of the non-custodial Pix↔DePix payment gateway **and**
of a non-custodial Liquid wallet.

**One MCP, two levels of access.** Same package, same registry entry; what works
depends only on whether the running instance has a seed:

| | Level 1 — hosted | Level 2 — local |
|---|---|---|
| How | `https://mcp.depixapp.com/mcp` (Streamable HTTP) | `npx -y @depixapp/mcp` (stdio) |
| Runs on | DePix App's servers | **your** machine |
| Tools | **26** — receive Pix, status reads, onboarding/vault/webhook reads, support | **62** — the 26 **plus** 29 `wallet_*` and 7 account tools |
| Seed | none, ever | yours, never leaves the machine |
| Install | zero (claude.ai, ChatGPT) | Node.js ≥ 22.4 |

Custody is decided by **who holds the seed, not by the transport**. Every spend
materializes a signer **in-process**, and there is no remote-signing path — so
DePix App cannot host working wallet tools without becoming custodial, and does
not. That is physics, not a product tier.

## What it is (and isn't)

**Both levels:**

- **A pure client of the public DePix API** (`https://api.depixapp.com/api/*`) for
  the 26 gateway tools. It holds **zero critical credentials** — no provider token,
  no database, no webhook HMAC. Your `sk_` key is passed **verbatim** to the API
  on each call and lives only in memory for that request.
- **Same door as everyone.** No privileged path: the same auth, scopes and rate
  limits as any external agent.

**Level 1 (`mcp.depixapp.com`) only:** it never signs, never holds funds, never
stores your key. It has no wallet code at all — the wallet engine is not merely
disabled there, it is **structurally absent** from that deployment's import graph,
and a CI guard (`npm run guard:hosted`) fails the build if that ever changes.

**Level 2 (`npx`) only:** the 29 `wallet_*` tools hold, send, convert and pay —
signing locally, inside your own process, under guardrails (per-transaction and
rolling-24h BRL caps, optional allowlist) that no tool call can raise. There is
no tool that exports the seed, edits guardrails, or pays a merchant checkout QR.

## Related — `@depixapp/sdk`

The wallet engine started life as the standalone
**[`@depixapp/sdk`](https://www.npmjs.com/package/@depixapp/sdk)**. It lives here
now (`src/wallet-engine/`), and this package is where it is developed and
released. The 1.2.x line of `@depixapp/sdk` stays on npm and keeps working; it
is frozen, not deprecated. If what you want is **an agent with a wallet**, you
want this package: it exposes the engine over MCP, so nothing has to be written.

## Quickstart 1 — Connect Claude Code (remote, HTTP)

Pass your DePix API key as a Bearer header. Always start with a sandbox key.

```bash
claude mcp add --transport http depix https://mcp.depixapp.com/mcp \
  --header "Authorization: Bearer sk_test_YOUR_KEY"
```

Then test the connection by asking Claude to run `get_account`. It should return
your merchant with `is_live: false` (sandbox).

**Cursor** — add to `~/.cursor/mcp.json` (or a project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "depix": {
      "url": "https://mcp.depixapp.com/mcp",
      "headers": { "Authorization": "Bearer sk_test_YOUR_KEY" }
    }
  }
}
```

Or use the one-click deeplink. The key placeholder lives INSIDE the base64
`config=` value, so re-encode it with your real key first:

```bash
node -e 'const cfg={url:"https://mcp.depixapp.com/mcp",headers:{Authorization:"Bearer sk_test_YOUR_KEY"}};console.log(Buffer.from(JSON.stringify(cfg)).toString("base64"))'
```

```
cursor://anysphere.cursor-deeplink/mcp/install?name=depix&config=<base64 from the command above>
```

> The claude.ai web UI custom-connector only supports OAuth (no custom header).
> This server is an OAuth 2.1 Resource Server (WorkOS AuthKit): the web connector
> signs you in, and the session forwards your verified login to the API as the
> bearer. To operate you must first **link that login to your DePix account**
> (dashboard → connector settings); until then the tools return a typed
> "not linked yet" message. OAuth sessions are read + merchant only and can never
> move money (`wallet_write`) — use an `sk_` key for withdrawals. The whole OAuth
> surface is feature-flagged (`AUTHKIT_DOMAIN`): with it unset, only the `sk_`
> header/stdio paths above are active. Terminal clients keep using `sk_` keys.

## Quickstart 2 — Local stdio, 62 tools (Claude Desktop / Claude Code / Cursor)

Requires **Node.js ≥ 22.4**. The only official npm package is `@depixapp/mcp` —
the `@depixapp` scope is organization-owned; do not install any similarly-named
unscoped package. Secrets come from the environment, never from a flag.

### 2a. Gateway only (no wallet)

Exactly the 26 tools of level 1, running locally:

```json
{
  "mcpServers": {
    "depix": {
      "command": "npx",
      "args": ["-y", "@depixapp/mcp"],
      "env": { "DEPIX_API_KEY": "sk_test_YOUR_KEY" }
    }
  }
}
```

All 62 tools are still *listed* — the 29 `wallet_*` ones answer with a typed
`wallet_not_configured` error telling the agent to ask you to run `init`. That is
deliberate: MCP hosts snapshot the tool list when they connect, so a catalog that
grew later would mean "restart your client".

### 2b. First run — create the wallet

**`init` is a human ceremony at a terminal, never an MCP tool.** It prints your
12-word seed backup, so it refuses to run when stdin/stdout are not a real TTY,
and no agent can invoke it:

```bash
npx -y @depixapp/mcp init            # create a new wallet
npx -y @depixapp/mcp init --restore  # import an existing 12-word mnemonic
```

It asks for (or generates) a passphrase — never echoed — walks you through the
backup ritual, asks for your spending limits, and then wires the AI hosts it
finds on the machine (Claude Code, Claude Desktop, Cursor) to this wallet by
itself. The unlock key goes into the OS keychain, so the passphrase is never
written into a host config. For a host it does not detect it prints the block to
paste instead — and that block carries no secret:

```json
{
  "mcpServers": {
    "depix": {
      "command": "npx",
      "args": ["-y", "@depixapp/mcp"],
      "env": {
        "DEPIX_WALLET_DIR": "/Users/you/.depix-wallet",
        "DEPIX_GUARDRAIL_PER_TX_BRL_CENTS": "10000",
        "DEPIX_GUARDRAIL_DAILY_BRL_CENTS": "50000"
      }
    }
  }
}
```

Clear your terminal scrollback afterwards. Restart your MCP client and ask it to
run `wallet_status`.

### 2c. Reading the 12 words again

```bash
npx -y @depixapp/mcp backup          # show this wallet's 12 words again
```

Same rules as `init`: a real terminal or nothing. It asks for your passphrase
**every time**, even on a machine that unlocks the wallet by itself — the
keychain unlock key exists so the server can start, not so anyone at the keyboard
can read the seed. When you confirm you have copied the words, it wipes the
screen and the scrollback. Quit your MCP client first: the wallet dir takes an
exclusive lock, and a running server holds it.

Run the server directly to sanity-check:

```bash
DEPIX_API_KEY=sk_test_YOUR_KEY npx -y @depixapp/mcp
```

> **Self-hosting over HTTP is NOT trivially safe.** The wallet tools have no auth
> of their own and the seed is loaded process-wide. Over local **stdio** that is
> fine. Exposed over HTTP, anyone who reaches the port can drain the wallet — bind
> to localhost and add your own bearer/mTLS + network isolation, or don't.

## CLI subcommands

One bin, `depix-mcp`, with five subcommands — all of them acts for the human at
the keyboard. `npx -y @depixapp/mcp --help` prints the same list.

**None of the five is an MCP tool, and that is deliberate.** Two of them (`init`,
`backup`) display a 12-word seed, which must never transit model context or a
conversation log. The other three choose *which account* the server acts as: as
tools, an agent that read a poisoned web page could promote itself from its own
sandbox account to yours.

| Command | What it does | When you run it | The safety property |
|---|---|---|---|
| `init` | Creates the local wallet (`--restore` imports an existing 12-word mnemonic) and wires your AI host to it | Once, before any `wallet_*` tool can work | Refuses unless stdin **and** stdout are a real terminal; the passphrase is never echoed and never written into a host config |
| `backup` | Shows this wallet's 12 words again | When you need to copy the seed onto paper again | A real terminal or nothing; your passphrase is typed **every time**, even on a machine that unlocks the wallet by itself; the screen is wiped afterwards |
| `login` | Signs you in to your own DePix account in the browser (Google or GitHub) and seals the session on this machine | When you want the server to act as **you**, not as an account the agent registered for itself | The browser does the sign-in and the reply lands on this same computer; no token is ever printed, logged, or put in an error message |
| `logout` | Removes that login from this machine | When you are done with it, or on a machine you no longer control | Undoes `login` completely — including an `account use owner` selection that would now point at nothing |
| `account status` / `account use agent\|owner` | Prints which account the server acts as and why / picks one | Whenever you are unsure who is spending, and after `login` on a machine that already has an agent account | Reading and choosing happen at your terminal, so no agent can switch identity; `status` names the winner instead of leaving it implicit |

### Signing in as yourself — `login` / `logout`

```bash
npx -y @depixapp/mcp login                    # choose Google or GitHub in the browser
npx -y @depixapp/mcp login --provider github  # skip the chooser
npx -y @depixapp/mcp logout
```

`login` opens your browser on the DePix App sign-in and waits for the answer at
`http://127.0.0.1:47617/callback` — **this** computer, never a remote one. The
listener binds before the browser opens, so a second `login` running at the same
time fails right there instead of sending your sign-in to whatever else holds
that port. What comes back is exchanged for a session and sealed on disk with
your wallet passphrase; the terminal prints who you signed in as, never the
credential. On a headless or remote box there is no browser to open — use
`DEPIX_API_KEY` there, or let the agent register its own account.

> On **2.8.0** and **2.8.1**, `login` needs `DEPIX_WORKOS_CLIENT_ID` set to the
> DePix App sign-in application — the id baked into those two versions points at
> an older client. From **2.8.2** the right one ships baked in and the command
> needs no configuration.

If an agent account is already registered on this machine, logging in changes
**nothing** by default: the agent's account still wins, and `login` says so
loudly. `account use owner` is what switches. `logout` removes the stored
session and, when you had selected `owner`, drops that selection too — it would
otherwise point at a login that no longer exists.

### Which account acts — `account status` / `account use`

Two identities can live on one machine: the account the agent registered for
itself (`register_account`) and your own login. Exactly one of them
authenticates each call, and the order is fixed:

```
DEPIX_API_KEY  >  an explicit `account use`  >  the agent's own account  >  your login
```

The agent's own account carries two keys — sandbox (`sk_test_`) and the
production starter (`sk_live_`) — and starts on the sandbox one. The agent
switches with **`activate_key`** (`{ "mode": "live" }`): the choice is saved in
the encrypted vault, survives restarts, and the wallet picks it up on its next
call. Under `live`, deposits are real Pix charges.

```bash
npx -y @depixapp/mcp account status       # who is acting, and why
npx -y @depixapp/mcp account use owner    # act as your own DePix login
npx -y @depixapp/mcp account use agent    # act as the account the agent registered here
```

> **`DEPIX_API_KEY` in the server's environment beats everything below it.** With
> that variable set, `account use` decides nothing — `account status` prints that
> warning in place. Unset it (and restart the server) to let your selection win.

`account status` prints labels only — a provider, an email, an expiry — never a
token and never your passphrase.

## Quickstart 3 — Sandbox testing (the full loop)

Always test with an `sk_test_` key before `sk_live_`. Sandbox QRs are
non-payable placeholders (`SANDBOX-…-DO-NOT-PAY`).

1. **`create_checkout`** — `amount` is always required; on the default **Pix**
   rail `payer_tax_number` is too (the CPF/CNPJ is required even in sandbox).
   Use a test CPF like `52998224725`:

   ```json
   { "amount": 1500, "payer_tax_number": "52998224725" }
   ```

   Returns a `chk_…` id, a `payment_url`, a sandbox `pix.qr_code`, and
   `is_live: false`.

2. **`simulate_checkout_payment`** — `{ "checkout_id": "chk_…" }` marks the
   sandbox checkout paid (sandbox-only; live checkouts return `sandbox_only`).

3. **`wait_for_checkout`** — `{ "checkout_id": "chk_…" }`. The server polls
   internally and streams progress; you make **one** call and it returns
   `{ "status": "completed", "terminal": true }` — no client-side polling loop.

You can also read a synthetic deposit: **`get_deposit_status`** with a
`sandbox_…` id returns `depix_sent`.

### Charging on the DePix rail instead of Pix

`create_checkout` takes `payment_method`. The default `"pix"` is the flow above.
With `"depix"` the payer sends DePix **wallet-to-wallet on Liquid** to the
merchant's dedicated address — there is no Pix QR and no payer document:

```json
{ "amount": 9990, "payment_method": "depix", "expected_discount_pct": 10 }
```

The response carries `depix` instead of `pix`: `address`, the **exact**
`amount_cents` to send (face amount minus the merchant's discount, minus a
sub-cent-window adjustment that makes the value unique — that uniqueness is how
the payment is matched), the decimal `amount` a wallet signs, `asset_id` and a
ready-to-scan `uri`. Send any other amount or any other asset and the payment
cannot be credited automatically, and an on-chain payment is irreversible.

Settlement is observed on-chain: `approved` at the first confirmation (~1 min),
`completed` at the second. `expires_in` accepts 300–3600 s here (default 1800)
instead of the Pix rail's 300–1200. The rail must be enabled by the merchant —
otherwise the API answers `depix_not_enabled`. On the local level, a registered
agent account turns it on with **`configure_depix_rail`** (`{ "enabled": true }`):
the tool derives a dedicated address from your own wallet and registers it, so
you keep custody and the backend only gains a per-address viewing key. Sandbox
DePix checkouts are deliberately unpayable (placeholder address, `uri: null`);
drive them with `simulate_checkout_payment`.

## Tools

**26 gateway tools** — available at both levels. Amounts are BRL cents.

| Tool | API | Scope |
|---|---|---|
| `create_checkout` | POST /api/checkouts | `merchant_write` |
| `get_checkout` | GET /api/checkouts/:id | `merchant_read` |
| `list_checkouts` | GET /api/checkouts | `merchant_read` |
| `simulate_checkout_payment` | POST /api/checkouts/:id/simulate-payment | `merchant_write` (sandbox-only) |
| `wait_for_checkout` | GET /api/checkouts/:id (server-side loop) | `merchant_read` |
| `create_product` | POST /api/products | `merchant_write` |
| `list_products` | GET /api/products | `merchant_read` |
| `get_product` | GET /api/products/:id | `merchant_read` |
| `update_product` | PATCH /api/products/:id | `merchant_write` |
| `activate_product` | POST /api/products/:id/activate | `merchant_write` |
| `deactivate_product` | POST /api/products/:id/deactivate | `merchant_write` |
| `set_featured_products` | POST /api/products/featured | `merchant_write` |
| `list_product_checkouts` | GET /api/products/:id/checkouts | `merchant_read` |
| `get_account` | GET /api/me | `merchant_read` |
| `get_onboarding_status` | GET /api/verification + GET /api/me probe (self-heals via POST when every step is done) | `merchant_read` |
| `update_merchant_profile` | PATCH /api/merchants/me | `merchant_write` |
| `get_vault_status` | GET /api/vault/status | `wallet_read` (read-only) |
| `list_webhook_logs` | GET /api/webhook-logs, /api/webhook-logs/:id | `merchant_read` |
| `get_deposit_status` | GET /api/deposits/:id | `wallet_read` (read-only) |
| `get_withdrawal_status` | GET /api/withdrawals/:id | `wallet_read` (read-only) |
| `open_support_ticket` | POST /api/tickets | any key (scope-less) |
| `get_support_ticket` | GET /api/tickets/:id | any key (scope-less) |
| `list_support_tickets` | GET /api/tickets | any key (scope-less) |
| `reply_support_ticket` | POST /api/tickets/:id/messages | any key (scope-less) |
| `attach_support_ticket_file` | POST /api/tickets/:id/attachments | any key (scope-less) |
| `close_support_ticket` | POST /api/tickets/:id/close | any key (scope-less) |

**Charges (cobranças).** `create_product` with `kind: "charge"` creates a payment link with a **due date** and optional late fine/interest — rent, tuition, an instalment. It is served at `pay.depixapp.com/c/{id}`, never appears on the merchant's public store, and the amount is recomputed on each visit (base + fine + pro-rata interest for the current cycle). With `recurrence` the same link keeps working month after month, settling the oldest unpaid cycle first. `list_products` does **not** return charges unless you pass `kind: "charge"` (or `"all"`); charge rows then carry `charge_state` — current cycle, days late, today's total.

Do not confuse it with `create_checkout`, which mints a **one-off** payment that is paid once and is short-lived. A charge is the standing one.

The last six are the support channel: open a ticket, poll for the human reply,
reply back, attach a screenshot or diagnostic/log file (base64, ~3 MB), or close
it (up to 5 open per account). Replies are not pushed —
poll `get_support_ticket`. Amounts are BRL cents. A tool call whose key lacks the required scope returns an
`insufficient_scope` tool error naming the missing scope — that is the only way
to discover a missing scope (the API never lists a key's scopes).

**29 `wallet_*` tools** — the local (`npx`) level only. They sign in-process with
your seed; without one they return `wallet_not_configured`.

| Group | Tools |
|---|---|
| Status & reads | `wallet_status`, `wallet_get_address`, `wallet_get_balances`, `wallet_list_transactions`, `wallet_list_utxos`, `wallet_get_guardrails`, `wallet_diagnostics` |
| Sync | `wallet_sync` (explicit refresh; `rescan` for a deep cold re-scan) |
| Move money | `wallet_send`, `wallet_create_deposit`, `wallet_wait_deposit`, `wallet_create_withdrawal`, `wallet_wait_withdrawal` |
| Convert | `wallet_quote`, `wallet_convert`, `wallet_swap_quote`, `wallet_swap_execute`, `wallet_to_stablecoin`, `wallet_shift_usdt` |
| Lightning | `wallet_pay_lightning_invoice`, `wallet_receive_lightning` |
| Gift cards | `wallet_list_giftcards`, `wallet_list_giftcard_products`, `wallet_giftcard_price`, `wallet_buy_giftcard`, `wallet_list_giftcard_orders`, `wallet_get_giftcard_order_status` |
| Recovery | `wallet_recover`, `wallet_pending` |

`wallet_convert` is the primary conversion surface (`wallet_quote` enumerates the
routes); the provider-level tools are the escape hatch. `wallet_shift_usdt` is the
one **custodial** route (SideShift) and says so. Amounts carry their unit in the
field name: `amount_cents` is BRL cents, `amount_sats` is the asset's base units.

There is deliberately **no** tool to export the seed, change guardrails, edit the
payout addresses, or pay a merchant checkout QR — not even from a fully injected
model.

## Configuration (public, no secrets)

| Env | Meaning | Default |
|---|---|---|
| `DEPIX_API_BASE` | API base URL (allowlisted origins only) | `https://api.depixapp.com` |
| `MCP_MAX_WAIT_SECONDS` | Max `wait_for_checkout` budget; prod sets ~780 (Vercel Pro) | `290` (Hobby-safe) |
| `MCP_SERVER_VERSION` | Version reported in the handshake | package version |
| `MCP_ALLOWED_HOSTS` | Comma-separated Host allowlist (DNS-rebinding protection). Matched **exactly** — no wildcards. Vercel preview deploys add their own hostnames automatically, so this is normally unset | `mcp.depixapp.com` |
| `DEPIX_API_KEY` | **stdio mode only** — your `sk_` key | — |

Local (`npx`) level only — the wallet half:

| Env | Meaning | Default |
|---|---|---|
| `DEPIX_WALLET_PASSPHRASE` | Unlocks the encrypted local wallet, and seals the stored API keys and the `login` session. Optional: `init` puts the same passphrase in the OS keychain (or a `0600` file), and everything reads it there when this is unset | — |
| `DEPIX_AGENT_PASSPHRASE` | Optional. When set it seals and opens the stored API keys and the `login` session instead of `DEPIX_WALLET_PASSPHRASE`; the wallet itself keeps using `DEPIX_WALLET_PASSPHRASE` | — |
| `DEPIX_WALLET_DIR` | Where the encrypted wallet lives | `~/.depix-wallet` |
| `DEPIX_GUARDRAIL_*` | Per-transaction / rolling-24h BRL caps and allowlist. Immutable at runtime: set here + restart | R$100/tx, R$500/day |
| `DEPIX_MCP_MAX_WAIT_SECONDS` | Ceiling for the wallet wait tools | `900` |

There is deliberately **no** env for an API key, provider token, HMAC or DB
credential in the remote server. In HTTP mode the key arrives per-request in the
`Authorization` header. The wallet passphrase and seed exist **only** on the
operator's machine — the hosted deployment reads neither and has no code that
could.

## Endpoints

- `POST /mcp` — the MCP Streamable HTTP endpoint (`DELETE` ends a session;
  `GET` returns 405 — this stateless server offers no standalone SSE stream).
- `GET /.well-known/mcp.json` — minimal discovery document.
- `GET /api/health` (also `/`) — service status.

## Development

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # compile src (incl. the wallet engine) → dist
npm run smoke      # run the compiled dist: wasm init, address goldens, seed roundtrip
npm run guard:hosted   # the hosted deployment has no path to the wallet engine
npm run licenses:check # THIRD_PARTY_LICENSES matches the prod dep tree
```

Set `DEPIX_TEST_KEY=sk_test_…` to run the real-sandbox e2e test
(`test/e2e/sandbox.test.ts`), otherwise it is skipped. Set `DEPIX_SDK_OFFLINE=1`
(CI does) to skip the one engine test that reads mainnet Esplora for real.

### The wallet engine (`src/wallet-engine/`)

The 29 wallet tools come from the DePix App wallet engine. It used to be vendored
here from a pinned commit of a second repository; it is now simply part of this
package's source, developed and released with it. Its tests live in
`test/wallet-engine/`, mirroring the layout.

Two settings the engine brings with it:

- `tsconfig.wallet-engine.json` typechecks `src/wallet-engine/` +
  `test/wallet-engine/` under the stricter options the engine was written with
  (`noUncheckedIndexedAccess` and friends). `npm run typecheck` runs the
  repo-wide pass and then this one; tsc has no per-directory options.
- `floor-smoke` in CI runs the compiled artifact on Node **22.4** exactly — the
  `engines` floor. The test matrix's "22" is whatever `latest-22` resolves to,
  which never proves the floor.

### Why the hosted deployment cannot sign

`api/mcp.ts` → `src/http.ts` → `src/server.ts` has **zero** import path to
`src/wallet-engine/**`. Neither this repo nor Vercel runs a tree-shaking bundler,
so that import graph is the whole guarantee. `scripts/check-hosted-isolation.mjs`
enforces it twice — a static walk of the TypeScript sources and a `@vercel/nft`
trace of the compiled entries — and its `--self-test` proves both checks reject a
poisoned entry. Only `src/stdio.ts` → `src/unified.ts` may reach the engine.

**CI** (`.github/workflows/ci.yml`) runs typecheck + lint + test + build + smoke +
both guards on every push to `main` and every PR, on Node 22 and 24, plus the
Node 22.4 floor smoke — that is the correctness gate.

## Releasing

Publishing is automated via GitHub Actions using **npm Trusted Publishing
(OIDC)** — no npm token, no 2FA prompt, and every release carries build
provenance. `.github/workflows/publish-mcp.yml` (on a `v*` tag) publishes the
**npm package** and then the **MCP Registry** entry (`registry/server.json`).

To cut a release:

1. Bump the version in **`package.json`**, **`registry/server.json`** (both the
   top-level `version` and `packages[].version`) and the `resolveServerVersion`
   fallback in **`src/config.ts`** — they must match, and CI fails the release if
   the tag, `package.json` and the registry npm entry disagree (a unit test pins
   the config fallback). The MCP Registry is **immutable per version**, so
   anything that publishes from the tagged tree has to be right before the tag.
2. Commit to `main`.
3. Tag and push:
   ```bash
   git tag v2.0.0 && git push origin v2.0.0
   ```

The workflow verifies the versions, re-runs typecheck + lint + tests + both
guards (`ci.yml` is not triggered by tags), publishes to npm with provenance,
then publishes the registry entry (idempotent — re-running a tag is a safe
no-op).
Re-tagging an already-published version skips both publishes.

One-time setup (already done): the package is registered as an npm **Trusted
Publisher** for this repo with workflow filename `publish-mcp.yml` (npmjs.com →
package → Settings → Trusted Publisher). No secrets are stored in the repo.

## Release smoke test

After a preview/production deploy:

1. `claude mcp add --transport http depix <url>/mcp --header "Authorization: Bearer sk_test_…"`
2. Ask Claude to run `get_account` → returns the merchant, `is_live: false`.
3. `create_checkout` (sandbox) → `simulate_checkout_payment` → `wait_for_checkout`
   → `completed`.

> Pushing to `main` deploys to production (`mcp.depixapp.com`). Validate on a
> Vercel preview deploy before merging. **Previews are reachable out of the box:**
> a non-production deployment adds its own `VERCEL_URL` and `VERCEL_BRANCH_URL`
> to the DNS-rebinding allowlist (`resolveAllowedHosts`), and production widens by
> nothing. If you ever need to allow another host, set `MCP_ALLOWED_HOSTS` to the
> **exact** hostname — the allowlist is an exact match, so `*.vercel.app` matches
> nothing and would leave the preview unreachable.
