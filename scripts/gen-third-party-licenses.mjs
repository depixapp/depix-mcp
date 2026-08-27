// Generate THIRD_PARTY_LICENSES from the PRODUCTION dependency tree (spec §2.2).
//
// WHY THIS EXISTS: `@depixapp/mcp` now ships the wallet engine, whose ~11 runtime
// dependencies (lwk_node, boltz-core, boltz-swaps, liquidjs-lib, @noble/*,
// @scure/base, @vulpemventures/secp256k1-zkp, hash-wasm, viem, and the MCP SDK)
// are MIT/BSD/Apache. Every one of those licenses requires the copyright notice and
// permission text to travel with copies, and an npm install of this package IS a
// copy. NOTICE alone does not discharge that; a generated inventory with the actual
// license texts does.
//
// It reads the tree `npm ls --omit=dev --all --long` reports, so it covers TRANSITIVE
// deps too, and takes the license TEXT from each package's own LICENSE file (falling
// back to the SPDX id in its package.json when a package ships none). See readTree()
// for the two traps in that JSON — deduped STUB nodes and duplicate versions — that
// silently shrank this inventory to a quarter of the real closure.
//
// Usage:
//   node scripts/gen-third-party-licenses.mjs           write THIRD_PARTY_LICENSES
//   node scripts/gen-third-party-licenses.mjs --check    fail if it is out of date

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const OUTPUT = join(repoRoot, "THIRD_PARTY_LICENSES");
const check = process.argv.includes("--check");

/**
 * Facts a license scanner gets WRONG about a dependency, stated explicitly so the
 * inventory is more accurate than the metadata it is generated from.
 */
const ANNOTATIONS = {
  "boltz-core":
    "NOTE: this package's package.json declares `AGPL-3.0`, but the LICENSE file it actually\n" +
    "ships (reproduced below) is MIT. Upstream confirmed the metadata is the bug and merged the\n" +
    "fix in BoltzExchange/boltz-core#194; at the time of this build NO release carrying that fix\n" +
    "exists on npm (latest is 5.0.0, the version pinned here). License scanners will flag this\n" +
    "package until the first post-#194 release ships and the pin is bumped. The governing terms\n" +
    "are the ones in the LICENSE file below.",
};

const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING|NOTICE)([-.].*)?$/i;

