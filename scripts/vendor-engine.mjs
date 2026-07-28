// Vendor the DePix wallet ENGINE source into this package (unified-MCP spec §2.1/§2.2).
//
// WHY SOURCE, NOT A DEPENDENCY: the engine repo (`depix-sdk`) is owned by DePix App
// and goes private (spec §2.1/P5), so `@depixapp/mcp` cannot depend on it from npm.
// It is copied in at a PINNED commit and compiled by this package's own `tsc`.
//
// WHY NOT THE PUBLISHED TARBALL: `@depixapp/sdk` on npm is AGPL-3.0-only. This
// package is Apache-2.0. DePix App owns the engine, so it relicenses its OWN source
// on the way in — every vendored file gets the Apache-2.0 header below plus its
// provenance (repo + commit + original path). Repackaging the AGPL npm tarball
// verbatim would NOT be that (spec §2.2).
//
// WHY THE TREE IS COMMITTED: `npm ci` runs `prepare` -> `build`, so the sources must
// exist before any install step could fetch them; a clone + `npm ci` + `npm publish`
// has to emit the 49-tool dist with no network access to a (soon private) second
// repo. The reproducibility guarantee is restored by `--check`: CI checks out
// `depix-sdk` at the pinned commit, re-runs this script into a temp dir and fails on
// ANY byte of drift, so the committed tree is provably the pinned commit.
//
// USAGE
//   node scripts/vendor-engine.mjs [--from <path-to-depix-sdk-git-repo>] [--check]
//     --from   git repo to read the pinned commit from. Default: $DEPIX_SDK_REPO,
//              else ../../depix-sdk (the sibling clone), else ./.vendor-src.
//     --check  do not write: regenerate into memory and diff against the committed
//              tree. Exit 1 on any difference (CI reproducibility guard).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(repoRoot, "vendor", "engine.pin.json"), "utf8"));

const args = process.argv.slice(2);
const check = args.includes("--check");
const fromIdx = args.indexOf("--from");
const fromArg = fromIdx >= 0 ? args[fromIdx + 1] : undefined;

const candidates = [
  fromArg,
  process.env.DEPIX_SDK_REPO,
  resolve(repoRoot, "..", "..", "..", "depix-sdk"), // .claude/worktrees/<wt> -> siblings of depix-mcp
  resolve(repoRoot, "..", "depix-sdk"),
  resolve(repoRoot, ".vendor-src"),
].filter(Boolean);

const sourceRepo = candidates.find((p) => existsSync(join(p, ".git")) || existsSync(join(p, "HEAD")));
if (!sourceRepo) {
  console.error(
    `[vendor-engine] no depix-sdk git repo found. Tried:\n  ${candidates.join("\n  ")}\n` +
      "Pass --from <path> or set DEPIX_SDK_REPO.",
  );
  process.exit(1);
}

const git = (...a) => execFileSync("git", ["-C", sourceRepo, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Resolve the pin to a full SHA and REFUSE anything else: a short ref or a branch
// name would make the vendored tree a moving target.
let sha;
try {
  sha = git("rev-parse", `${pin.ref}^{commit}`).trim();
} catch {
  console.error(`[vendor-engine] commit ${pin.ref} not found in ${sourceRepo}. Run \`git fetch origin\` there first.`);
  process.exit(1);
}
if (sha !== pin.ref) {
  console.error(`[vendor-engine] vendor/engine.pin.json ref must be a full 40-char SHA (got ${pin.ref}, resolves to ${sha}).`);
  process.exit(1);
}

const targetAbs = join(repoRoot, pin.target);

/** The Apache-2.0 relicensing header + provenance stamped on every vendored file. */
function header(originalPath) {
  return [
    "/*",
    ` * ${pin.copyright}`,
    " *",
    ' * Licensed under the Apache License, Version 2.0 (the "License"); you may not',
    " * use this file except in compliance with the License. You may obtain a copy of",
    " * the License at http://www.apache.org/licenses/LICENSE-2.0 — see LICENSE.",
    " *",
    " * VENDORED ENGINE SOURCE — DO NOT EDIT HERE.",
    ` * Origin:    ${pin.repository}`,
    ` * Commit:    ${sha}`,
    ` * Path:      ${originalPath}`,
    " * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)",
    " *",
    " * DePix App owns this code and distributes THIS copy under Apache-2.0. The",
    " * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing",
    " * from that published tarball is reused here (spec §2.2).",
    " */",
    "",
  ].join("\n");
}

// Everything under `sourceDir` at the pinned commit, in tree order.
const files = git("ls-tree", "-r", "--name-only", sha, "--", `${pin.sourceDir}/`)
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .sort();

if (files.length === 0) {
  console.error(`[vendor-engine] the pinned commit has no files under ${pin.sourceDir}/ — refusing to empty the vendor tree.`);
  process.exit(1);
}

const generated = new Map();
for (const path of files) {
  const rel = path.slice(pin.sourceDir.length + 1); // strip "src/"
  const body = execFileSync("git", ["-C", sourceRepo, "show", `${sha}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // A shebang is only a shebang on line 1 (TS18026), so the header goes AFTER it.
  if (body.startsWith("#!")) {
    const nl = body.indexOf("\n");
    generated.set(rel, body.slice(0, nl + 1) + header(path) + body.slice(nl + 1));
  } else {
    generated.set(rel, header(path) + body);
  }
}
// A machine-readable stamp inside the tree, so the vendored copy self-identifies
// even when it is read outside this repo (npm tarball, a vendored-code audit).
generated.set(
  "VENDOR_PIN.json",
  JSON.stringify({ repository: pin.repository, commit: sha, sourceDir: pin.sourceDir, license: pin.license, files: files.length }, null, 2) + "\n",
);

function listCommitted(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) listCommitted(abs, base, out);
    else out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

if (check) {
  const committed = new Set(listCommitted(targetAbs));
  const problems = [];
  for (const [rel, content] of generated) {
    if (!committed.has(rel)) problems.push(`missing in the committed tree: ${rel}`);
    else if (readFileSync(join(targetAbs, rel), "utf8") !== content) problems.push(`content differs from the pinned commit: ${rel}`);
    committed.delete(rel);
  }
  for (const rel of committed) problems.push(`extra file not produced by the pin: ${rel}`);
  if (problems.length > 0) {
    console.error(
      `[vendor-engine] FAIL — ${pin.target} does not match ${pin.repository}@${sha.slice(0, 12)}:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\nRun `npm run vendor:engine` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`[vendor-engine] OK — ${generated.size} files match ${pin.repository}@${sha.slice(0, 12)}.`);
  process.exit(0);
}

rmSync(targetAbs, { recursive: true, force: true });
for (const [rel, content] of generated) {
  const abs = join(targetAbs, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
console.log(`[vendor-engine] wrote ${generated.size} files to ${pin.target} from ${pin.repository}@${sha.slice(0, 12)}.`);
