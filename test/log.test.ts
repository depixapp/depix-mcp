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
});
