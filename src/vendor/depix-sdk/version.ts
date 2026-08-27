/*
 * Copyright 2026 DePix App
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at http://www.apache.org/licenses/LICENSE-2.0 — see LICENSE.
 *
 * VENDORED ENGINE SOURCE — DO NOT EDIT HERE.
 * Origin:    https://github.com/depixapp/depix-sdk
 * Commit:    c8abc2ca4fbf913591cfe0696793fc9d1cfb4a3d
 * Path:      src/version.ts
 * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)
 *
 * DePix App owns this code and distributes THIS copy under Apache-2.0. The
 * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing
 * from that published tarball is reused here (spec §2.2).
 */
// Version identity for wallet.diagnostics() (PR-D). Read once from this
// package's own manifest — the file sits one level above both src/ (vitest)
// and dist/ (published build), so the same relative lookup works in both.
// The lwk version is the EXACT dependency pin (deps are pinned exact in this
// repo), read from the manifest rather than lwk_node's package.json because
// lwk_node's `exports` map does not expose its manifest as a subpath.

import { createRequire } from "node:module";

interface PackageManifest {
  version?: unknown;
  dependencies?: Record<string, unknown>;
}

function readManifest(): PackageManifest {
  try {
    return createRequire(import.meta.url)("../package.json") as PackageManifest;
  } catch {
    // Diagnostics must never crash the wallet over a packaging anomaly.
    return {};
  }
}

const manifest = readManifest();

/** This SDK's own version (package.json `version`), or "unknown". */
export const SDK_VERSION: string =
  typeof manifest.version === "string" ? manifest.version : "unknown";

/** The exact pinned lwk_node version this build ships, or "unknown". */
export const LWK_VERSION: string =
  typeof manifest.dependencies?.lwk_node === "string"
    ? manifest.dependencies.lwk_node
    : "unknown";
