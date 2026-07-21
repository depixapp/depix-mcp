# depix-mcp

MCP (Model Context Protocol) server for [DePix App](https://depixapp.com) — the
agent-facing interface of the non-custodial Pix↔DePix payment gateway.

Connect an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP client) and
it can **receive Pix payments** (checkouts and products) and **read transaction
status** — end to end, in sandbox (`sk_test_`) and production (`sk_live_`).

- **Remote (Streamable HTTP):** `https://mcp.depixapp.com/mcp`
- **Local (stdio):** `npx -y @depixapp/mcp` with `DEPIX_API_KEY` in
  the environment

## What it is (and isn't)

- **A pure client of the public DePix API** (`https://api.depixapp.com/api/*`). It
  holds **zero critical credentials** — no Eulen token, no database, no webhook
  HMAC, no Liquid key.
- **Never custodial.** It never signs a transaction, never holds funds, never
  stores your key. Your `sk_` key is passed **verbatim** to the API on each call
  and lives only in memory for that request.
- **Same door as everyone.** The MCP goes through the same auth, scopes and rate
  limits as any external agent — no privileged path.

It does **not** create deposits or withdrawals (that moves funds and belongs to
the Wallet SDK — see [Related](#related--moving-funds-the-wallet-sdk)). The
pay-side tools here are **read-only** status reads.

## Related — moving funds: the Wallet SDK

This gateway **receives** payments and reads status. To **hold, sign, and move
funds** — an agent running its own non-custodial Liquid wallet that pays and
receives over Pix/DePix, converts DePix/L-BTC/USDt, buys gift cards, and
self-onboards — use the companion
**[`@depixapp/sdk`](https://www.npmjs.com/package/@depixapp/sdk)**
([source](https://github.com/depixapp/depix-sdk)). The seed never leaves the
agent and the backend never signs.

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

## Quickstart 2 — Local stdio (Claude Desktop)

The same server runs as a local process over stdio. The key comes from
`DEPIX_API_KEY` (env), never a flag. The only official npm package is
`@depixapp/mcp` — the `@depixapp` scope is organization-owned; do not install
any similarly-named unscoped package. Add to your Claude Desktop config
(`claude_desktop_config.json`):

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

Run it directly to sanity-check:

```bash
DEPIX_API_KEY=sk_test_YOUR_KEY npx -y @depixapp/mcp
```


## Quickstart 3 — Sandbox testing (the full loop)

Always test with an `sk_test_` key before `sk_live_`. Sandbox QRs are
non-payable placeholders (`SANDBOX-…-DO-NOT-PAY`).

1. **`create_checkout`** — `amount` and `payer_tax_number` are both required (the
   CPF/CNPJ is required even in sandbox). Use a test CPF like `52998224725`:

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

## Tools (16)

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
| `get_deposit_status` | GET /api/deposits/:id | `wallet_read` (read-only) |
| `get_withdrawal_status` | GET /api/withdrawals/:id | `wallet_read` (read-only) |

Amounts are BRL cents. A tool call whose key lacks the required scope returns an
`insufficient_scope` tool error naming the missing scope — that is the only way
to discover a missing scope (the API never lists a key's scopes).

## Configuration (public, no secrets)

| Env | Meaning | Default |
|---|---|---|
| `DEPIX_API_BASE` | API base URL (allowlisted origins only) | `https://api.depixapp.com` |
| `MCP_MAX_WAIT_SECONDS` | Max `wait_for_checkout` budget; prod sets ~780 (Vercel Pro) | `290` (Hobby-safe) |
| `MCP_SERVER_VERSION` | Version reported in the handshake | `1.0.0` |
| `MCP_ALLOWED_HOSTS` | Comma-separated Host allowlist (DNS-rebinding protection); set on previews to add the `*.vercel.app` host | `mcp.depixapp.com` |
| `DEPIX_API_KEY` | **stdio mode only** — your `sk_` key | — |

There is deliberately **no** env for an API key, Eulen token, HMAC or DB
credential in the remote server. In HTTP mode the key arrives per-request in the
`Authorization` header.

## Endpoints

- `POST /mcp` — the MCP Streamable HTTP endpoint (`DELETE` ends a session;
  `GET` returns 405 — this stateless server offers no standalone SSE stream).
- `GET /.well-known/mcp.json` — minimal discovery document.
- `GET /api/health` (also `/`) — service status.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # compile src → dist (the stdio bin)
```

Set `DEPIX_TEST_KEY=sk_test_…` to run the real-sandbox e2e test
(`test/e2e/sandbox.test.ts`), otherwise it is skipped.

## Release smoke test

After a preview/production deploy:

1. `claude mcp add --transport http depix <url>/mcp --header "Authorization: Bearer sk_test_…"`
2. Ask Claude to run `get_account` → returns the merchant, `is_live: false`.
3. `create_checkout` (sandbox) → `simulate_checkout_payment` → `wait_for_checkout`
   → `completed`.

> Pushing to `main` deploys to production (`mcp.depixapp.com`). Validate on a
> Vercel preview deploy before merging. Preview hosts are not on the default
> DNS-rebinding allowlist — set `MCP_ALLOWED_HOSTS` in the preview environment
> (e.g. `mcp.depixapp.com,depix-mcp-<hash>.vercel.app`) to smoke-test there.