function readTree() {
  // `npm ls` exits non-zero (ELSPROBLEMS) on ANY tree advisory — extraneous
  // packages, an unmet optional peer, a version quibble. The JSON on stdout is
  // complete and correct either way, so the exit code is not trusted as a gate:
  // this file must be generated from the real tree even when npm has an opinion
  // about it.
  let raw;
  try {
    // `--long` is load-bearing, not cosmetic: it is what puts `path` on every
    // node. Without it two copies of the same package (boltz-core 4.x and 5.x)
    // are indistinguishable and the inventory reads whichever one happens to sit
    // at the root of node_modules — i.e. it can attribute the WRONG license text
    // to a version that ships.
    raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--long", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    raw = typeof err?.stdout === "string" ? err.stdout : "";
    if (raw.length === 0) throw err;
  }
  const tree = JSON.parse(raw);
  const found = new Map();

  // ALWAYS descend, and dedupe only for OUTPUT.
  //
  // npm emits a deduped node the first time it can and a bare STUB elsewhere —
  // and the stub is not guaranteed to come second. Proven here:
  // `boltz-core.dependencies["liquidjs-lib"]` is a stub with no `dependencies`,
  // while the expanded `liquidjs-lib` node has 13 children. Descending only on
  // first sight of a key let the stub claim it and silently dropped every
  // transitive dependency underneath — the inventory reported 44 packages when
  // the real closure is 172, and THIS FILE SHIPS IMMUTABLY in the tarball.
  //
  // npm's JSON is a finite tree (it never re-expands a cycle), so descending on
  // every edge terminates; the depth cap is a belt-and-braces guard only.
  const MAX_DEPTH = 64;
  (function walk(deps, depth) {
    if (depth > MAX_DEPTH) return;
    for (const [name, node] of Object.entries(deps ?? {})) {
      // Skip what is LISTED but not INSTALLED: boltz-swaps declares a long tail of
      // optional peers (@solana/*, tronweb, @metaplex-foundation/*, …) that npm
      // reports as unmet entries with no resolved version. They never enter the
      // install closure, and inventorying them would be a false claim about what
      // this package distributes.
      if (typeof node.version === "string" && node.missing !== true) {
        const key = `${name}@${node.version}`;
        // Keep the FIRST node that carries a real path: a stub may have none.
        const existing = found.get(key);
        if (existing === undefined) found.set(key, { name, version: node.version, path: node.path });
        else if (!existing.path && node.path) existing.path = node.path;
      }
      walk(node.dependencies, depth + 1);
    }
  })(tree.dependencies, 0);

  return [...found.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

/**
 * The directory a specific tree node actually resolves to. `node.path` (from
 * `--long`) is authoritative — with two copies of a package installed, the root
 * `node_modules/<name>` is only ONE of them, and guessing picks the wrong
 * license text half the time.
 */
function packageDir(name, nodePath) {
  if (typeof nodePath === "string" && existsSync(nodePath)) return nodePath;
  const dir = join(repoRoot, "node_modules", ...name.split("/"));
  return existsSync(dir) ? dir : null;
}

function licenseTextOf(dir) {
  const files = readdirSync(dir).filter((f) => LICENSE_FILE_RE.test(f));
  if (files.length === 0) return null;
  // Deterministic order so regeneration is byte-stable.
  return files
    .sort()
    .map((f) => `--- ${f} ---\n${readFileSync(join(dir, f), "utf8").trimEnd()}`)
    .join("\n\n");
}

function spdxOf(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (typeof manifest.license === "string") return manifest.license;
    if (manifest.license?.type) return manifest.license.type;
    if (Array.isArray(manifest.licenses)) return manifest.licenses.map((l) => l.type ?? l).join(" OR ");
  } catch {
    /* fall through */
  }
  return "UNKNOWN";
}

const deps = readTree();
const missing = [];
const sections = [];

for (const { name, version, path: nodePath } of deps) {
  const dir = packageDir(name, nodePath);
  if (dir === null) {
    missing.push(`${name}@${version} (not installed — run \`npm ci\` before generating)`);
    continue;
  }
  const spdx = spdxOf(dir);
  const text = licenseTextOf(dir);
  if (text === null) missing.push(`${name}@${version} (declares ${spdx} but ships no LICENSE file)`);
  const annotation = ANNOTATIONS[name] ? `\n${ANNOTATIONS[name]}\n` : "";
  sections.push(
    `${"=".repeat(78)}\n${name}@${version}\nSPDX (declared in package.json): ${spdx}\n${annotation}${"=".repeat(78)}\n\n` +
      (text ?? `[This package ships no license file. Declared license: ${spdx}.]`),
  );
}

// The header deliberately does NOT carry this package's own version.
//
// It used to (`${pkg.name}@${pkg.version}`), which coupled a THIRD-PARTY inventory
// to OUR release number: every version bump changed one line, `licenses:check`
// went red, and — because that check is a release gate — the tag failed to
// publish for a reason with nothing to do with licensing. That is exactly what
// happened on v2.0.1. The file now changes if and only if the DEPENDENCY TREE
// changes, which is the only thing it actually documents. The version it belongs
// to is not lost: this file ships inside a versioned tarball, and git history has
// the rest.
const header = `THIRD-PARTY SOFTWARE NOTICES AND LICENSES
${pkg.name}

${pkg.name} is licensed under Apache-2.0 (see LICENSE / NOTICE). It CONTAINS the DePix
App wallet engine (src/wallet-engine/, Apache-2.0 by its owner) and INSTALLS the
third-party packages inventoried below. Their licenses require that their copyright
and permission notices travel with every copy — this file is that notice.

This inventory is VERSION-AGNOSTIC by design: it tracks the dependency tree, not
releases of ${pkg.name}, so it changes only when a dependency does.

Inventory: the ${deps.length} installed package${deps.length === 1 ? "" : "s"} of this package's PRODUCTION
dependency tree (\`npm ls --omit=dev --all --long\`), every transitive dependency included
and each entry read from the copy npm actually resolved (two versions of the same
package are listed separately). Unmet OPTIONAL peers that npm lists but never installs
are excluded — they are not distributed with this package.

GENERATED FILE — do not edit by hand. Regenerate with:
    npm run licenses
CI verifies it is current with:
    npm run licenses:check

`;

const content = `${header}${sections.join("\n\n")}\n`;

if (missing.length > 0) {
  console.warn(`[licenses] ${missing.length} package(s) need attention:\n  - ${missing.join("\n  - ")}`);
}

if (check) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
  if (current !== content) {
    console.error(
      "[licenses] FAIL — THIRD_PARTY_LICENSES is out of date with the production dependency tree.\n" +
        "Run `npm run licenses` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`[licenses] OK — THIRD_PARTY_LICENSES covers all ${deps.length} production packages.`);
  process.exit(0);
}

writeFileSync(OUTPUT, content);
console.log(`[licenses] wrote THIRD_PARTY_LICENSES (${deps.length} packages, ${Math.round(content.length / 1024)} KB).`);
