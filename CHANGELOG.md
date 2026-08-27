# Changelog

## 2.7.0 — an agent can turn on the DePix direct rail

A local agent merchant could only be paid by Pix: the DePix direct-rail opt-in
is a JWT+password door no agent account can reach. This release adds the agent's
own door. **Tool count: 26 gateway / 59 full (was 58) — 26 + 29 `wallet_*` + 4
agent-local.**

- **`configure_depix_rail` (§3.9), local server only.** `{ enabled: true }`
  derives a dedicated confidential address from THIS wallet plus the SLIP-77
  blinding PRIVATE key of its script, and registers the pair with the backend
  (`POST /api/agents/depix-pay`, signed with the agent identity — the per-request
  Ed25519 signature is the step-up). `{ enabled: false }` turns it off and sends
  no key. The blinding key is a per-address VIEW key with zero spending power; it
  transits to the backend by design (the minimal grant that lets the §6.3 watcher
  unblind payments to that one script) and NEVER reaches the tool response or a
  log — the tool returns only public facts (the address, the rail state). The
  hosted catalog never offers it (D4).

Local agents can now create and run their own account without a key pasted into
a config, the wallet syncs on the agent's behalf so incoming money is never
invisible, and every typed error tells the agent what to do next. **Tool count:
26 gateway (was 22) / 58 full (was 49) — 26 + 29 `wallet_*` + 3 agent-local.**

- **The sync rule (§3.8).** The engine's scanner was never triggered by any tool,
  so a pure on-chain receive stayed invisible and a spend built from a stale
  snapshot. Now every balance READ and every SPEND syncs BEFORE, and every spend
  and settled deposit syncs AFTER — decided in the MCP facade, not the engine.
  Money-safe by construction: a read is fail-soft (serves the snapshot with
  `stale: true`, never an error), a spend proceeds through a failed pre-sync with
  a warning, and a post-broadcast sync failure reports `post_sync_failed` beside
  the `txid` — it never turns a completed spend into an error. A ~10s dedup window
  keeps N tools in one turn from paying for N scans. New `wallet_sync` (explicit
  refresh; `rescan` for a deep cold re-scan) and `wallet_list_utxos` (read-only).
- **Agent-local tools (§3.1/§3.2/§3.3), local server only.** `register_account`
  creates the account + keys in-process and stores the `sk_` ENCRYPTED on disk —
  the response carries only public facts (username, slug, limits, key ids), never
  the secret. `agent_status` and `verify_domain` (two-phase DNS TXT) round it out.
  The hosted catalog never offers a registration tool (D4).
- **Per-request credential (§3.1).** `ApiClient` resolves its key per call, so the
  key `register_account` mints is used on the very next request without a restart.
  `DEPIX_API_KEY` in the env still wins, and the conflict is reported loudly.
- **Gateway reads.** `get_onboarding_status` narrates the verification+store ladder
  (hardcoded PT+EN copy, absolute deep links) and self-heals by triggering
  verification when the steps complete. `update_merchant_profile`, `get_vault_status`
  and `list_webhook_logs` round out the 4 new gateway tools.
- **Typed errors carry `next_action` (§5.1/D13).** Every agent-facing code gets a
  machine-readable next step (a closed set of 5 kinds; a PT+EN relay for human
  steps), so an agent with no docs can walk the whole onboarding ladder.

## 2.5.1 — the catalog stops declaring a dialect the clients refuse

