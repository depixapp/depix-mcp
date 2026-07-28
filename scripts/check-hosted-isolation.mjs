// BUILD GUARD — the DePix App-hosted deployment must have ZERO path to the wallet
// engine (unified-MCP spec §2.1).
//
// The non-custodial guarantee of mcp.depixapp.com is STRUCTURAL, not a promise:
// the hosted entry (`api/mcp.ts` -> src/http.ts -> src/server.ts) has no import
// path to the vendored engine, so no signer, no seed store and no `lwk_node` can
// exist in that function at all. Neither this repo nor Vercel runs a tree-shaking
// bundler over it and `tsc` does zero dead-code elimination, so "it would be
// tree-shaken" is not a defence — the only thing that holds is the import graph,
// and this script is what keeps it honest.
//
// TWO INDEPENDENT CHECKS, because each one alone has a blind spot:
//
//   A. STATIC IMPORT-GRAPH WALK over the TypeScript SOURCE from every api/*.ts.
//      Sees type-only edges and dynamic import() specifiers a runtime trace would
//      miss, and needs no build. Fails on any edge into src/vendor/** or onto a
//      denylisted engine package.
//
//   B. @vercel/nft TRACE of the COMPILED api entries — the same tracer Vercel
//      uses to decide what enters the function bundle. Sees what the source walk
//      cannot: what the DEPENDENCIES drag in. Fails if any traced file is a
//      vendored-engine file, lives in a denylisted package, or is a .wasm.
//
// Usage: node scripts/check-hosted-isolation.mjs [--self-test]
//   --self-test additionally proves BOTH checks FAIL on a deliberately poisoned
//   entry that imports the engine — a guard that cannot fail is not a guard.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(repoRoot, "vendor", "engine.pin.json"), "utf8"));
const VENDOR_SEGMENT = pin.target.split("/").slice(1).join(sep); // "vendor/depix-sdk"
const VENDOR_DIR = pin.target.split("/").join(sep); // "src/vendor/depix-sdk"

/**
 * Packages only the wallet engine uses. `lwk_node` is the load-bearing one (the
 * wasm signer); the rest are the money/cryptography tree that must never be
 * reachable from the keyless hosted function.
 */
const DENIED_PACKAGES = [
  "lwk_node",
  "boltz-core",
  "boltz-swaps",
  "liquidjs-lib",
  "@vulpemventures/secp256k1-zkp",
  "hash-wasm",
  "viem",
  "@noble/curves",
  "@noble/hashes",
  "@scure/base",
];

/** A trace that resolved almost nothing would report "0 violations" and look green. */
const TRACE_FLOOR = 50;

const selfTest = process.argv.includes("--self-test");
const failures = [];

// ── shared: a dependency-free import extractor ───────────────────────────────

function stripComments(code) {
  // Block + line comments only. Enough: a specifier is always a plain quoted
  // string, and comments are the one place where import-looking text is common
  // (this file's own header would otherwise match).
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function extractSpecifiers(code) {
  const src = stripComments(code);
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g, // import x from "y" / export … from "y"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("y")
    /\bimport\s+["']([^"']+)["']/g, // side-effect import "y"
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // createRequire()("y")
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) specifiers.add(m[1]);
  }
  return [...specifiers];
}

/** Map a relative ESM specifier ("./x.js") back to its TypeScript source file. */
function resolveSourceFile(fromFile, specifier) {
  const abs = resolve(dirname(fromFile), specifier);
  const candidates = [abs.replace(/\.js$/, ".ts"), abs, `${abs}.ts`, join(abs, "index.ts")];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function packageOfSpecifier(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

// ── check A — static import-graph walk from the hosted entries ───────────────

function walkSourceGraph(entries) {
  const visited = new Set();
  const violations = [];
  const queue = entries.map((e) => ({ file: e, via: [] }));
  while (queue.length > 0) {
    const { file, via } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const rel = relative(repoRoot, file);
    if (rel.startsWith(VENDOR_DIR)) {
      violations.push(`vendored engine reachable: ${rel}\n        via ${[...via, rel].join("\n         -> ")}`);
      continue; // one edge is already fatal; do not descend into the engine
    }
    for (const specifier of extractSpecifiers(readFileSync(file, "utf8"))) {
      const pkg = packageOfSpecifier(specifier);
      if (pkg !== null) {
        if (DENIED_PACKAGES.includes(pkg)) {
          violations.push(`engine package "${pkg}" imported by ${rel}\n        via ${[...via, rel].join("\n         -> ")}`);
        }
        continue; // bare specifiers are not walked further — check B covers deps
      }
      const target = resolveSourceFile(file, specifier);
      if (target !== null) queue.push({ file: target, via: [...via, rel] });
    }
  }
  return { visited, violations };
}

// ── check B — @vercel/nft trace of the compiled hosted entries ──────────────

const GUARD_OUT = join(repoRoot, ".guard-dist");
const GUARD_TSCONFIG = join(repoRoot, ".guard-tsconfig.json");

function compileForTrace() {
  // Both the config AND the emitted output must live INSIDE the repo: `types:
  // ["node"]` resolves against the config's own directory, and @vercel/nft
  // resolves bare specifiers by walking up from each traced file to a
  // node_modules — from /tmp it finds neither and silently traces nothing.
  rmSync(GUARD_OUT, { recursive: true, force: true });
  writeFileSync(
    GUARD_TSCONFIG,
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: false,
          declaration: false,
          sourceMap: false,
          outDir: relative(repoRoot, GUARD_OUT),
          rootDir: ".",
        },
        include: ["api", "src"],
      },
      null,
      2,
    ),
  );
  try {
    execFileSync("npx", ["tsc", "-p", GUARD_TSCONFIG], { cwd: repoRoot, stdio: "pipe" });
  } finally {
    rmSync(GUARD_TSCONFIG, { force: true });
  }
}

