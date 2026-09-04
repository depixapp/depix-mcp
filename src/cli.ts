// argv dispatch for the single bin (unified-MCP spec §1.5).
//
// ONE bin, `depix-mcp`, with five human subcommands: `init`, `backup`, `login`,
// `logout` and `account`. A second bin would break the registry's `packages[]`
// auto-`npx` assumption (§4), so all of them are reached through argv instead.
//
// WHY THESE ARE COMMANDS AND NOT TOOLS. `init` and `backup` print a 12-word seed,
// which must never transit model context. `login`, `logout` and `account use`
// decide WHICH HUMAN OR ACCOUNT the server acts as — an agent that could call
// them could promote itself from its own sandbox account to the operator's real
// one. Both kinds are operator acts at a terminal, by construction.
//
// Everything here is pure and injectable: the bin (src/stdio.ts) supplies the
// real implementations, which is what makes the dispatch testable without ever
// running a ceremony, binding a socket or opening a transport. This module must
// NOT import the wallet engine — the handlers arrive as callbacks, so the engine
// is loaded only on the paths that actually need it.

const PROVIDER_ARGS = ["google", "github"] as const;

export interface CliDeps {
  /** Run the first-run ceremony (TTY-only; the engine refuses otherwise). */
  init(opts: { restore: boolean }): Promise<void>;
  /** Re-display this wallet's 12 words (TTY-only; the engine refuses otherwise). */
  backup(): Promise<void>;
  /** Sign the OPERATOR in with Google/GitHub and store the session encrypted. */
  login(opts: { provider?: "google" | "github" }): Promise<number>;
  /** Remove the operator's stored session. */
  logout(): Promise<number>;
  /** `account status` / `account use <persona>`. Receives the remaining argv. */
  account(argv: readonly string[]): Promise<number>;
  /** Serve the unified MCP over stdio. Resolves only when the server shuts down. */
  serve(): Promise<void>;
  /** Human output. STDOUT is the JSON-RPC channel, so this MUST be stderr. */
  write(text: string): void;
  /** Version string for `--version`. */
  version: string;
}

export const USAGE = `depix-mcp — the DePix App MCP server (one MCP, two levels of access)

USAGE
  npx -y @depixapp/mcp              serve the MCP over stdio (62 tools)
  npx -y @depixapp/mcp init         first run: create or restore the local wallet
  npx -y @depixapp/mcp init --restore
                                    import an existing 12-word mnemonic
  npx -y @depixapp/mcp backup       show this wallet's 12 words again
                                    (human ceremony at a real terminal)
  npx -y @depixapp/mcp login        sign in with your own DePix account (Google/GitHub)
  npx -y @depixapp/mcp login --provider google|github
                                    skip the chooser and go straight to one of them
  npx -y @depixapp/mcp logout       remove that login from this machine
  npx -y @depixapp/mcp account status
                                    which account this server acts as, and why
  npx -y @depixapp/mcp account use agent|owner
                                    choose which one it acts as
  npx -y @depixapp/mcp --help       this text
  npx -y @depixapp/mcp --version    print the server version

ENVIRONMENT
  DEPIX_API_KEY             sk_test_… / sk_live_… — the 26 gateway tools
  DEPIX_WALLET_PASSPHRASE   unlocks the local wallet — the 29 wallet_* tools, and
                            seals the stored API keys and the \`login\` session
  DEPIX_AGENT_PASSPHRASE    optional; when set it WINS over DEPIX_WALLET_PASSPHRASE
                            for those stored credentials (the wallet still uses
                            DEPIX_WALLET_PASSPHRASE)
  DEPIX_WALLET_DIR          wallet directory (default ~/.depix-wallet)

WHICH ACCOUNT ACTS
  DEPIX_API_KEY  >  an explicit \`account use\`  >  the agent's own account  >  your login
  \`account status\` always prints the winner and the reason. \`login\` says so too.

NOTES
  All 62 tools are always listed. Without a wallet, wallet_* tools return the typed
  wallet_not_configured error naming \`init\`; without an API key, the API-backed
  tools return missing_api_key. Neither is a startup failure.

  \`init\` and \`backup\` are HUMAN ceremonies at a real terminal — they print a
  12-word seed backup and therefore refuse to run non-interactively. Showing a
  mnemonic is deliberately NOT an MCP tool: it must never transit model context
  or conversation logs. \`backup\` asks for your passphrase every time, even on a
  machine that unlocks the wallet by itself, and wipes the screen afterwards.

  \`login\`, \`logout\` and \`account use\` are not MCP tools either: choosing which
  human the server acts as must stay an operator act at a terminal, so no agent
  can promote itself to the owner's account.

  \`login\` opens a browser and waits on http://127.0.0.1:47617/callback — this
  machine, not a remote one. On a headless host, use DEPIX_API_KEY instead.
`;

function unknownOptions(rest: readonly string[], allowed: readonly string[]): string[] {
  return rest.filter((a) => !allowed.includes(a));
}

/**
 * Dispatch argv. Returns the process exit code; never calls process.exit itself.
 * `serve` resolving means a clean shutdown, so it maps to 0.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [first, ...rest] = argv;

  if (first === "init") {
    const unknown = unknownOptions(rest, ["--restore"]);
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

  if (first === "login") {
    const provider = readProvider(rest);
    if (provider === "invalid") {
      deps.write(
        `depix-mcp: \`login --provider\` takes ${PROVIDER_ARGS.join(" or ")}. Omit it to choose in the browser.\n\n${USAGE}`,
      );
      return 1;
    }
    return deps.login(provider === undefined ? {} : { provider });
  }

  if (first === "logout") {
    if (rest.length > 0) {
      deps.write(`depix-mcp: \`logout\` takes no options: ${rest.join(" ")}\n\n${USAGE}`);
      return 1;
    }
    return deps.logout();
  }

  if (first === "account") {
    return deps.account(rest);
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

/** undefined = let the browser ask; "invalid" = a value that is not a provider. */
function readProvider(rest: readonly string[]): "google" | "github" | undefined | "invalid" {
  if (rest.length === 0) return undefined;
  const [flag, value] = rest;
  if (flag !== "--provider" || rest.length !== 2) return "invalid";
  return (PROVIDER_ARGS as readonly string[]).includes(value ?? "")
    ? (value as "google" | "github")
    : "invalid";
}