Claude Desktop and Claude Code validate every tool call against the tool's
declared schemas with a JSON-Schema-2020-12-only validator — and the SDK's
zod-v3 converter stamps `"$schema": draft-07` on every schema it emits, so
every call failed in the client before reaching the tool ("invalid
outputSchema: JSON Schema declares an unsupported dialect").

- **The stamp is stripped on the wire.** The SDK adds it inside its own
  tools/list handler, after our code has run, so the transport is the one
  reliable choke point: both entries (stdio and the hosted HTTP function) now
  send their catalog through `sanitizeOutgoingSchemas`. Nothing else in the
  schema changes — the keywords these schemas use mean the same thing in both
  dialects.
- **A control test pins the SDK's behaviour.** When the SDK stops stamping
  draft-07, that test fails on purpose: the signal to delete the shim.

## 2.5.0 — Lightning works again, and a swap remembers who is holding it

The agent wallet's Lightning send, receive and gift cards had been dead since
2026-08-03. Not broken: refused. Boltz runs a switch that turns swap CREATION
off, and this package spoke to Boltz and to nobody else.

- **A second swap backend.** Boltz stays first — while it is answering nothing
  about the engine changes — and Coinos serves Lightning when it is not. Both run
  the same `boltz-backend` v2 API, so this is a list to walk, not an integration.
- **Liveness is read from the creation path, because a GET lies about it.** A
  backend with creation switched off still answers `/v2/swap/*` with a full,
  healthy-looking pair matrix: limits, fees, pair hashes, HTTP 200. So the probe
  POSTs a real creation request for 1 sat — below every known minimum, so it is
  refused before anything exists — and reads WHICH complaint came back, since
  "swap creation is disabled" and "1 is less than minimal of 25000" are both 400.
- **A swap belongs to whoever created it.** Records now carry the backend, and
  watching, claiming and refunding go back to it — never to whoever the process
  happens to have selected since. Boltz recovering must not strand a Coinos swap.
  Records written before this have no such field; they are all Boltz, and a
  reader must never stall a refundable swap over a shape it does not recognise.
- **Concurrent swaps reach different backends.** The swap SDK keeps one config
  for the whole process and takes no per-call base URL, so "re-point it, then
  call it" does not survive the `await` in between. The API base is resolved per
  request from the calling chain's own context instead: a 20-minute stablecoin
  execution and a Lightning send now run side by side, each on its own backend,
  with no lock between them.
- **L-BTC → USDC/USDT stays on Boltz** and says so when Boltz is off. That route
  rides Boltz's own hosted engine — an EVM leg, a DEX, a bridge, a gas sponsor —
  none of which ships with the backend a fallback operator runs.

**A route nobody will honour is no longer offered.** `wallet_quote` marks each
candidate `available`, and refuses to price the ones a backend would turn down;
`wallet_convert` refuses them outright, with a retryable error and a next step.
That check happens BEFORE the first leg: a multi-hop used to swap DePix into
L-BTC and only then discover the second leg had nowhere to go, leaving the value
in the wrong asset behind a parked plan. Funds already in flight are untouched by
any of this — a backend that stopped creating swaps still claims and refunds what
it holds, and recovery never asks whether it would take a new one.

**A quoted fee is now charged where the quote says it is.** SideSwap names the
fee side ("Base"/"Quote"), not the asset, and the estimator was reading that
label as an asset id — so every live quote reported an unknown fee asset, and the
branch meant to handle that was unreachable. Worse, it subtracted the fee from
the receipt unconditionally, across assets with different units: a DePix-priced
fee against an L-BTC receipt drove the estimate negative and reported a perfectly
healthy route as "amount too small". The fee is netted only when it is charged on
the asset being received — the same rule the PSET validator already enforced at
execution — and a fee whose side cannot be resolved is reported as unknown rather
than assumed.

## 2.4.0 — the wallet engine lives here now

No tool changed, no behaviour changed, nothing on the wire moved. What changed is
where the code lives: the wallet engine was a copy of another repository, kept in
sync by a pinned commit and a vendoring script, and it is now simply this
package's own source under `src/wallet-engine/`. Two repositories had to be
edited, reviewed and released in step to change one line of wallet code; now one
does.

- **`src/vendor/depix-sdk/` → `src/wallet-engine/`**, with the per-file "VENDORED
  ENGINE SOURCE — DO NOT EDIT HERE" headers gone. The dual-licensing fact they
  carried — DePix App owns the engine, this copy is Apache-2.0, the
  `@depixapp/sdk` tarball of the same source stays AGPL-3.0-only — now lives in
  `NOTICE`, which ships in the tarball.
- **The vendoring machinery is deleted**: the pin, the script, the `vendor:*`
  npm scripts, the CI job and the release steps that checked the copy against its
  upstream commit. They existed to prove a copy was faithful; there is no copy.
- **The engine's tests came too** — 973 assertions under `test/wallet-engine/`,
  with the timeouts (Argon2id is slow on purpose) and the environment they need
  to be honest rather than merely green.
- **The Node 22.4 floor is now proven.** `engines` has claimed `>=22.4` since
  2.0.0 while CI's "22" was whatever `latest-22` resolved to. A new `floor-smoke`
  job installs production dependencies only and runs the compiled artifact on
  22.4 exactly.
- **`wallet_diagnostics` reports a real version in more places.** The engine
  found its manifest by counting directories, which worked only because the build
  wrote a synthetic `package.json` into `dist/`. It now walks up to the package
  it belongs to, and the build emits no manifest at all.

## 2.3.1 — the hold date now reads like every other timestamp

Text only, no behavior change. API 0.40.0 moved every timestamp it emits to
one shape, RFC 3339 UTC — `delay_until` included, which until then was the
one field carrying the settlement provider's -03:00 offset. The `get_checkout`
description taught that exception; it now teaches the rule, and notes that a
pre-0.40.0 deployment still answers the offset shape, which this server passes
through untouched either way (passthrough is the contract, and it is what
makes this a text-only release).

## 2.3.0 — a held sale now says it is held, and until when

A sale waiting out a vault hold and one settling in the next few seconds read
identically through this server: `processing`, nothing else. The API separates
them with `delay_until` (the release date, the provider's own ISO-8601 string
with an offset) and `vault_hours` (the wait the sale was booked for) — on list
items since 0.31.0, on the single-checkout read since 0.39.0. Both normalizers
here are allowlists, and both dropped the pair: the same shape of bug as 2.2.0
(`depix_due_cents`) and 2.1.1 (`payment_method`), one release later. An agent
polling the one order it was waiting on had no date to wait for, and no sign a
hold existed at all.

Both tools now emit the pair — by KEY PRESENCE, not by value, which is new for
this file and deliberate: null is an answer ("no hold decision recorded" —
sandbox, or the DePix rail, which creates no paired deposit) and is a different
fact from `vault_hours: 0` ("looked at, not held"). The value-based emit the
neighbouring fields use would erase exactly that distinction.

The contract fixture gains the two fields on CheckoutDetail and
CheckoutListItem, re-derived from the live 0.39.0 document
(`hold_fields_derived_from`) — the list-side gap survived two releases
precisely because the pinned fixture could not see it.

Requires DePix API 0.31.0+ (list) / 0.39.0+ (detail) for the fields; older
APIs keep working and simply omit them.

## 2.2.1 — release the terminal-status correction

`terminal` is the field an agent reads to decide it may stop waiting, and it
was true for `error`, which sent agents away from money still in motion. The
fix landed in 2.2.0's tree; this release is what put it in operators' hands.
Patch: enum unchanged, no field added or removed.

## 2.2.0 — a discounted DePix sale now reconciles to what was actually paid

`list_checkouts` carried the rail from 2.1.1 on, but not the two numbers that
make a DePix-rail sale add up. `amount` is the FACE price. The payer of a
DePix-rail charge sends `depix_due_cents` — the discounted amount, moved down by
a few cents so the watcher can tell two identical sales apart, and the only
value attribution will match. So an agent listing sales to reconcile them read
R$ 100,00 for a sale that paid R$ 90,00, and had no way to know.

The API fixed this in 0.20.5 by adding `depix_discount_pct` and
`depix_due_cents` to the list item. This server's list normalizer is an
allowlist, and silently dropped both — the same shape of bug as the missing
`payment_method` in 2.1.1, one field deeper.

Both are now emitted, and only when the API reports them: an older deployment
omits the keys rather than claiming a 0% discount it never applied, and a pix
sale gets neither (a zero there would assert a discount the rail does not have).
`get_checkout` was already correct — it passes the whole `depix` object through.

The contract fixture moves to OpenAPI 0.20.5. Every other pinned fact was
re-derived from the live document and came back unchanged.

Requires DePix API 0.20.5 or later for these two fields; older APIs keep working
and simply omit them.

## 2.1.1 — make charges findable from the word merchants actually use

**No new tool; the discovery work below changes descriptive text only.** One
non-wording change also rides in this release and is called out at the end:
`list_checkouts` now carries `payment_method`. 2.1.0 shipped charges correctly
and an agent that read `create_product` routed to them reliably — but only if it
got that far.

The merchants this serves speak Portuguese, where *cobrança* means both the
one-off QR and the dated payment link. Two things pointed the word at the wrong
tool:

- The handshake `instructions` — what a host puts in front of the model before
  any tool description — listed "checkouts/products" and never mentioned charges
  at all. Same omission in `/.well-known/mcp.json`.
- `create_checkout`'s description opened with "Create a **charge** (checkout)",
  claiming the term, while the correction lived only inside `create_product`. A
  host that pre-filters tools by similarity to "cobrança" surfaces the one-off
  and never shows the model the note that would have redirected it.

So the disambiguation now works from both sides: the handshake states where a
cobrança goes (and that `list_products` hides charges unless asked),
`create_checkout` says it is the one-off and names `create_product` with
`kind="charge"` for the dated one, and `create_product` carries the Portuguese
word so retrieval on it lands somewhere true. The word also lands in the two
surfaces a registry/npm search actually indexes — the `package.json` and
`registry/server.json` descriptions — which the first pass had left silent.

The handshake places charges on the Pix rail, matching the backend: a charge's
`pay.depixapp.com/c/{id}` page is Pix-only today. Checkouts and products still
take either rail.

**Also in this release (not part of the discovery work): `list_checkouts` now
returns `payment_method`** (`pix` | `depix` | `null`) on each row, so an agent
listing a merchant's checkouts can tell which rail each one settled on without a
per-row `get_checkout`. Output-schema addition only; the field is optional, so
older clients are unaffected.

## 2.1.0 — charges (cobranças) through the product tools

A **charge** is a product with `kind: "charge"`: a payment link with a **due
date** and optional late fine / pro-rata monthly interest — rent, tuition, an
instalment. It is served at `pay.depixapp.com/c/{id}`, never appears on the
merchant's public store, and its amount is recomputed on each visit (base +
fine + interest for the current cycle). With `recurrence` the same link keeps
working month after month, settling the oldest unpaid cycle first.

