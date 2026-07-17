import { describe, expect, it } from "vitest";
import { redact } from "../src/log.js";

describe("redact (acceptance ⊆ redaction)", () => {
  // The client accepts any key starting with "sk_" — every accepted-shaped
  // token must be redacted, not only the sk_test_/sk_live_ prefixes.
  const ACCEPTED_KEYS = [
    "sk_test_ABCDEF123456",
    "sk_live_ABCDEF123456",
    "sk_0123456789abcdef",
    "sk_some-future.prefix_KEY123",
  ];

  it("strips every accepted-shaped key from log lines", () => {
    for (const key of ACCEPTED_KEYS) {
      const line = `error while calling api with Bearer ${key} attempt=1`;
      const out = redact(line);
      expect(out).not.toContain(key);
      expect(out).toContain("sk_***");
    }
  });

  it("redacts keys embedded in JSON", () => {
    const out = redact(JSON.stringify({ auth: "Bearer sk_live_SECRETSECRET" }));
    expect(out).not.toContain("SECRETSECRET");
  });

  it("leaves unrelated text untouched", () => {
    expect(redact("no keys here, just a skate sk8er")).toBe("no keys here, just a skate sk8er");
  });

  // OAuth connector sessions forward a WorkOS JWT as the bearer — it must be
  // redacted too, so a forwarded access token can never survive in a log line.
  it("strips a WorkOS JWT (eyJ… three-segment) from log lines", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1c2VyXzAxWCJ9.aVeryLong-Signature_segment123";
    const out = redact(`oauth session bearer ${jwt} done`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("eyJ***");
  });

  it("redacts a JWT embedded in JSON", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJTRUNSRVQifQ.SIGSIGSIG_secret";
    const out = redact(JSON.stringify({ auth: `Bearer ${jwt}` }));
    expect(out).not.toContain("SIGSIGSIG_secret");
  });

  it("does not touch ordinary dotted paths (JWT redaction is anchored on eyJ)", () => {
    expect(redact("GET /api/checkouts/chk_1.foo.bar ok")).toBe("GET /api/checkouts/chk_1.foo.bar ok");
  });
});
