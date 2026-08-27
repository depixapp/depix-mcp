// Version identity for wallet.diagnostics() (PR-D). Read once from the package
// manifest that OWNS this file. The lwk version is the EXACT dependency pin
// (deps are pinned exact in this repo), read from the manifest rather than
// lwk_node's package.json because lwk_node's `exports` map does not expose its
// manifest as a subpath.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
}

/**
 * Walk up to the nearest NAMED package.json rather than counting directories.
 *
 * A fixed `../package.json` is a hostage to layout: this module lives at a
 * different depth in the checkout (src/wallet-engine/) than in the build
 * (dist/wallet-engine/), and the depth that resolves in one lands on a
 * non-existent path — or worse, on a stray manifest — in the other. The `name`
 * check is what rejects such a stray: a manifest emitted next to build output
 * has no name, and only the real package root does.
 */
function readManifest(): PackageManifest {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, "utf8")) as PackageManifest;
        if (typeof manifest.name === "string") return manifest;
      } catch {
        // Diagnostics must never crash the wallet over a packaging anomaly.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

const manifest = readManifest();

/** The owning package's version (package.json `version`), or "unknown". */
export const SDK_VERSION: string =
  typeof manifest.version === "string" ? manifest.version : "unknown";

/** The exact pinned lwk_node version this build ships, or "unknown". */
export const LWK_VERSION: string =
  typeof manifest.dependencies?.lwk_node === "string"
    ? manifest.dependencies.lwk_node
    : "unknown";