It is the SAME resource with a discriminator, as the backend models it, so no
tool was added: `get_product`, `update_product`, `activate_product`,
`deactivate_product` and `list_product_checkouts` already work on charges.
**Tool count is unchanged (22 gateway / 49 full.)**

- `create_product` accepts `kind`, `due_date` (required for a charge),
  `recurrence` (`null` | weekly | monthly | quarterly | semiannual | yearly),
  `late_fine_bps` (0–2000) and `late_interest_monthly_bps` (0–1000). Passing a
  charge field WITHOUT `kind: "charge"` is now an error rather than silently
  creating a storefront product.
- `list_products` accepts `kind` (`product` | `charge` | `all`). **The API
  defaults to `product`, so charges do not appear unless you ask for them** —
  pre-charges integrations keep exactly the result set they had.
- `update_product` accepts the four mutable charge fields. `kind` is immutable.
- Responses carry the charge fields, the `/c/{id}` `payment_url`, and
  `charge_state` on list rows — current cycle, days late, today's total, and
  whether a payment is already settling.

Requires DePix API 0.20.2 or later.

## 2.0.1 — re-publish with the affiliate id baked

Re-publish with the SideShift affiliate id baked at build time. 2.0.0 shipped
with the runtime env read only, so `wallet_shift_usdt`'s affiliate share required
every operator to export `SIDESHIFT_AFFILIATE_ID` themselves — the secret was not
visible to this repo when 2.0.0 was published, so `scripts/postbuild.mjs` took its
skip path and left the compiled module reading `process.env`.