async function traceCompiled(entryFilter) {
  const { nodeFileTrace } = await import("@vercel/nft");
  const entries = readdirSync(join(GUARD_OUT, "api"))
    .filter((f) => f.endsWith(".js") && entryFilter(f))
    .map((f) => join(GUARD_OUT, "api", f));
  const { fileList, warnings } = await nodeFileTrace(entries, { base: repoRoot, processCwd: repoRoot });
  const traced = [...fileList];
  const violations = traced.filter((f) => {
    const norm = f.split("/").join(sep);
    if (norm.includes(VENDOR_SEGMENT)) return true;
    if (norm.endsWith(".wasm")) return true;
    return DENIED_PACKAGES.some((p) => norm.includes(join("node_modules", ...p.split("/")) + sep));
  });
  return { entries, traced, violations, warnings };
}

// ── run ──────────────────────────────────────────────────────────────────────

const apiEntries = readdirSync(join(repoRoot, "api"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(repoRoot, "api", f));

const graph = walkSourceGraph(apiEntries);
if (graph.violations.length > 0) failures.push(`A. import-graph walk from api/*.ts:\n      - ${graph.violations.join("\n      - ")}`);
console.log(
  `[guard] A. import-graph walk: ${apiEntries.length} hosted entries, ${graph.visited.size} source files reached, ` +
    `${graph.violations.length} violations.`,
);

// The poisoned self-test entry is written BEFORE the compile so one tsc run
// covers both the real check and the self-test trace.
const poisoned = selfTest ? join(repoRoot, "api", `zz-guard-self-test-${process.pid}.ts`) : null;
if (poisoned !== null) {
  writeFileSync(
    poisoned,
    "// TEMPORARY self-test fixture — written and deleted by scripts/check-hosted-isolation.mjs.\n" +
      'import { WALLET_TOOL_NAMES } from "../src/vendor/depix-sdk/mcp/server.js";\n' +
      "export default WALLET_TOOL_NAMES;\n",
  );
}

try {
  compileForTrace();
  const real = await traceCompiled((f) => !f.startsWith("zz-guard-self-test-"));
  if (real.violations.length > 0) {
    failures.push(`B. @vercel/nft trace of the compiled api/*.js:\n      - ${real.violations.join("\n      - ")}`);
  }
  if (real.traced.length < TRACE_FLOOR) {
    failures.push(
      `B. the trace resolved only ${real.traced.length} files (< ${TRACE_FLOOR}) — the tracer did not follow the import ` +
        "graph, so its 'no violations' result is meaningless. Fix the tracer before trusting this guard.",
    );
  }
  console.log(
    `[guard] B. @vercel/nft trace: ${real.entries.length} compiled entries, ${real.traced.length} files traced, ` +
      `${real.violations.length} violations${real.warnings?.size ? ` (${real.warnings.size} tracer warnings, non-fatal)` : ""}.`,
  );

  if (poisoned !== null) {
    const graphSelfTest = walkSourceGraph([poisoned]);
    if (graphSelfTest.violations.length === 0) {
      failures.push("SELF-TEST A: the import-graph walk did NOT flag an entry importing the vendored engine — the guard is broken.");
    }
    const traceSelfTest = await traceCompiled((f) => f.startsWith("zz-guard-self-test-"));
    if (traceSelfTest.violations.length === 0) {
      failures.push("SELF-TEST B: the @vercel/nft trace did NOT flag a compiled entry importing the vendored engine — the guard is broken.");
    }
    console.log(
      `[guard] self-test: poisoned entry rejected by A (${graphSelfTest.violations.length} violation(s)) ` +
        `and by B (${traceSelfTest.violations.length} violation(s)).`,
    );
  }
} catch (err) {
  failures.push(`B. @vercel/nft trace could not run: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (poisoned !== null) rmSync(poisoned, { force: true });
  rmSync(GUARD_OUT, { recursive: true, force: true });
  rmSync(GUARD_TSCONFIG, { force: true });
}

if (failures.length > 0) {
  console.error(
    "\n[guard] FAIL — the hosted deployment is no longer structurally keyless:\n\n    " +
      failures.join("\n\n    ") +
      "\n\n  The wallet engine may be reached ONLY from the stdio bin (src/stdio.ts -> src/unified.ts).\n",
  );
  process.exit(1);
}
console.log("[guard] OK — the hosted entries reach neither the vendored engine nor any wallet-engine package.");
