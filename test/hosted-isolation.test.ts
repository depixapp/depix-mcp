// The structural-separation build guard (unified-MCP spec §2.1).
//
// This does not re-implement the guard; it RUNS it, including its `--self-test`,
// which writes a poisoned api/ entry importing the wallet engine and asserts BOTH
// checks reject it. A guard that cannot fail is not a guard, and the value of this
// test is that the failure path is exercised on every CI run rather than the day
// someone accidentally imports the wallet into the hosted function.
//
// It shells out because the guard compiles the api/ tree with tsc and traces the
// output with @vercel/nft — slow (tens of seconds) but the only honest check.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(repoRoot, "scripts", "check-hosted-isolation.mjs");

describe("hosted isolation guard", () => {
  it(
    "passes on the current tree AND proves it would fail on a poisoned entry",
    async () => {
      const { stdout } = await run("node", [guard, "--self-test"], { cwd: repoRoot });
      // Check A: the source import-graph walk from api/*.ts.
      expect(stdout).toMatch(/A\. import-graph walk: \d+ hosted entries, \d+ source files reached, 0 violations/);
      // Check B: the @vercel/nft trace of the compiled entries.
      expect(stdout).toMatch(/B\. @vercel\/nft trace: \d+ compiled entries, \d+ files traced, 0 violations/);
      // The self-test: poisoned entries — one at the top level and one in a
      // SUBDIRECTORY — must both be DISCOVERED and rejected by BOTH checks. The
      // nested case is the one that used to slip through: entry discovery was not
      // recursive, so an `api/v2/rogue.ts` importing the wallet engine was never
      // looked at and passed both checks silently.
      expect(stdout).toMatch(
        /self-test: 2\/2 poisoned entries discovered \(flat \+ nested\), rejected by A \(2\/2\) and by B \([1-9]\d* violation\(s\)\)/,
      );
      expect(stdout).toContain("[guard] OK");
    },
    180_000,
  );
});
