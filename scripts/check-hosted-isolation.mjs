// BUILD GUARD — the DePix App-hosted deployment must have ZERO path to the wallet
// engine (unified-MCP spec §2.1).
//
// The non-custodial guarantee of mcp.depixapp.com is STRUCTURAL, not a promise:
// the hosted entry (`api/mcp.ts` -> src/http.ts -> src/server.ts) has no import
// path to the wallet engine, so no signer, no seed store and no `lwk_node` can
// exist in that function at all. Neither this repo nor Vercel runs a tree-shaking
// bundler over it and `tsc` does zero dead-code elimination, so "it would be
// tree-shaken" is not a defence — the only thing that holds is the import graph,
// and this script is what keeps it honest.
//
// TWO INDEPENDENT CHECKS, because each one alone has a blind spot:
//
//   A. STATIC IMPORT-GRAPH WALK over the TypeScript SOURCE from every api/*.ts.
//      Sees type-only edges and dynamic import() specifiers a runtime trace would
//      miss, and needs no build. Fails on any edge into src/wallet-engine/** or
//      onto a denylisted engine package.
//
//   B. @vercel/nft TRACE of the COMPILED api entries — the same tracer Vercel
//      uses to decide what enters the function bundle. Sees what the source walk
//      cannot: what the DEPENDENCIES drag in. Fails if any traced file is an
//      engine file, lives in a denylisted package, or is a .wasm.
//
// Usage: node scripts/check-hosted-isolation.mjs [--self-test]
//   --self-test additionally proves BOTH checks FAIL on a deliberately poisoned
//   entry that imports the engine — a guard that cannot fail is not a guard.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The engine directory, hardcoded and always compared WITH its trailing
 * separator. A bare "wallet-engine" substring would also match a sibling like
 * `src/wallet-engine-notes.ts`; the separator makes the match a real path
 * boundary.
 */
const ENGINE_DIR = join("src", "wallet-engine");
const ENGINE_PREFIX = ENGINE_DIR + sep;

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

/** Filename marker for the temporary poisoned fixtures the self-test writes. */
const SELF_TEST_MARKER = "zz-guard-self-test";

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
    if (rel.startsWith(ENGINE_PREFIX)) {
      violations.push(`wallet engine reachable: ${rel}\n        via ${[...via, rel].join("\n         -> ")}`);
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

/**
 * Every entry file under `dir`, at ANY depth.
 *
 * RECURSIVE ON PURPOSE. A non-recursive readdir only saw the top level, so an
 * entry one directory down — `api/v2/rogue.ts`, a perfectly ordinary Vercel
 * route — was never discovered and a file importing the wallet engine from there
 * passed BOTH checks silently. The guard's blind spot was the guard's own file
 * discovery, not its analysis.
 */
function listEntries(dir, extension) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((f) => (typeof f === "string" ? f : String(f)))
    .filter((f) => f.endsWith(extension))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .sort();
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
  const entries = listEntries(join(GUARD_OUT, "api"), ".js").filter(entryFilter);
  const { fileList, warnings } = await nodeFileTrace(entries, { base: repoRoot, processCwd: repoRoot });
  const traced = [...fileList];
  const violations = traced.filter((f) => {
    const norm = f.split("/").join(sep);
    if (norm.includes(ENGINE_PREFIX)) return true;
    if (norm.endsWith(".wasm")) return true;
    return DENIED_PACKAGES.some((p) => norm.includes(join("node_modules", ...p.split("/")) + sep));
  });
  return { entries, traced, violations, warnings };
}

// ── run ──────────────────────────────────────────────────────────────────────

const apiEntries = listEntries(join(repoRoot, "api"), ".ts");

const graph = walkSourceGraph(apiEntries);
if (graph.violations.length > 0) failures.push(`A. import-graph walk from api/*.ts:\n      - ${graph.violations.join("\n      - ")}`);
console.log(
  `[guard] A. import-graph walk: ${apiEntries.length} hosted entries, ${graph.visited.size} source files reached, ` +
    `${graph.violations.length} violations.`,
);

