// Post-`tsc` step for the wallet engine (unified-MCP spec §2.1).
//
// SideShift affiliate id — the engine reads process.env.SIDESHIFT_AFFILIATE_ID at
// import time; baking it into the compiled module means the published package
// performs no runtime env read. The bake happens ONLY when the env is set and
// non-empty: baking an empty string would DELETE the runtime env read and leave
// wallet_shift_usdt permanently broken for an operator who does set the variable.
// So: env set -> bake (publish builds), env unset -> leave the runtime read
// (dev + npx builds).
//
// This script does NOT emit any package.json into dist/. It used to write one for
// the engine's version.ts to find; that lookup now walks up to this package's own
// manifest, and a manifest at dist/ would be a second, root-level one that Node
// honours for the whole built tree.

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repoRoot, "dist");
if (!existsSync(dist)) {
  console.error("[postbuild] dist/ not found — run `tsc -p tsconfig.build.json` first (npm run build does).");
  process.exit(1);
}

const affiliate = process.env.SIDESHIFT_AFFILIATE_ID;
const affiliateTarget = join(dist, "wallet-engine", "convert", "sideshift-affiliate.js");
if (affiliate && affiliate.length > 0) {
  if (!existsSync(affiliateTarget)) {
    console.error(`[postbuild] ${affiliateTarget} not found — the wallet engine did not compile.`);
    process.exit(1);
  }
  writeFileSync(affiliateTarget, `export const SIDESHIFT_AFFILIATE_ID = ${JSON.stringify(affiliate)};\n`);
  console.log("[postbuild] baked SIDESHIFT_AFFILIATE_ID into the compiled engine.");
} else {
  console.log("[postbuild] SIDESHIFT_AFFILIATE_ID unset — the compiled engine keeps its runtime env read.");
}
