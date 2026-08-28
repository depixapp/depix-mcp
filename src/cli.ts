// argv dispatch for the single bin (unified-MCP spec §1.5).
//
// ONE bin, `depix-mcp`, with two human subcommands: `init` and `backup`. A second
// bin would break the registry's `packages[]` auto-`npx` assumption (§4), so both
// ceremonies are reached through argv instead.
//
// Everything here is pure and injectable: the bin (src/stdio.ts) supplies the real
// `serve` / `init` / `backup` implementations, which is what makes the dispatch
// testable without ever running a ceremony or opening a transport. This module must
// NOT import the wallet engine — the ceremonies arrive as callbacks, so the engine
// is loaded only on the paths that actually need it.

export interface CliDeps {
  /** Run the first-run ceremony (TTY-only; the engine refuses otherwise). */
  init(opts: { restore: boolean }): Promise<void>;
  /** Re-display this wallet's 12 words (TTY-only; the engine refuses otherwise). */
  backup(): Promise<void>;
  /** Serve the unified MCP over stdio. Resolves only when the server shuts down. */
  serve(): Promise<void>;
  /** Human output. STDOUT is the JSON-RPC channel, so this MUST be stderr. */
  write(text: string): void;
  /** Version string for `--version`. */
  version: string;
}

export const USAGE = `depix-mcp — the DePix App MCP server (one MCP, two levels of access)

USAGE
  npx -y @depixapp/mcp              serve the MCP over stdio (59 tools)
  npx -y @depixapp/mcp init         first run: create or restore the local wallet
  npx -y @depixapp/mcp init --restore
                                    import an existing 12-word mnemonic
  npx -y @depixapp/mcp backup       show this wallet's 12 words again
                                    (human ceremony at a real terminal)
  npx -y @depixapp/mcp --help       this text
  npx -y @depixapp/mcp --version    print the server version

ENVIRONMENT
  DEPIX_API_KEY             sk_test_… / sk_live_… — the 26 gateway tools
  DEPIX_WALLET_PASSPHRASE   unlocks the local wallet — the 29 wallet_* tools
  DEPIX_WALLET_DIR          wallet directory (default ~/.depix-wallet)

NOTES
  All 59 tools are always listed. Without a wallet, wallet_* tools return the typed
  wallet_not_configured error naming \`init\`; without an API key, the API-backed
  tools return missing_api_key. Neither is a startup failure.

  \`init\` and \`backup\` are HUMAN ceremonies at a real terminal — they print a
  12-word seed backup and therefore refuse to run non-interactively. Showing a
  mnemonic is deliberately NOT an MCP tool: it must never transit model context
  or conversation logs. \`backup\` asks for your passphrase every time, even on a
  machine that unlocks the wallet by itself, and wipes the screen afterwards.
`;

/**
 * Dispatch argv. Returns the process exit code; never calls process.exit itself.
 * `serve` resolving means a clean shutdown, so it maps to 0.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [first, ...rest] = argv;

  if (first === "init") {
    const unknown = rest.filter((a) => a !== "--restore");
    if (unknown.length > 0) {
      deps.write(`depix-mcp: unknown option(s) for \`init\`: ${unknown.join(" ")}\n\n${USAGE}`);
      return 1;
    }
    await deps.init({ restore: rest.includes("--restore") });
    return 0;
  }

  // No options at all: `backup` acts on the one wallet in DEPIX_WALLET_DIR, and
  // guessing at an unrecognized flag (`--restore`, a path) would be guessing at
  // WHICH wallet's words to print.
  if (first === "backup") {
    if (rest.length > 0) {
      deps.write(`depix-mcp: \`backup\` takes no options: ${rest.join(" ")}\n\n${USAGE}`);
      return 1;
    }
    await deps.backup();
    return 0;
  }

  if (first === "--help" || first === "-h" || first === "help") {
    deps.write(USAGE);
    return 0;
  }

  if (first === "--version" || first === "-v") {
    deps.write(`${deps.version}\n`);
    return 0;
  }

  // A bare, unrecognized argument is a typo (`ini`, `start`, `--resore`), not a
  // reason to silently serve: an operator who meant `init` would otherwise get a
  // JSON-RPC server on a terminal and no explanation.
  if (first !== undefined) {
    deps.write(`depix-mcp: unknown command \`${first}\`.\n\n${USAGE}`);
    return 1;
  }

  await deps.serve();
  return 0;
}
