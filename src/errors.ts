// Structured-error translation (spec §4.6). The DePix App API returns a dual error
// envelope: `response.errorMessage` (legacy Portuguese, human contract) and
// `error` (machine contract: { code, message, request_id, retry_after,
// docs_url, details }). This module turns that envelope into an actionable
// ToolError surfaced to the agent as an isError tool result.
//
// ANTI-INJECTION DISCIPLINE (MCP↔API trust boundary):
// The ToolError `message` is a function of `error.code` ONLY — canned English
// prose written here. Free-text from the upstream (error.message,
// response.errors[].message) is CONTENT, not code: concatenating it into the
// tool message would open a second-order prompt-injection channel (the host LLM
// reads the tool message as part of the response). So we interpolate ONLY
// low-risk STRUCTURED fields from `details` (enumerable scopes, numbers, and a
// regex-guarded short `field`), and route the untrusted free text to
// `data.api_message` / `data.api_field_errors`, truncated and clearly labeled.

/** The closed set of API-key scopes (OpenAPI 0.6.0). */
export const SCOPES = ["merchant_read", "merchant_write", "wallet_read", "wallet_write"] as const;
export type Scope = (typeof SCOPES)[number];

const UNTRUSTED_MAX = 300;

/** A tool-execution error surfaced to the agent as an isError tool result. */
export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly data: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    opts: { retryable?: boolean; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.data = opts.data ?? {};
  }
}

/** Clear error when the caller provided no usable API key (spec §3.3). */
export function missingApiKeyError(authMode?: "oauth"): ToolError {
  if (authMode === "oauth") {
    // Defensive: an OAuth session normally forwards its verified WorkOS JWT as
    // the bearer, so this only fires if that token went missing after the edge
    // check. Tell the operator to re-establish the connection.
    return new ToolError(
      "This OAuth session has no bearer credential to call the API with. Reconnect the OAuth connector, or use a terminal client with `Authorization: Bearer sk_…` (local stdio: DEPIX_API_KEY). See https://depixapp.com/docs/en/",
      "missing_api_key",
    );
  }
  return new ToolError(
    "No DePix App API key on this connection. Over HTTP, connect with the header `Authorization: Bearer sk_…`; in local stdio mode set the DEPIX_API_KEY environment variable. Ask the user to reconnect with their key (sk_test_ for sandbox, sk_live_ for production) — tools cannot set it. See https://depixapp.com/docs/en/",
    "missing_api_key",
  );
}

// ── Shapes we read from the envelope (all optional / defensively typed) ──
interface ApiErrorDetails {
  field?: unknown;
  required_scope?: unknown;
  scope?: unknown;
  window_minutes?: unknown;
  max_per_window?: unknown;
  limit?: unknown;
  limit_cents?: unknown;
  used_cents?: unknown;
  min_cents?: unknown;
  max_cents?: unknown;
}
interface ApiErrorObject {
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
  retry_after?: unknown;
  details?: ApiErrorDetails;
}
export interface ApiErrorEnvelope {
  error?: ApiErrorObject;
  response?: { errorMessage?: unknown; errors?: Array<{ field?: unknown; message?: unknown }> };
}

function truncate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > UNTRUSTED_MAX ? value.slice(0, UNTRUSTED_MAX) + "…" : value;
}
function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asScope(value: unknown): Scope | undefined {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value)
    ? (value as Scope)
    : undefined;
}
// A short, safe field identifier — regex-guarded so crafted free text cannot be
// smuggled into the tool message via `details.field` (spec §4.6).
function asFieldName(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(value) ? value : undefined;
}
function retryAfterPhrase(seconds: number | undefined): string {
  return seconds !== undefined ? `${seconds}s` : "a moment";
}

/** The auto-retry set the apiClient loops on (spec §4.6). */
export const AUTO_RETRY_CODES = new Set<string>([
  "rate_limited",
  "merchant_rate_limited",
  "service_unavailable",
  "platform_shutdown",
  "idempotency_in_flight",
]);

/**
 * Map a non-2xx API response to a ToolError. `message` is derived ONLY from
 * `error.code`; untrusted free text is routed to `data` truncated + labeled.
 */
