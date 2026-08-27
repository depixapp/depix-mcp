/*
 * Copyright 2026 DePix App
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at http://www.apache.org/licenses/LICENSE-2.0 — see LICENSE.
 *
 * VENDORED ENGINE SOURCE — DO NOT EDIT HERE.
 * Origin:    https://github.com/depixapp/depix-sdk
 * Commit:    88228a10ca5fa275d64de9b3150bc75cc6a0bb8c
 * Path:      src/convert/sideshift-affiliate.ts
 * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)
 *
 * DePix App owns this code and distributes THIS copy under Apache-2.0. The
 * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing
 * from that published tarball is reused here (spec §2.2).
 */
// SideShift affiliate id — BAKED AT BUILD TIME (spec §5.4, GT §4.C).
//
// This mirrors the frontend's build-time `define` (wallet/sideshift.js:37 +
// scripts/build.mjs): the affiliate id is the DePix affiliate id (PUBLIC — it
// appears in every SideShift request and the frontend hardcodes it too — but NOT
// committed to git; it lives in the publish environment). The committed source
// below reads `process.env.SIDESHIFT_AFFILIATE_ID`, which is what dev + tests use
// (`SIDESHIFT_AFFILIATE_ID=test-affiliate`, wired in package.json). The PUBLISHED
// package does NOT read the env at runtime: `scripts/bake-affiliate.mjs` runs
// after `tsc` and overwrites the COMPILED `dist/convert/sideshift-affiliate.js`
// with the literal, exactly like esbuild's `define` substitutes it in the browser
// bundle. `scripts/check-affiliate-env.mjs` (wired into `prepublishOnly`) FAILS
// `npm publish` when the env is unset, so a release can never ship without it
// (mirror of build.mjs's FATAL). See the README "Publishing" section.
//
// Isolated in its own tiny module so the bake step can replace the whole file
// deterministically rather than surgically editing a line of compiled output.
export const SIDESHIFT_AFFILIATE_ID: string = process.env.SIDESHIFT_AFFILIATE_ID ?? "";