// The poisoned self-test entries are written BEFORE the compile so one tsc run
// covers both the real check and the self-test trace.
//
// TWO fixtures, and the NESTED one is the important half: the flat case passed
// from day one while a file at api/v2/ was never even discovered, so a self-test
// that only checked the top level certified a guard with a hole in it.
const poisonedFixtures = selfTest
  ? [
      { file: join(repoRoot, "api", `${SELF_TEST_MARKER}-flat-${process.pid}.ts`), up: ".." },
      { file: join(repoRoot, "api", "v2", `${SELF_TEST_MARKER}-nested-${process.pid}.ts`), up: "../.." },
    ]
  : [];
for (const { file, up } of poisonedFixtures) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    "// TEMPORARY self-test fixture — written and deleted by scripts/check-hosted-isolation.mjs.\n" +
      `import { WALLET_TOOL_NAMES } from "${up}/src/wallet-engine/mcp/server.js";\n` +
      "export default WALLET_TOOL_NAMES;\n",
  );
}

try {
  compileForTrace();
  const real = await traceCompiled((f) => !f.includes(SELF_TEST_MARKER));
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

  if (poisonedFixtures.length > 0) {
    // Check A must DISCOVER the fixtures itself (not be handed them): discovery
    // is exactly where the hole was. Re-listing api/ has to return both.
    const discovered = listEntries(join(repoRoot, "api"), ".ts").filter((f) => f.includes(SELF_TEST_MARKER));
    if (discovered.length !== poisonedFixtures.length) {
      failures.push(
        `SELF-TEST A: entry discovery found ${discovered.length} of ${poisonedFixtures.length} poisoned fixtures — ` +
          "a hosted entry in a subdirectory is invisible to the guard.",
      );
    }
    // One walk PER fixture: a single shared walk marks the engine file visited
    // on the first hit and reports nothing for the second, which would look like
    // the nested case escaping. Each entry must be proven caught on its own.
    const caught = discovered.filter((entry) => walkSourceGraph([entry]).violations.length > 0);
    if (caught.length < discovered.length) {
      failures.push(
        `SELF-TEST A: the import-graph walk flagged ${caught.length} of ${discovered.length} ` +
          "entries importing the wallet engine — the guard is broken.",
      );
    }
    const traceSelfTest = await traceCompiled((f) => f.includes(SELF_TEST_MARKER));
    if (traceSelfTest.entries.length !== poisonedFixtures.length) {
      failures.push(
        `SELF-TEST B: the trace discovered ${traceSelfTest.entries.length} of ${poisonedFixtures.length} compiled ` +
          "poisoned entries — nested hosted entries are not being traced.",
      );
    }
    if (traceSelfTest.violations.length === 0) {
      failures.push("SELF-TEST B: the @vercel/nft trace did NOT flag a compiled entry importing the wallet engine — the guard is broken.");
    }
    console.log(
      `[guard] self-test: ${discovered.length}/${poisonedFixtures.length} poisoned entries discovered (flat + nested), ` +
        `rejected by A (${caught.length}/${discovered.length}) and by B (${traceSelfTest.violations.length} violation(s)).`,
    );
  }
} catch (err) {
  failures.push(`B. @vercel/nft trace could not run: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const { file } of poisonedFixtures) rmSync(file, { force: true });
  // Remove api/v2/ too, but only if the fixture left it empty — a real nested
  // route directory must survive the self-test untouched.
  const nestedDir = join(repoRoot, "api", "v2");
  if (existsSync(nestedDir) && readdirSync(nestedDir).length === 0) rmSync(nestedDir, { recursive: true, force: true });
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
console.log("[guard] OK — the hosted entries reach neither src/wallet-engine nor any wallet-engine package.");