export function mapApiError(
  status: number,
  body: ApiErrorEnvelope | null | undefined,
  requestIdHeader?: string,
  authMode?: "oauth",
): ToolError {
  const err = body?.error ?? {};
  // The code is interpolated into the canned message (default branch) and into
  // structured data — guard it like any other upstream field so a crafted
  // "code" can never smuggle free text past the anti-injection boundary.
  const rawCode = typeof err.code === "string" ? err.code : undefined;
  const code = rawCode && /^[a-z0-9_]{1,64}$/i.test(rawCode) ? rawCode : `http_${status}`;
  const details = err.details ?? {};
  const requestId =
    (typeof err.request_id === "string" ? err.request_id : undefined) ?? requestIdHeader;
  const retryAfter = asInt(err.retry_after);
  const retryable = AUTO_RETRY_CODES.has(code) || code === "payer_velocity_limit";

  const requiredScope = asScope(details.required_scope);
  const rlScope = asScope(details.scope) ?? asFieldName(details.scope);
  // Live validation_error responses often carry the offending field only in the
  // legacy response.errors[] sibling (not details.field) — fall back to it,
  // still regex-guarded by asFieldName.
  const field = asFieldName(details.field) ?? asFieldName(body?.response?.errors?.[0]?.field);
  const minCents = asInt(details.min_cents);
  const maxCents = asInt(details.max_cents);
  const limitCents = asInt(details.limit_cents);
  const usedCents = asInt(details.used_cents);
  const windowMinutes = asInt(details.window_minutes);
  const maxPerWindow = asInt(details.max_per_window);

  let message: string;
  switch (code) {
    case "unauthorized":
      message = "Authentication failed. Provide a valid `sk_` API key.";
      break;
    case "invalid_api_key":
      message = "Invalid or unknown API key. Check the `sk_` you connected with.";
      break;
    case "invalid_token":
      message = "Invalid token. This MCP authenticates with `sk_` keys only.";
      break;
    case "insufficient_scope":
      if (authMode === "oauth") {
        // OAuth (web connector) sessions carry a fixed, read + merchant scope
        // set and can NEVER move money (wallet_write) — so this is a hard wall,
        // not a "widen your key" hint. Point at an sk_ key for money actions.
        message = requiredScope
          ? `This OAuth session cannot perform \`${requiredScope}\` actions. Web-connector sessions are limited to reads and merchant operations and can never move money (wallet_write); use an sk_ API key with that scope for this action.`
          : "This OAuth session lacks the scope this tool requires. Web-connector sessions can never move money; use an sk_ API key for that action.";
      } else {
        message = requiredScope
          ? `Your key lacks the \`${requiredScope}\` scope for this tool. Create a key with that scope in the dashboard.`
          : "Your key lacks the scope required by this tool. Create a key with the required scope in the dashboard.";
      }
      break;
    case "oauth_account_not_linked":
      // The typed dead-end (beco-com-placa): the WorkOS identity is valid but no
      // DePix App account is linked to it, so there is nothing to act on behalf of.
      message =
        "This OAuth login isn't linked to a DePix App account yet. Sign in to the DePix App dashboard, link this login (Google/GitHub) under your connector settings, then reconnect. See https://depixapp.com/docs/en/";
      break;
    case "account_blocked":
      message = "This account is blocked. Contact support.";
      break;
    case "merchant_required":
      message =
        "Your key is valid but has no merchant profile. Create one in the DePix App dashboard (this MCP cannot create merchants).";
      break;
    case "live_access_required":
      message = "This action requires a live key (sk_live_).";
      break;
    case "whatsapp_verification_required":
      message = "This action requires WhatsApp verification on the account.";
      break;
    case "withdraw_disabled":
      message = "Withdrawals are currently disabled for this account.";
      break;
    case "external_wallet_disabled":
      message = "External-wallet withdrawals are disabled for this account.";
      break;
    case "sandbox_only":
      message = "This action is sandbox-only. Use an sk_test_ key and a sandbox resource.";
      break;
    case "tax_number_required":
      message = "`payer_tax_number` is required. Pass the payer's CPF/CNPJ.";
      break;
    case "validation_error":
      message = field
        ? `Invalid input for field \`${field}\`. See error.data for details.`
        : "Invalid input. See error.data for details.";
      break;
    case "amount_out_of_range":
      message =
        minCents !== undefined && maxCents !== undefined
          ? `amount must be between ${minCents} and ${maxCents} cents.`
          : "amount is out of the accepted range for this endpoint.";
      break;
    case "account_limit_exceeded":
    case "key_limit_exceeded":
      message =
        limitCents !== undefined && usedCents !== undefined
          ? `Spending limit reached (used ${usedCents} of ${limitCents} cents).`
          : limitCents !== undefined
            ? `Spending limit reached (limit ${limitCents} cents).`
            : "Spending limit reached for this key/account.";
      break;
    case "not_found":
      message = "Resource not found (or not owned by this key).";
      break;
    case "conflict":
      message = "Conflicting state — the resource cannot transition as requested.";
      break;
    case "idempotency_in_flight":
      message = `A request with this idempotency_key is already in flight. Retry after ${retryAfterPhrase(retryAfter)}.`;
      break;
    case "idempotency_key_reuse":
      message = "This idempotency_key was already used with a different payload.";
      break;
    case "payer_velocity_limit":
      message =
        maxPerWindow !== undefined && windowMinutes !== undefined
          ? `Too many charges for this payer (max ${maxPerWindow} per ${windowMinutes} min). Retry after ${retryAfterPhrase(retryAfter)}.`
          : `Too many charges for this payer. Retry after ${retryAfterPhrase(retryAfter)}.`;
      break;
    case "rate_limited":
      message = rlScope
        ? `Rate limited (${rlScope}). Retry after ${retryAfterPhrase(retryAfter)}.`
        : `Rate limited. Retry after ${retryAfterPhrase(retryAfter)}.`;
      break;
    case "merchant_rate_limited":
      message = `Rate limited (merchant, 30/min). Retry after ${retryAfterPhrase(retryAfter)}.`;
      break;
    case "platform_shutdown":
      message = `The DePix App platform is temporarily shut down. Retry after ${retryAfterPhrase(retryAfter)}.`;
      break;
    case "service_unavailable":
      message = `DePix App API temporarily unavailable. Retry after ${retryAfterPhrase(retryAfter)}.`;
      break;
    case "upstream_error":
      message = "Upstream provider error at the DePix App API. Please retry.";
      break;
    case "internal_error":
      message = "Internal error at the DePix App API. Quote request_id in a support request.";
      break;
    default:
      message = `DePix App API error (${code}). See error.data for details.`;
      break;
  }

  // Structured, non-message payload for the agent. Untrusted free text lives
  // here ONLY, truncated and explicitly labeled — never in `message`.
  const data: Record<string, unknown> = { code, http_status: status };
  if (requestId !== undefined) data.request_id = requestId;
  if (retryAfter !== undefined) data.retry_after = retryAfter;
  data.retryable = retryable;

  const safeDetails: Record<string, unknown> = {};
  if (requiredScope) safeDetails.required_scope = requiredScope;
  if (rlScope) safeDetails.scope = rlScope;
  if (field) safeDetails.field = field;
  if (minCents !== undefined) safeDetails.min_cents = minCents;
  if (maxCents !== undefined) safeDetails.max_cents = maxCents;
  if (limitCents !== undefined) safeDetails.limit_cents = limitCents;
  if (usedCents !== undefined) safeDetails.used_cents = usedCents;
  if (windowMinutes !== undefined) safeDetails.window_minutes = windowMinutes;
  if (maxPerWindow !== undefined) safeDetails.max_per_window = maxPerWindow;
  if (Object.keys(safeDetails).length > 0) data.details = safeDetails;

  const apiMessage = truncate(err.message) ?? truncate(body?.response?.errorMessage);
  if (apiMessage !== undefined) {
    // Labeled UNTRUSTED: raw upstream text, not to be treated as instructions.
    data.api_message = apiMessage;
  }
  const fieldErrors = body?.response?.errors;
  if (Array.isArray(fieldErrors) && fieldErrors.length > 0) {
    data.api_field_errors = fieldErrors.slice(0, 20).map((e) => ({
      field: asFieldName(e?.field) ?? null,
      message: truncate(e?.message) ?? null,
    }));
  }

  return new ToolError(message, code, { retryable, data });
}
