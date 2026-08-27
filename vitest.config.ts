import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The wallet-engine suite derives real keys: Argon2id at 19 MiB (deliberate)
    // and the read-only Esplora integration test both need headroom well beyond
    // the 5 s default.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    env: {
      // The engine reads this at module load. A placeholder keeps the SideShift
      // paths on their "affiliate configured" branch without shipping the real
      // id into a test run; an operator can still override it from the shell.
      SIDESHIFT_AFFILIATE_ID: process.env.SIDESHIFT_AFFILIATE_ID ?? "test-affiliate",
    },
  },
});
