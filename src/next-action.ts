// The `next_action` catalog (SPEC_AGENT_ONBOARDING §5.1 / D13). Every typed,
// agent-facing error carries ONE machine-readable `next_action` telling the model
// what to do next, so an agent with no docs can still walk the onboarding ladder
// (smoke ST.2). The didactic copy is HARDCODED here, never taken from the
// backend: the anti-injection boundary (errors.ts / wallet-engine/mcp/errors.ts)
// discards upstream text, so the copy must live on this side.
//
// WHY THIS FILE AND NOT wallet-engine/mcp/errors.ts (where §5.1 first placed it):
// the §5.1 map spans codes surfaced by BOTH error mappers — the gateway's
// `src/errors.ts` (which the HOSTED bundle imports and therefore must NOT reach
// the wallet engine, per scripts/check-hosted-isolation.mjs) and the wallet
// engine's `mcp/errors.ts`. A single shared copy can only sit in a module both
// may import, so it lives here, dependency-free and hosted-safe.
//
// RULES (a test enforces them):
//   - `kind` is a CLOSED set of 5;
//   - exactly ONE next_action per error;
//   - `relay` (the PT+EN text the agent pastes to the HUMAN — ≤4 steps, zero
//     jargon, D11) is present IFF kind === "human_step";
//   - `retry_after_seconds` is a MIRROR of the error's retry_after, never a third
//     source of truth — the caller passes it in.

/** The closed set of next-action kinds (§5.1). */
export const NEXT_ACTION_KINDS = ["call_tool", "human_step", "http_call", "wait", "reconnect"] as const;
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

export interface NextAction {
  kind: NextActionKind;
  /** For kind "call_tool": the tool the agent should call next. */
  tool?: string;
  /** For kind "human_step"/"http_call"/"reconnect": a URL the human or agent opens. */
  url?: string;
  /** PT+EN text the agent relays to the human. Present IFF kind === "human_step". */
  relay?: { pt: string; en: string };
  /** For kind "wait": mirror of the error's retry_after (seconds). */
  retry_after_seconds?: number;
}

/** Where the human signs up / operates the account (the app door, §4.2). */
export const APP_URL = "https://depixapp.com/app";
/** The docs anchor for the typed-error contract (D13 docs_url). */
export const DOCS_ERRORS_URL = "https://depixapp.com/docs#errors";
/** Where the human gets their operator token (op_…) — §3.5. */
export const OPERATOR_START_URL = "https://api.depixapp.com/api/agents/oauth/start";
/** Where the human reaches support (blocked/revoked accounts). */
export const SUPPORT_URL = "https://depixapp.com/app/support";

/** Context that steers the deployment-sensitive entries (missing_api_key, §5.1). */
export interface NextActionContext {
  /** "hosted" (mcp.depixapp.com) vs "local" (npx). Decides the missing_api_key path. */
  deployment?: "hosted" | "local";
  /** "oauth" when the connection authenticated with a WorkOS JWT (no sk_). */
  authMode?: "oauth";
  /** The error's retry_after (seconds) — mirrored into a "wait" next_action. */
  retryAfterSeconds?: number;
}

// The op_ relay (§3.5) — written for the HUMAN, easy path first, zero jargon.
const OPERATOR_TOKEN_RELAY = {
  pt:
    "Para eu abrir/gerir sua conta, preciso de um código seu. Leva 1 minuto: " +
    `1) abra ${OPERATOR_START_URL}; ` +
    "2) entre com seu GitHub ou Google; " +
    "3) copie o código que aparecer (começa com op_) — ele reaparece sempre que você entrar nessa página; " +
    "4) cole aqui na conversa.",
  en:
    "To open/manage your account I need a code from you. It takes 1 minute: " +
    `1) open ${OPERATOR_START_URL}; ` +
    "2) sign in with your GitHub or Google; " +
    "3) copy the code shown (it starts with op_) — it reappears every time you open that page; " +
    "4) paste it here in the chat.",
} as const;

const SIGNUP_RELAY = {
  pt:
    "Já tem conta DePix? Entre e conecte este login. Se ainda não: " +
    `1) abra ${APP_URL} e crie sua conta com o mesmo Google ou GitHub; ` +
    "2) volte aqui e me peça de novo.",
  en:
    "Already have a DePix account? Sign in and connect this login. If not: " +
    `1) open ${APP_URL} and create your account with the same Google or GitHub; ` +
    "2) come back and ask me again.",
} as const;