**No code changes.** Identical tree to 2.0.0 apart from the version strings; the
difference is entirely in the published artifact.

## 2.0.0 — the unified MCP (49 tools)

**BREAKING.** `@depixapp/mcp` becomes ONE MCP with two levels of access: the
hosted endpoint (`mcp.depixapp.com`, 22 tools, receive-only) and the local npx
deployment (49 tools, including a non-custodial Liquid wallet that signs on the
operator's own machine). Same package, same registry entry.

### Why a major

Two changes break existing installs, so semver leaves no choice:

1. **Node floor 18 → 22.4.** The bundled wallet engine requires it (`lwk_node`,
   the wasm signer, and the engine's own `engines.node`). Gateway-only users on
   Node 18 or 20 are affected even though nothing about the gateway changed —
   `npm ci` / `npx` will refuse. The CI matrix drops Node 20 for the same reason.
2. **The local catalog goes 22 → 49.** A client that snapshotted 22 tools now
   sees 49. The hosted endpoint is unchanged at 22.

A third change is behavioural rather than semver-visible but worth reading:

3. **The stdio bin no longer exits when `DEPIX_API_KEY` is absent.** It used to
   `exit 1`. It now serves and lets the API-backed tools return the typed
   `missing_api_key` error. Refusing to boot would deny all 27 wallet tools to an
   operator who runs only the wallet half and legitimately has no gateway key.

### Added

- **27 `wallet_*` tools on the npx deployment** — hold, send, convert (DePix /
  L-BTC / USDt, single- and multi-hop), pay and receive Lightning, buy gift cards,
  crash-recovery reads. They sign **in-process** with a seed that never leaves the
  machine, under immutable guardrails (per-tx + rolling-24h BRL caps, optional
  allowlist). No tool can export the seed, change guardrails, or pay a merchant
  checkout QR.
- **`npx -y @depixapp/mcp init`** — the first-run ceremony: creates or restores
  (`--restore`) the local wallet, runs the backup ritual, and prints the
  paste-ready `mcpServers` block. **TTY-only, and deliberately not an MCP tool** —
  a 12-word mnemonic must never transit model context or conversation logs. The
  passphrase is never echoed and the printed block carries a placeholder.
- **Three-state boot.** All 49 tools are ALWAYS listed. With no wallet, each
  `wallet_*` call returns the typed `wallet_not_configured` naming `init`; with no
  API key, the API-backed tools return `missing_api_key`. Neither is a startup
  failure. A catalog that grew after `init` would mean "restart your client":
  hosts snapshot `tools/list` at connect and `list_changed` support is uneven.
- **Per-deployment `instructions` and `title`.** The hosted text keeps "it never
  signs, never holds funds, and never stores your key" — true there — and adds a
  signpost telling agents the local level exists. The unified text can never carry
  that sentence (enforced by test), describes 49 tools and local signing, and the
  server introduces itself as "DePix App — Pix + non-custodial Liquid wallet"
  instead of "Gateway".
- **`THIRD_PARTY_LICENSES`**, generated from the production dependency tree and
  shipped in the tarball. Bundling third-party MIT/BSD/Apache code means their
  notices must travel with the copy; `npm run licenses:check` keeps it current.
- **Three CI guards**: `guard:hosted` (the hosted function has zero import path to
  the wallet engine — a static import-graph walk plus a `@vercel/nft` trace, with
  a self-test that proves both reject poisoned entries at the top level *and* in a
  subdirectory), `licenses:check`, and `vendor:check` (the committed engine tree
  matches its pinned commit byte for byte, verified against a fresh checkout). All
  three also run in the release workflow: `ci.yml` is not triggered by tags, so a
  tag would otherwise publish with only `tsc` and `eslint` having looked at it.
- **Vercel preview deploys are reachable.** A non-production deployment adds its
  own `VERCEL_URL` / `VERCEL_BRANCH_URL` to the DNS-rebinding allowlist;
  production widens by nothing. The allowlist is an exact match — `*.vercel.app`
  in `MCP_ALLOWED_HOSTS` matched nothing, so previews were unverifiable before
  production.

### Changed

- **Dependencies: 2 → 12.** The engine's runtime tree becomes real dependencies
  (`lwk_node`, `boltz-core`, `boltz-swaps`, `liquidjs-lib`,
  `@vulpemventures/secp256k1-zkp`, `@noble/curves`, `@noble/hashes`,
  `@scure/base`, `hash-wasm`, `viem`). All pinned exact. `@modelcontextprotocol/sdk`
  is pinned to a single `1.29.0` and `zod` to a single `3.25.76` — two copies of
  zod would break `instanceof` schema checks across the gateway/wallet boundary.
- **`.npmrc` added** (`save-exact` only) plus a scoped `overrides` entry.
  `boltz-swaps@0.0.8` declares a stale `peerOptional boltz-core@^4.0.5` against
  the pinned `5.0.0`, which makes `npm ci` raise ERESOLVE when both are ROOT
  dependencies (this repo, CI, Vercel). `overrides: { "boltz-swaps":
  { "boltz-core": "5.0.0" } }` resolves the actual conflict — `npm ci` exits 0
  with no advisory and the repo tree holds exactly one `boltz-core` — so the
  blunt `legacy-peer-deps` flag, which would have silenced every future peer
  conflict repo-wide, was dropped. **This does not fix the consumer graph** — see
  Known issues.
- **`@types/node` 22 → 26** (the engine needs the global `CryptoKey` type).
  `src/oauth.ts` now declares the `JsonWebKey` shape it reads locally, since
  `node:crypto` no longer re-exports it in those typings.
- **`/.well-known/mcp.json`** describes both levels instead of a flat "22 tools",
  and gained a machine-readable `levels` object.
- **`registry/server.json`**: description carries the two-level story, and
  `packages[]` declares `DEPIX_API_KEY` (required, secret),
  `DEPIX_WALLET_PASSPHRASE` (optional, secret — required for the 27 wallet tools)
  and `DEPIX_WALLET_DIR` (optional).

### Unchanged (deliberately)

- **The hosted deployment is still exactly 22 tools** and still holds nothing.
  `src/server.ts` registers the same 22; the wallet mounts only in the npx entry
  path. The wallet engine is not "disabled" on the hosted function — it is
  structurally absent from its import graph, which is what `guard:hosted` proves.
- The 22 tools' names, schemas, semantics, scopes and error codes.
- OAuth 2.1 resource-server behaviour and the `AUTHKIT_DOMAIN` feature flag.

### Known issues

- **`boltz-core` still declares `AGPL-3.0` in its `package.json`** while shipping
  an MIT LICENSE file. Upstream merged the metadata fix
  (BoltzExchange/boltz-core#194) but has published **no release carrying it** —
  `5.0.0` is still latest on npm, so the intended bump could not be made. License
  scanners will flag this dependency until then. `THIRD_PARTY_LICENSES` states the
  discrepancy explicitly and reproduces the governing MIT text.
- **A consumer install resolves TWO major versions of `boltz-core`.** Measured on
  a real `npm install` of the packed tarball: `node_modules/boltz-core` is
  **4.0.5** (hoisted to satisfy `boltz-swaps`' peer range) while
  `node_modules/@depixapp/mcp/node_modules/boltz-core` is **5.0.0** (this
  package's pin). So `boltz-swaps` runs against 4.x and the engine against 5.x —
  two majors of a signing library in one process, on the swap path. npm
  `overrides` are root-only and do **not** propagate to consumers, so the in-repo
  fix above cannot reach this. It is **not a regression**: `@depixapp/sdk@1.2.0`
  ships the identical pair today. The real fix is upstream (a `boltz-swaps`
  release whose peer range admits 5.x) or dropping one of the two — a
  post-launch item, deliberately not attempted in this release.
- **`SIDESHIFT_AFFILIATE_ID` is not baked** into published builds unless it is set
  in the publish environment. When unset, the compiled engine keeps its runtime
  env read, so `wallet_shift_usdt` works for an operator who exports the variable
  and fails with `AFFILIATE_ID_MISSING` otherwise. Baking an empty string (what
  the engine's own build does on a dev machine) would remove the runtime read and
  break that tool permanently, so it is skipped instead.
