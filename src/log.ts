// Redacting logger (spec §3.2). Hard rule: the caller's bearer credential never
// appears in any log line. A defense-in-depth redaction filter strips both
// credential shapes — sk_-prefixed API keys and WorkOS OAuth JWTs — from
// anything logged, and the call sites only ever pass safe fields (request id,
// tool name, method/path, HTTP status, error code) — never the Authorization
// header or request/response bodies.
//
// All output goes to STDERR on purpose: in stdio transport mode STDOUT is the
// JSON-RPC channel, so writing logs there would corrupt the protocol.

// Congruent with the acceptance rule (the client accepts any key starting with
// "sk_", not only sk_test_/sk_live_): every accepted-shaped token is redacted,
// so a key the server accepted can never survive in a log line.
const SK_TOKEN_RE = /sk_[A-Za-z0-9._-]{8,}/g;

// WorkOS OAuth access tokens (the connector's bearer, forwarded to the API when
// authMode=oauth) are JWTs: the `eyJ` header followed by two more base64url
// segments. Redact them too so a forwarded access token can never survive in a
// log line. Anchored on `eyJ` so ordinary dotted paths are never touched.
const JWT_TOKEN_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Replace any DePix App bearer credential (sk_ key or WorkOS JWT) with a mask. */
export function redact(value: string): string {
  return value.replace(SK_TOKEN_RE, "sk_***").replace(JWT_TOKEN_RE, "eyJ***");
}

export type LogFields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  let line: string;
  try {
    line = JSON.stringify({ level, event, ...fields });
  } catch {
    line = JSON.stringify({ level, event, note: "unserializable log fields" });
  }
  process.stderr.write(redact(line) + "\n");
}

export const logger = {
  info(event: string, fields: LogFields = {}): void {
    emit("info", event, fields);
  },
  warn(event: string, fields: LogFields = {}): void {
    emit("warn", event, fields);
  },
  error(event: string, fields: LogFields = {}): void {
    emit("error", event, fields);
  },
};