const SUPPORT_RELAY = {
  pt: `Esta conta está bloqueada. Fale com o suporte em ${SUPPORT_URL} para resolver — eu não consigo daqui.`,
  en: `This account is blocked. Contact support at ${SUPPORT_URL} to resolve it — I cannot from here.`,
} as const;

/**
 * The next_action for a typed error code, or undefined when the code carries
 * none. `ctx` steers the deployment-sensitive entries and mirrors retry_after.
 */
export function nextActionFor(code: string, ctx: NextActionContext = {}): NextAction | undefined {
  switch (code) {
    // ── credentials ──
    case "missing_api_key":
      if (ctx.authMode === "oauth") {
        // The WorkOS JWT went missing after the edge check — reconnect the OAuth
        // connector; there is no key to mint here.
        return { kind: "reconnect", url: APP_URL };
      }
      if (ctx.deployment === "local") {
        // Local (npx): the account tool IS available — mint the key in-process.
        return { kind: "call_tool", tool: "register_account" };
      }
      // Hosted, no bearer: the human signs up in the app, then reconnects.
      return {
        kind: "human_step",
        url: APP_URL,
        relay: SIGNUP_RELAY,
      };
    case "api_key_required":
      // The wallet keyed tools (deposit/withdraw) hit this locally — the account
      // tool mints the key without a restart.
      return { kind: "call_tool", tool: "register_account" };
    case "WALLET_CLOSED":
      // The unified server closed this wallet instance under the caller to
      // reopen it with a new credential; the same call succeeds on the new one.
      return { kind: "wait", retry_after_seconds: 0 };

    // ── wallet / init ──
    case "wallet_not_configured":
      return {
        kind: "human_step",
        relay: {
          pt:
            "Preciso de uma carteira neste computador. Peça ao operador para, num terminal, rodar " +
            "`npx -y @depixapp/mcp init` (cria a carteira e mostra as 12 palavras uma vez), e depois reiniciar. " +
            "Nunca me mande as 12 palavras.",
          en:
            "I need a wallet on this machine. Ask the operator to run `npx -y @depixapp/mcp init` in a terminal " +
            "(it creates the wallet and shows the 12 words once), then restart. Never send me the 12 words.",
        },
      };

    // ── the local credential vault (§3.1) ──
    // A model that hits these has NO way to guess the cause from the code alone:
    // the vault opens with DEPIX_WALLET_PASSPHRASE, DEPIX_AGENT_PASSPHRASE, or
    // the keychain unlock key `init` stores. Name the doors, not just a command.
    // `credentials_locked` is the same situation seen from the gateway side, so
    // it shares this relay rather than getting a second copy that could drift.
    case "agent_key_unreadable":
    case "agent_store_corrupted":
    case "credentials_locked":
      return {
        kind: "human_step",
        relay: {
          pt:
            "O cofre de credenciais deste computador não abre — falta a senha que o protege, ou ela mudou. " +
            "Peça ao operador para rodar `npx -y @depixapp/mcp init` num terminal (cria a carteira e guarda essa " +
            "senha no chaveiro do sistema), ou para conferir DEPIX_WALLET_PASSPHRASE na configuração do servidor — e " +
            "DEPIX_AGENT_PASSPHRASE, que tem precedência sobre ela se estiver definida —, e reiniciar. " +
            "Não crie outra conta: a que existe aqui continua sendo a certa.",
          en:
            "The credential vault on this machine will not open — the passphrase that seals it is missing or changed. " +
            "Ask the operator to run `npx -y @depixapp/mcp init` in a terminal (it creates the wallet and keeps that " +
            "passphrase in the system keychain), or to check DEPIX_WALLET_PASSPHRASE in the server config — and " +
            "DEPIX_AGENT_PASSPHRASE, which takes precedence over it when set — then restart. " +
            "Do not open a second account: the one already here is still the right one.",
        },
      };

    // ── the operator's own login (`depix-mcp login`) ──
    case "owner_session_expired":
      return {
        kind: "human_step",
        relay: {
          pt:
            "O login do dono neste computador expirou. Peça ao operador para rodar `npx -y @depixapp/mcp login` " +
            "num terminal e entrar de novo com Google ou GitHub.",
          en:
            "The owner's login on this machine expired. Ask the operator to run `npx -y @depixapp/mcp login` in a " +
            "terminal and sign in again with Google or GitHub.",
        },
      };

    // ── operator token (§3.5) ──
    case "invalid_operator_token":
    case "operator_token_required":
    case "operator_token_missing":
      return { kind: "human_step", url: OPERATOR_START_URL, relay: OPERATOR_TOKEN_RELAY };
    case "operator_token_revoked":
      return {
        kind: "human_step",
        url: SUPPORT_URL,
        relay: {
          pt: `Seu código de operador foi revogado. Fale com o suporte em ${SUPPORT_URL} — não dá para reativá-lo relogando.`,
          en: `Your operator code was revoked. Contact support at ${SUPPORT_URL} — re-logging in will not reactivate it.`,
        },
      };
    case "operator_oauth_failed":
      return { kind: "human_step", url: OPERATOR_START_URL, relay: OPERATOR_TOKEN_RELAY };

    // ── OAuth linkage (§4.1) ──
    case "oauth_account_not_linked":
      return { kind: "human_step", url: APP_URL, relay: SIGNUP_RELAY };

    // ── merchant / verification ladder (§4.3) ──
    case "merchant_required":
    case "verification_required":
    case "verification_requirements_not_met":
    case "verification_tax_number_in_use":
      return { kind: "call_tool", tool: "get_onboarding_status" };
    case "verification_under_review":
    case "verification_unavailable":
      return { kind: "wait", ...(ctx.retryAfterSeconds !== undefined ? { retry_after_seconds: ctx.retryAfterSeconds } : {}) };

    // ── scope / live ──
    case "insufficient_scope":
      return {
        kind: "human_step",
        url: APP_URL,
        relay: {
          pt: `Sua chave não tem a permissão necessária para isto. Crie uma chave com o escopo certo em ${APP_URL} e reconecte.`,
          en: `Your key lacks the permission this needs. Create a key with the right scope at ${APP_URL} and reconnect.`,
        },
      };
    case "live_access_required":
      return { kind: "call_tool", tool: "get_onboarding_status" };

    // ── graduation / domain (§3.3) ──
    case "graduation_pending":
    case "domain_required":
      return { kind: "call_tool", tool: "verify_domain" };
    case "domain_txt_not_found":
      return {
        kind: "human_step",
        relay: {
          pt:
            "O registro DNS de verificação ainda não apareceu. Peça ao operador para criar o TXT que verify_domain " +
            "mostrou e esperar alguns minutos até propagar; depois eu confirmo de novo.",
          en:
            "The verification DNS record isn't visible yet. Ask the operator to create the TXT record verify_domain " +
            "showed and wait a few minutes for it to propagate; then I'll confirm again.",
        },
      };

    // ── blocked / suspended (support) ──
    case "registration_blocked":
    case "account_blocked":
    case "account_suspended":
      return { kind: "human_step", url: SUPPORT_URL, relay: SUPPORT_RELAY };

    // ── kill switch / rate limit (§5.1) ──
    case "agents_disabled":
      return { kind: "wait", ...(ctx.retryAfterSeconds !== undefined ? { retry_after_seconds: ctx.retryAfterSeconds } : {}) };
    case "rate_limited":
    case "merchant_rate_limited":
    case "payer_velocity_limit":
    case "platform_shutdown":
    case "service_unavailable":
    case "operator_register_cap_exceeded":
      return { kind: "wait", ...(ctx.retryAfterSeconds !== undefined ? { retry_after_seconds: ctx.retryAfterSeconds } : {}) };

    // ── register conflicts (retry with different params) ──
    case "agent_pubkey_exists":
    case "username_taken":
      return { kind: "call_tool", tool: "register_account" };

    // ── agent-local tool preconditions ──
    case "agent_not_initialized":
      return { kind: "call_tool", tool: "register_account" };
    case "credentials_persist_failed":
      return {
        kind: "human_step",
        url: SUPPORT_URL,
        relay: {
          pt: `A conta foi criada, mas não consegui salvar a chave de API neste computador — e o servidor só a mostra uma vez. Fale com o suporte em ${SUPPORT_URL} com seu usuário para gerar uma nova chave.`,
          en: `The account was created, but I could not save its API key on this machine — and the server shows it only once. Contact support at ${SUPPORT_URL} with your username to issue a new key.`,
        },
      };

    default:
      return undefined;
  }
}

/**
 * Attach the code's next_action (and the docs anchor) to a tool-error `data`
 * bag, in place, without overwriting one an error factory already set. Returns
 * the same object for chaining. A code with no mapping is left untouched.
 */
export function withNextAction(
  data: Record<string, unknown>,
  code: string,
  ctx: NextActionContext = {},
): Record<string, unknown> {
  if (data.next_action !== undefined) return data;
  const action = nextActionFor(code, ctx);
  if (action === undefined) return data;
  data.next_action = action;
  if (data.docs_url === undefined) data.docs_url = DOCS_ERRORS_URL;
  return data;
}
