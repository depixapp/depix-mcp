// First-run ceremony for the local wallet — the engine half of `init`
// (unified-MCP spec §1.5 / §3.7). The unified bin (`npx -y @depixapp/mcp init`)
// parses argv and calls runWalletInit(); this module owns everything human.
//
// The v2 rite (§3.7): the passphrase never lands in a host config (an OS-keychain
// unlock key does, §3.7 #8); the backup challenge runs AFTER the screen is
// cleared, so re-typing proves paper (§3.7 #2); spending limits + an allowlist
// are a step, not a surprise-at-first-failure (§3.7 #1); the host is registered
// for the operator, no JSON pasted by hand (§3.7 #6); and there is NO API key in
// the rite — the agent opens its own account with register_account (§3.7 #3).
//
// INVARIANTS (each one is a rule, not a preference):
//   1. NEVER an MCP tool. Seed creation is a human act at a terminal: as a tool
//      the 12 words would transit model context and conversation logs. The MCP
//      surface only ever gets the typed `wallet_not_configured` error pointing
//      here (mcp/errors.ts).
//   2. TTY-only. runWalletInit refuses when stdin or stdout is not a TTY. That
//      is a GUARD, not a proof — tmux/`script`/an agent harness all allocate
//      PTYs — so before the words appear the operator gets an abort warning and
//      must type `continue`; detected multiplexer/agent env markers are named in
//      that warning.
//   3. The passphrase is never echoed: prompts read with terminal echo
//      suppressed (raw-mode stdin, no dependency). It is NEVER written into a
//      config file or the printed block — the OS keychain holds the unlock key,
//      and the printed block carries only non-secret env. A generated passphrase
//      is displayed exactly once, in the same TTY, because the operator cannot
//      use a passphrase they were never shown.
//   4. The mnemonic goes to the ritual's own output path and nowhere else: not
//      logged, not returned, not written to disk by this module.
//   5. The wallet is CLOSED before returning — the dataDir lock is released, so
//      the MCP server the operator is about to start can open it.

import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CLEAR_SCREEN_AND_SCROLLBACK, runBackupRitual, type RitualIo, type RitualOptions } from "../backup-ritual.js";
import { WalletError } from "../errors.js";
import {
  DEFAULT_DAILY_LIMIT_BRL_CENTS,
  DEFAULT_PER_TX_LIMIT_BRL_CENTS,
  ENV_ALLOWLIST,
  ENV_DAILY,
  ENV_PER_TX,
} from "../guardrails/config.js";
import { registerSecret } from "../logger.js";
import { MIN_PASSPHRASE_LENGTH } from "../store/crypto.js";
import { SeedStore } from "../store/seed-store.js";
import {
  storeUnlockKey,
  type StoreUnlockResult,
  type UnlockBackend,
  type UnlockStoreDeps,
} from "../store/unlock-store.js";
import { DepixWallet, type CreateOptions, type OpenOptions, type RestoreOptions } from "../wallet.js";
import { DEFAULT_WALLET_INIT_COMMAND } from "./errors.js";
import {
  defaultHostDetectDeps,
  defaultHostRegisterEffects,
  detectHosts,
  registerWithHost,
  type HostDetectDeps,
  type HostRegisterEffects,
  type HostTarget,
  type McpServerSpec,
} from "./host-register.js";

/** Default npm package of the unified MCP — what the printed block runs. */
export const DEFAULT_MCP_PACKAGE = "@depixapp/mcp";
/** Default key of the printed `mcpServers` entry. */
export const DEFAULT_MCP_SERVER_KEY = "depix";
/** Where the human proves their identity to authorize the agent's account (§3.7 #4/#7). */
export const OPERATOR_OAUTH_START_URL = "https://api.depixapp.com/api/agents/oauth/start";
/** Attempts allowed on the passphrase / mnemonic / amount prompts before giving up. */
const MAX_PROMPT_ATTEMPTS = 3;

/**
 * Env vars whose presence means the terminal is multiplexed, remote or driven
 * by an agent harness — its scrollback may be persisted by another program.
 * NOT a refusal (tmux is a legitimate way to work): they are NAMED in the
 * pre-display warning so the operator can judge (§1.5 fix #6).
 */
const SHARED_TERMINAL_ENV_MARKERS = [
  "TMUX",
  "STY",
  "ZELLIJ",
  "SSH_TTY",
  "SSH_CONNECTION",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_TRACE_ID",
  "VSCODE_INJECTION",
] as const;

/** Terminal I/O for the ceremony: the ritual's trio plus an echo-free read. */
export interface WalletInitIo extends RitualIo {
  /** Read one line with terminal echo suppressed (passphrase, mnemonic). */
  secret(prompt: string): Promise<string>;
}

/** The subset of an OPEN wallet the ceremony touches. DepixWallet satisfies it. */
export interface InitWallet {
  isBackupConfirmed(): boolean;
  exportMnemonic(): Promise<string>;
  confirmBackup(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The wallet operations the ceremony drives. Defaults to DepixWallet + the
 * on-disk seed store; injected in tests so the flow is exercised without an LWK
 * engine or a real dataDir.
 */
export interface InitWalletBackend {
  /** Metadata of an existing wallet in `dataDir`, or null. Reads NO secret (no passphrase). */
  inspect(dataDir: string): Promise<{ backupConfirmed: boolean } | null>;
  create(options: CreateOptions): Promise<{ mnemonic: string; backupConfirmed: boolean; wallet: InitWallet }>;
  open(options: OpenOptions): Promise<InitWallet>;
  restore(options: RestoreOptions): Promise<InitWallet>;
}

/** The owner-set spending limits + allowlist gathered in the limits step (§3.7 #1). */
export interface WalletLimits {
  perTxBrlCents: number;
  dailyBrlCents: number;
  /** Liquid addresses the agent may send to. Empty = any address (the caps still apply). */
  allowlistLiquidAddresses: string[];
}

/** What the ceremony did. */
export type WalletInitAction =
  /** A new wallet was created (backupConfirmed says whether the ritual passed). */
  | "created"
  /** `--restore`: an existing mnemonic was imported (born backup-confirmed). */
  | "restored"
  /** A wallet was already there with its backup confirmed — the block was reprinted. */
  | "already_configured"
  /** A wallet was already there with an UNCONFIRMED backup; the ritual was re-run. */
  | "backup_ritual_rerun";

export interface WalletInitResult {
  action: WalletInitAction;
  dataDir: string;
  backupConfirmed: boolean;
  /**
   * The `mcpServers` block that was printed / registered. Safe to log/return: it
   * carries NO passphrase and NO API key — only the wallet dir, guardrail limits
   * and (if connected) the op_ operator token.
   */
  configBlock: string;
  /** The non-secret env the block/registration carries. */
  env: Record<string, string>;
  /** The limits the operator chose (null on a pure reprint). */
  limits: WalletLimits | null;
  /** Where the unlock key ended up (null on a pure reprint — nothing was stored). */
  unlock: StoreUnlockResult | null;
  /** Host ids the server was registered with (empty when it printed the block instead). */
  registeredHosts: string[];
  /** true when the operator pasted an op_ token during init. */
  operatorConnected: boolean;
}

export interface RunWalletInitOptions {
  /** `init --restore`: import an existing mnemonic instead of generating one. */
  restore?: boolean;
  /** Wallet dir. Default: $DEPIX_WALLET_DIR ?? ~/.depix-wallet (the wallet's own rule). */
  dataDir?: string;
  /** npm package printed in the block + named in the guidance. Default `@depixapp/mcp`. */
  packageName?: string;
  /** Key of the printed `mcpServers` entry. Default `depix`. */
  serverKey?: string;
  /** Terminal I/O. Default: a real TTY reader whose secret prompts do not echo. */
  io?: WalletInitIo;
  /** TTY detection override (tests). Default: process.stdin.isTTY && process.stdout.isTTY. */
  tty?: { stdin: boolean; stdout: boolean };
  /** Environment read for the dataDir default + the shared-terminal markers. */
  env?: Record<string, string | undefined>;
  /** Ritual knobs (deterministic positions/attempts in tests). */
  ritual?: RitualOptions;
  /** Wallet backend. Default: DepixWallet + SeedStore. */
  backend?: InitWalletBackend;
  /** Passphrase generator (tests). Default: 24 CSPRNG chars in 4 groups. */
  generatePassphrase?: () => string;
  /** Default limits offered at the limits step (tests). Default: R$100/tx + R$500/day. */
  limitsDefaults?: { perTxBrlCents: number; dailyBrlCents: number };
  /** OS-keychain backends for storing the unlock key (tests). Default: real store. */
  unlock?: Partial<UnlockStoreDeps>;
  /** MCP-host detection (tests). Default: real PATH/fs detection. */
  hostDetect?: HostDetectDeps;
  /** MCP-host registration effects (tests). Default: real spawn/fs. */
  hostEffects?: HostRegisterEffects;
}

// ── passphrase generation ────────────────────────────────────────────────────

// Look-alike-free alphabet (no 0/O/1/l/I): the operator transcribes this into a
// password manager. 56 symbols ≈ 5.8 bits/char → 24 chars ≈ 139 bits.
const PASSPHRASE_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GENERATED_PASSPHRASE_CHARS = 24;
const GENERATED_PASSPHRASE_GROUP = 6;

/**
 * A strong passphrase from the platform CSPRNG, grouped for transcription.
 * Rejection-sampled so every symbol is uniform (a plain modulo would bias the
 * first `256 % 56` symbols).
 */
export function generateStrongPassphrase(length = GENERATED_PASSPHRASE_CHARS): string {
  const alphabet = PASSPHRASE_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  const buf = new Uint8Array(1);
  const chars: string[] = [];
  while (chars.length < length) {
    globalThis.crypto.getRandomValues(buf);
    const byte = buf[0]!;
    if (byte >= limit) continue;
    chars.push(alphabet[byte % alphabet.length]!);
  }
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GENERATED_PASSPHRASE_GROUP) {
    groups.push(chars.slice(i, i + GENERATED_PASSPHRASE_GROUP).join(""));
  }
  return groups.join("-");
}

// ── the non-secret config block ──────────────────────────────────────────────

/**
 * Compose the non-secret env the block/registration installs (§3.7 #3/#8): the
 * wallet dir, the guardrail limits, an allowlist when the operator set one, and
 * the op_ operator token when they connected. NEVER the passphrase or an API key.
 */
export function buildServerEnv(opts: {
  dataDir: string;
  limits: WalletLimits;
  operatorToken?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    DEPIX_WALLET_DIR: opts.dataDir,
    [ENV_PER_TX]: String(opts.limits.perTxBrlCents),
    [ENV_DAILY]: String(opts.limits.dailyBrlCents),
  };
  if (opts.limits.allowlistLiquidAddresses.length > 0) {
    env[ENV_ALLOWLIST] = JSON.stringify({
      enabled: true,
      liquidAddresses: opts.limits.allowlistLiquidAddresses,
    });
  }
  if (opts.operatorToken !== undefined && opts.operatorToken !== "") {
    env.DEPIX_OPERATOR_TOKEN = opts.operatorToken;
  }
  return env;
}

/**
 * The `mcpServers` JSON the operator's host runs. Secrets are absent BY
 * CONSTRUCTION — this function only ever receives the non-secret env map.
 */
export function renderWalletMcpConfigBlock(opts: {
  packageName?: string;
  serverKey?: string;
  env: Record<string, string>;
}): string {
  const block = {
    mcpServers: {
      [opts.serverKey ?? DEFAULT_MCP_SERVER_KEY]: {
        command: "npx",
        args: ["-y", opts.packageName ?? DEFAULT_MCP_PACKAGE],
        env: opts.env,
      },
    },
  };
  return JSON.stringify(block, null, 2);
}

// ── default wiring ───────────────────────────────────────────────────────────

/** DepixWallet + the on-disk seed store — what the bin runs against. */
export const defaultInitWalletBackend: InitWalletBackend = {
  async inspect(dataDir: string): Promise<{ backupConfirmed: boolean } | null> {
    // Plaintext metadata only (the seed stays encrypted): tells apart "no
    // wallet" from "wallet with an unfinished ritual" WITHOUT a passphrase.
    const file = await new SeedStore(dataDir).read();
    return file ? { backupConfirmed: file.backupConfirmed === true } : null;
  },
  create: (options) => DepixWallet.create(options),
  open: (options) => DepixWallet.open(options),
  restore: (options) => DepixWallet.restore(options),
};

/** Real-terminal I/O: readline for prompts, raw-mode stdin for secrets, ANSI clear. */
export function createTtyInitIo(): WalletInitIo {
  return {
    write: (text: string) => {
      process.stdout.write(`${text}\n`);
    },
    question: async (prompt: string) => {
      // A fresh interface per prompt: a long-lived readline would fight the
      // raw-mode secret reader for stdin.
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    secret: (prompt: string) => readHiddenLine(prompt),
    clear: () => {
      process.stdout.write(CLEAR_SCREEN_AND_SCROLLBACK);
    },
  };
}

/**
 * Strip terminal escape sequences from raw-mode input.
 *
 * A per-character `ch < " "` filter is NOT enough: an arrow key sends
 * `ESC [ A` and only the ESC is a control character — the `[` and the `A` would
 * be appended to the secret, silently corrupting a passphrase the operator can
 * never reproduce. Bracketed paste is worse: it wraps a pasted mnemonic in
 * `ESC [200~ … ESC [201~`, so `[200~` would be prepended to the words. Full CSI
 * sequences go first, then any remaining two-character `ESC x` (SS3 arrows on
 * some terminals); a lone trailing ESC is dropped by the caller's control-char
 * filter. Exported for the unit test — this path has no PTY in CI.
 */
export function stripTerminalControlSequences(text: string): string {
  // CSI: ESC [ params intermediates final(@-~) — arrows, Home/End, bracketed
  // paste markers, mouse reports. Matching the ESC control character IS the
  // job here, so no-control-regex is disabled deliberately.
  /* eslint-disable no-control-regex -- matching the ESC control char IS the job */
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI: arrows, Home/End, bracketed paste, mouse
    .replace(/\u001bO[@-~]/g, "") // SS3: application-cursor arrows (ESC O A)
    .replace(/\u001b[@-~]/g, ""); // any other two-character ESC sequence
  /* eslint-enable no-control-regex */
}

/**
 * Read a line with NO echo — not even asterisks (a length leak in a shared
 * window). Raw-mode stdin, zero dependencies; the previous raw state is always
 * restored, including on Ctrl-C.
 *
 * Chunks are decoded through StringDecoder: raw mode delivers Buffers, and a
 * multi-byte codepoint (an accented character in a passphrase, or a paste split
 * by the tty buffer) can straddle two chunks — a per-chunk Buffer.toString()
 * would turn the halves into replacement characters.
 */
function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (typeof stdin.setRawMode !== "function") {
    return Promise.reject(
      new WalletError(
        "INIT_REQUIRES_TTY",
        "Cannot read a secret without a terminal (stdin is not a TTY). Run this command directly in a terminal.",
      ),
    );
  }
  return new Promise<string>((resolve, reject) => {
    stdout.write(prompt);
    const wasRaw = stdin.isRaw === true;
    const decoder = new StringDecoder("utf8");
    let value = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: Buffer | string): void => {
      const decoded = typeof chunk === "string" ? chunk : decoder.write(chunk);
      const text = stripTerminalControlSequences(decoded);
      for (const ch of text) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          reject(new WalletError("INIT_ABORTED", "Aborted at the prompt (Ctrl-C)."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        // Remaining control characters (a lone ESC, Tab, any Ctrl-<key>) are not
        // passphrase material; the escape SEQUENCES they lead were already
        // removed above, so nothing printable from them can survive here.
        if (ch < " ") continue;
        value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// ── the ceremony ─────────────────────────────────────────────────────────────

function normalize(answer: string): string {
  return answer.trim().toLowerCase();
}

/** The dir a ceremony acts on: the explicit option → $DEPIX_WALLET_DIR → ~/.depix-wallet. */
export function resolveCeremonyDataDir(explicit: string | undefined, env: Record<string, string | undefined>): string {
  return explicit ?? env.DEPIX_WALLET_DIR ?? join(homedir(), ".depix-wallet");
}

/** The shared/automated-terminal markers present in this environment. */
export function detectSharedTerminalMarkers(env: Record<string, string | undefined>): string[] {
  return SHARED_TERMINAL_ENV_MARKERS.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Run the first-run ceremony (spec §1.5/§3.7). Creates, restores, resumes an
 * unfinished ritual, or just reprints the config — decided by what is already in
 * the dataDir. Returns WITHOUT the mnemonic or the passphrase, ever.
 */
export async function runWalletInit(options: RunWalletInitOptions = {}): Promise<WalletInitResult> {
  const env = options.env ?? process.env;
  const dataDir = resolveCeremonyDataDir(options.dataDir, env);
  const packageName = options.packageName ?? DEFAULT_MCP_PACKAGE;
  const initCommand = packageName === DEFAULT_MCP_PACKAGE ? DEFAULT_WALLET_INIT_COMMAND : `npx -y ${packageName} init`;
  const backend = options.backend ?? defaultInitWalletBackend;
  const tty = options.tty ?? {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
  };

  // GUARD #1 — TTY only, on EVERY path (create, restore, resume, reprint). A
  // ceremony that can run head-less is a ceremony an agent can run.
  if (!tty.stdin || !tty.stdout) {
    throw new WalletError(
      "INIT_REQUIRES_TTY",
      `\`${initCommand}\` is an interactive ceremony and needs a real terminal — ` +
        `stdin is ${tty.stdin ? "a TTY" : "NOT a TTY"} and stdout is ${tty.stdout ? "a TTY" : "NOT a TTY"} here. ` +
        "Run it yourself in a terminal window (not piped, not redirected, not from an agent or CI job). " +
        "Headless bootstrap stays an SDK-level path: DepixWallet.create({ mnemonicSecured: true }) in your own " +
        "script, where YOU handle the mnemonic.",
    );
  }

  const io = options.io ?? createTtyInitIo();
  const existing = await backend.inspect(dataDir);

  io.write("");
  io.write("=== DePix wallet — first run ===");
  io.write(`Wallet dir: ${dataDir}`);
  io.write("Everything below happens on THIS machine. The seed is generated here, encrypted here, and never sent anywhere.");

  const common: FlowArgs = { io, backend, dataDir, packageName, options, initCommand };
  if (options.restore === true) {
    return restoreFlow({ ...common, env, existing: existing !== null });
  }
  if (existing === null) {
    return createFlow({ ...common, env });
  }
  if (existing.backupConfirmed) {
    // Second run, nothing to create (§1.5 fix #11): reprint, ZERO prompts. The
    // unlock key and limits were stored on the first run.
    return alreadyConfiguredFlow(common);
  }
  return resumeRitualFlow({ ...common, env });
}

interface FlowArgs {
  io: WalletInitIo;
  backend: InitWalletBackend;
  dataDir: string;
  packageName: string;
  options: RunWalletInitOptions;
  initCommand: string;
}

async function createFlow(args: FlowArgs & { env: Record<string, string | undefined> }): Promise<WalletInitResult> {
  const { io, backend, dataDir, options, env } = args;
  const { passphrase } = await promptNewPassphrase(io, options);

  // Warn + require an explicit "continue" BEFORE any seed is generated: an abort
  // here leaves the dataDir untouched.
  await confirmSeedDisplay(io, env);

  // The ritual is run HERE rather than inside create() (interactive: false): one
  // ritual code path for both first-run and the resumed-ritual case below, with
  // the injectable RitualIo/RitualOptions the tests need. create() still owns
  // seed generation, encryption and persistence.
  const created = await backend.create({ dataDir, passphrase, interactive: false });
  const wallet = created.wallet;
  let backupConfirmed = created.backupConfirmed;
  try {
    if (!backupConfirmed) {
      backupConfirmed = await runBackupRitual(created.mnemonic, io, options.ritual);
      if (backupConfirmed) await wallet.confirmBackup();
    }
  } finally {
    // Release the dataDir lock before the operator starts the MCP server (fix #20).
    await wallet.close();
  }

  // The 12 words were on screen: the end-of-flow cleanup will wipe them.
  return completeSetup({ ...args, passphrase, secretShown: true, backupConfirmed, action: "created" });
}

async function restoreFlow(
  args: FlowArgs & { env: Record<string, string | undefined>; existing: boolean },
): Promise<WalletInitResult> {
  const { io, backend, dataDir, options, existing } = args;
  io.write("");
  io.write("Restoring from an existing 12-word mnemonic. A restored wallet is born backup-confirmed —");
  io.write("typing the words IS the proof you have them.");
  if (existing) {
    io.write(
      "NOTE: a wallet already exists in this dir. Restoring re-encrypts it with the passphrase you type now; " +
        "a mnemonic for a DIFFERENT wallet is refused (DESCRIPTOR_MISMATCH).",
    );
  }
  const { passphrase, displayed: passphraseShown } = await promptNewPassphrase(io, options);
  const mnemonic = await promptMnemonic(io);
  const wallet = await backend.restore({ dataDir, passphrase, mnemonic });
  await wallet.close();
  // A restore never DISPLAYS the words (they are typed); only a GENERATED
  // passphrase would have been on screen.
  return completeSetup({ ...args, passphrase, secretShown: passphraseShown, backupConfirmed: true, action: "restored" });
}

async function resumeRitualFlow(args: FlowArgs & { env: Record<string, string | undefined> }): Promise<WalletInitResult> {
  const { io, backend, dataDir, options, env } = args;
  io.write("");
  io.write("A wallet already exists here, but its backup was never confirmed — the words were shown and the");
  io.write("challenge was not completed. Receive addresses stay blocked until it is. Let's finish it now.");

  const { wallet, passphrase } = await openWithPassphrase(io, backend, dataDir);
  const initiallyConfirmed = wallet.isBackupConfirmed();
  let backupConfirmed = initiallyConfirmed;
  try {
    if (!backupConfirmed) {
      await confirmSeedDisplay(io, env);
      // The words come from the wallet itself (decrypted with the passphrase
      // just typed) and go only to the ritual's output.
      const mnemonic = await wallet.exportMnemonic();
      backupConfirmed = await runBackupRitual(mnemonic, io, options.ritual);
      if (backupConfirmed) await wallet.confirmBackup();
    }
  } finally {
    await wallet.close();
  }

  return completeSetup({
    ...args,
    passphrase,
    // The words were on screen only if the ritual actually ran this time.
    secretShown: !initiallyConfirmed,
    backupConfirmed,
    action: "backup_ritual_rerun",
  });
}

/**
 * The common tail once a wallet is set up: save the unlock key, warn if the
 * backup gate is still closed, gather limits, offer the operator connect, then
 * clear the screen and register/print the block.
 */
async function completeSetup(
  args: FlowArgs & {
    passphrase: string;
    secretShown: boolean;
    backupConfirmed: boolean;
    action: WalletInitAction;
  },
): Promise<WalletInitResult> {
  const { io, dataDir, packageName, options, passphrase, secretShown, backupConfirmed, action, initCommand } = args;

  // §3.7 #8 — the unlock key goes to the OS keychain, never a config file. This
  // never fails init: a missing keychain falls through to a 0600 file, and even
  // that failing only downgrades to "set DEPIX_WALLET_PASSPHRASE yourself".
  const unlock = await storeUnlockKey(dataDir, passphrase, options.unlock);

  if (!backupConfirmed && (action === "created" || action === "backup_ritual_rerun")) {
    warnBackupUnconfirmed(io, initCommand);
  }

  const limits = await promptLimits(io, options);
  const operatorToken = await promptOperatorConnect(io);
  const serverEnv = buildServerEnv({ dataDir, limits, operatorToken });

  const { block, registered } = await finish({
    io,
    packageName,
    serverKey: options.serverKey,
    env: serverEnv,
    unlock,
    limits,
    secretShown,
    options,
  });

  return {
    action,
    dataDir,
    backupConfirmed,
    configBlock: block,
    env: serverEnv,
    limits,
    unlock,
    registeredHosts: registered.map((h) => h.id),
    operatorConnected: operatorToken !== undefined,
  };
}

/** Second run over a finished wallet: reprint the wiring block, prompt for nothing. */
async function alreadyConfiguredFlow(args: FlowArgs): Promise<WalletInitResult> {
  const { io, dataDir, packageName, options } = args;
  io.write("");
  io.write("A wallet is already set up here and its backup is confirmed — nothing to create.");
  io.write("Its unlock key and limits were saved on the first run. This block wires a host to this wallet:");
  const env = { DEPIX_WALLET_DIR: dataDir };
  const block = renderWalletMcpConfigBlock({ packageName, serverKey: options.serverKey, env });
  io.write("");
  io.write(block);
  io.write("");
  io.write("Then open your assistant and say:  create your DePix account");
  return {
    action: "already_configured",
    dataDir,
    backupConfirmed: true,
    configBlock: block,
    env,
    limits: null,
    unlock: null,
    registeredHosts: [],
    operatorConnected: false,
  };
}

/** Open an existing wallet, re-prompting on a wrong passphrase; returns the wallet AND the passphrase. */
async function openWithPassphrase(
  io: WalletInitIo,
  backend: InitWalletBackend,
  dataDir: string,
): Promise<{ wallet: InitWallet; passphrase: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const passphrase = await io.secret("Passphrase for this wallet (not echoed): ");
    registerSecret(passphrase);
    try {
      // No crash-resume on this open: `init` is a local, offline ceremony — it
      // must not start re-broadcasting withdrawals or re-driving swaps.
      const wallet = await backend.open({
        dataDir,
        passphrase,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false,
      });
      return { wallet, passphrase };
    } catch (err) {
      lastError = err;
      const code = err instanceof WalletError ? err.code : undefined;
      if (code !== "WRONG_PASSPHRASE" && code !== "WEAK_PASSPHRASE") throw err;
      io.write("That passphrase does not open this wallet. Try again.");
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new WalletError("INIT_PASSPHRASE_FAILED", "Could not open the wallet with the passphrases provided.");
}

/**
 * Prompt for the passphrase that encrypts the seed at rest, twice (a typo here
 * is unrecoverable without the mnemonic), or generate one on an empty answer.
 * Nothing typed is ever echoed. Copy: §3.7 step 2.
 */
async function promptNewPassphrase(
  io: WalletInitIo,
  options: RunWalletInitOptions,
): Promise<{ passphrase: string; displayed: boolean }> {
  const generate = options.generatePassphrase ?? (() => generateStrongPassphrase());
  io.write("");
  io.write("Create a passphrase — it locks the wallet on this computer.");
  io.write("Save it in your password manager or on paper: you'll need it to RESTORE the wallet someday.");
  io.write("It is NOT written into any config file. The wallet keeps its own unlock key in your computer's password");
  io.write("store — the same protected place your browser keeps passwords — so it can start by itself.");
  io.write(`Minimum ${MIN_PASSPHRASE_LENGTH} characters. Nothing you type at these prompts is echoed.`);
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const typed = await io.secret("Passphrase (or press Enter to generate a strong one): ");
    if (typed === "") {
      const generated = generate();
      registerSecret(generated);
      io.write("");
      io.write("Generated passphrase — store it in your password manager NOW. It is shown ONCE, is not written to");
      io.write("disk, is not logged, and does NOT appear in the config block printed at the end:");
      io.write("");
      io.write(`    ${generated}`);
      io.write("");
      const ack = await io.question('Type "saved" once it is stored: ');
      if (normalize(ack) !== "saved") {
        io.write("Not confirmed — let's pick a passphrase again.");
        continue;
      }
      return { passphrase: generated, displayed: true };
    }
    if (typed.length < MIN_PASSPHRASE_LENGTH) {
      io.write(`Too short: at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      continue;
    }
    const again = await io.secret("Repeat the passphrase: ");
    if (again !== typed) {
      io.write("The two entries differ. Try again.");
      continue;
    }
    registerSecret(typed);
    return { passphrase: typed, displayed: false };
  }
  throw new WalletError(
    "INIT_PASSPHRASE_FAILED",
    `No passphrase was set after ${MAX_PROMPT_ATTEMPTS} attempts. Nothing was created; re-run the command.`,
  );
}

/** Hidden prompt for an existing mnemonic (`--restore`). Never echoed, never logged. */
async function promptMnemonic(io: WalletInitIo): Promise<string> {
  io.write("");
  io.write("Type or paste your 12 words. They are NOT echoed, and they never leave this machine.");
  const mnemonic = await io.secret("Mnemonic (12 words): ");
  if (mnemonic.trim() === "") {
    throw new WalletError("INVALID_MNEMONIC", "No mnemonic was entered. Nothing was written; re-run the command.");
  }
  // Word-count/checksum validation belongs to the engine (restore() →
  // validateMnemonic → INVALID_MNEMONIC); do not re-implement it here.
  return mnemonic;
}

// ── limits + allowlist step (§3.7 #1) ────────────────────────────────────────

/**
 * Parse a BRL amount the operator typed (reais) into integer cents, or null when
 * it is not a clean amount. Accepts `100`, `100.50`, `100,50`, an optional `R$`
 * and surrounding space; rejects thousands separators (ambiguous) and anything
 * else — the caller re-prompts rather than guessing a money ceiling.
 */
export function parseBrlToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^r\$\s*/i, "").replace(/\s+/g, "");
  if (cleaned === "") return null;
  if (cleaned.includes(".") && cleaned.includes(",")) return null; // ambiguous thousands sep
  const normalized = cleaned.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const reais = Number(normalized);
  if (!Number.isFinite(reais) || reais <= 0) return null;
  return Math.round(reais * 100);
}

/**
 * Split the allowlist answer into Liquid addresses. Space- or comma-separated,
 * de-duplicated, empty tokens dropped. Address SHAPE is validated by the engine
 * at signing time (by derived scriptPubkey) — here we only collect.
 */
export function parseAllowlistInput(raw: string): string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    const t = token.trim();
    if (t !== "") seen.add(t);
  }
  return [...seen];
}

/** R$ amount from cents, two decimals (e.g. 10000 → "100.00"). */
function formatBrl(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Prompt for one BRL ceiling; Enter accepts the default; a bad value re-prompts. */
async function promptBrlCeiling(io: WalletInitIo, label: string, defaultCents: number): Promise<number> {
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const raw = await io.question(`${label} — R$ [default ${formatBrl(defaultCents)}]: `);
    if (raw.trim() === "") return defaultCents;
    const cents = parseBrlToCents(raw);
    if (cents !== null) return cents;
    io.write('  Enter an amount like "100" or "100.50" (or just press Enter for the default).');
  }
  io.write(`  Keeping the default (R$ ${formatBrl(defaultCents)}).`);
  return defaultCents;
}

/** The limits + allowlist step. Copy: §3.7 step 3 (the honest note is verbatim). */
async function promptLimits(io: WalletInitIo, options: RunWalletInitOptions): Promise<WalletLimits> {
  const defaults = options.limitsDefaults ?? {
    perTxBrlCents: DEFAULT_PER_TX_LIMIT_BRL_CENTS,
    dailyBrlCents: DEFAULT_DAILY_LIMIT_BRL_CENTS,
  };
  io.write("");
  io.write("=== SPENDING LIMITS ===");
  io.write("These caps apply to every send, withdraw and convert your agent asks for, BEFORE anything is signed.");
  io.write("If your agent can use the terminal (like Claude Code), these limits stop mistakes and trickery —");
  io.write("not a hostile agent. The real safety is simple: keep in this wallet only what you'd be OK losing.");
  io.write("Press Enter at each prompt to accept the default.");
  const perTxBrlCents = await promptBrlCeiling(io, "Max per transaction", defaults.perTxBrlCents);
  const dailyBrlCents = await promptBrlCeiling(io, "Max per 24 hours", defaults.dailyBrlCents);
  io.write("");
  io.write("Allowlist — the Liquid addresses your agent may send to (space- or comma-separated).");
  io.write("Leave empty to allow ANY address (the caps above still apply).");
  const allow = await io.question("Allowed Liquid addresses (Enter for any): ");
  return { perTxBrlCents, dailyBrlCents, allowlistLiquidAddresses: parseAllowlistInput(allow) };
}

// ── operator connect step (§3.7 #7) ──────────────────────────────────────────

/**
 * Optionally collect the op_ operator token now. [1] connect now (open the OAuth
 * page, paste the code) → returned so it is written into the config; [2] later →
 * undefined, and the agent asks for it via next_action the first time it needs
 * it. Copy: §3.7 step 4.
 */
async function promptOperatorConnect(io: WalletInitIo): Promise<string | undefined> {
  io.write("");
  io.write("=== AUTHORIZE THE AGENT'S ACCOUNT (optional) ===");
  io.write("Your agent opens its own account, in its first conversation. To authorize it, connect your identity");
  io.write("(GitHub or Google) once. You can do it now or let the agent ask you later.");
  io.write(`  [1] Connect now  — open ${OPERATOR_OAUTH_START_URL}, sign in, paste the op_ code here.`);
  io.write("  [2] Later        — the agent asks for it the first time it opens the account.");
  const choice = await io.question("Choose [1/2] (Enter = later): ");
  if (normalize(choice) !== "1") return undefined;
  io.write(`Open ${OPERATOR_OAUTH_START_URL}, sign in with GitHub or Google, and copy the code (starts with op_).`);
  const token = (await io.question("Paste your op_ code (Enter to skip): ")).trim();
  if (token === "") return undefined;
  if (!token.startsWith("op_")) {
    io.write("That does not look like an op_ code — skipping. The agent will ask for it later.");
    return undefined;
  }
  return token;
}

// ── finishing: clear, register/print, account step ───────────────────────────

function unlockNote(unlock: StoreUnlockResult): string {
  if (unlock.backend === "keychain") {
    return `Unlock key saved in ${unlock.detail}. The wallet starts on its own; your passphrase stays in your password manager.`;
  }
  if (unlock.backend === "file") {
    return `No OS keychain available — unlock key saved to a 0600 file (${unlock.detail}). It is outside any project.`;
  }
  return "Could NOT save an unlock key — set DEPIX_WALLET_PASSPHRASE in your host config, or re-run init.";
}

/**
 * The abort window before the words appear (spec §1.5 fix #6). TTY-ness proves
 * a terminal, never a PRIVATE one — so say it plainly and make the operator act.
 * `abortCode` names the refusal for the calling ceremony (`backup` uses its own).
 */
export async function confirmSeedDisplay(
  io: WalletInitIo,
  env: Record<string, string | undefined>,
  abortCode = "INIT_ABORTED",
): Promise<void> {
  const markers = detectSharedTerminalMarkers(env);
  io.write("");
  io.write("=== STOP — READ BEFORE THE NEXT SCREEN ===");
  io.write("The 12 words about to be displayed ARE the money: anyone who reads them can spend these funds,");
  io.write("today or in ten years. They cannot be rotated.");
  io.write("If this window is SHARED, RECORDED, screen-captured, or is an AGENT's terminal — abort NOW (Ctrl-C)");
  io.write("and re-run this command in a private terminal you control.");
  if (markers.length > 0) {
    io.write(
      `This session sets ${markers.join(", ")} — a multiplexer/remote/agent session whose scrollback may be ` +
        "persisted by another program. Prefer a plain local terminal.",
    );
  }
  const answer = await io.question('Type "continue" to display the 12 words: ');
  if (normalize(answer) !== "continue") {
    throw new WalletError(
      abortCode,
      "Aborted before the seed words were displayed — nothing was shown. Re-run the command in a private terminal.",
    );
  }
}

function warnBackupUnconfirmed(io: WalletInitIo, initCommand: string): void {
  io.write("");
  io.write("BACKUP NOT CONFIRMED. The wallet exists and is encrypted on this disk, but receive addresses stay");
  io.write(`blocked until the ritual passes. Re-run \`${initCommand}\` when you have the words in front of you —`);
  io.write("it picks up exactly here (it will not create a second wallet).");
}

/**
 * Clear the scrollback (§3.7 #3), recap the limits and unlock store, register the
 * server with the operator's host (§3.7 #6) or print the block, then the account
 * step (§3.7 #4). Returns the block + the hosts actually registered.
 */
async function finish(args: {
  io: WalletInitIo;
  packageName: string;
  serverKey?: string;
  env: Record<string, string>;
  unlock: StoreUnlockResult;
  limits: WalletLimits;
  /** Was ANY secret on screen — the 12 words, or a GENERATED passphrase? */
  secretShown: boolean;
  options: RunWalletInitOptions;
}): Promise<{ block: string; registered: HostTarget[] }> {
  const { io, packageName, serverKey, env, unlock, limits, secretShown, options } = args;

  // §3.7 #3 — auto scrollback cleanup. Wiping BEFORE printing the block keeps the
  // block + next steps readable while the words/passphrase leave the history.
  if (secretShown) {
    io.clear();
    io.write("Screen cleared, scrollback included. If your terminal cannot clear its scrollback, the 12 words or a");
    io.write("generated passphrase may still be in this window's history — close the window to be safe.");
    io.write("");
  }

  // §3.7 #7 — limits are visible, always.
  io.write(`Limits: R$ ${formatBrl(limits.perTxBrlCents)} per transaction, R$ ${formatBrl(limits.dailyBrlCents)} per 24h.`);
  if (limits.allowlistLiquidAddresses.length > 0) {
    io.write(`Allowlist: ${limits.allowlistLiquidAddresses.length} address(es) — anything else is refused.`);
  } else {
    io.write("Allowlist: any address (the caps above still apply).");
  }
  io.write(unlockNote(unlock));
  io.write("");

  const spec: McpServerSpec = { serverKey: serverKey ?? DEFAULT_MCP_SERVER_KEY, packageName, env };
  const detectDeps = options.hostDetect ?? defaultHostDetectDeps();
  const effects = options.hostEffects ?? defaultHostRegisterEffects;
  const { registered, block } = await offerHostRegistration(io, spec, detectDeps, effects);

  // §3.7 #4 — the account step. No API key here.
  io.write("");
  io.write("=== YOUR AGENT'S ACCOUNT ===");
  io.write("Open your assistant and say:  create your DePix account");
  io.write("It opens its own account and mints its own keys — you never paste an API key into this rite.");

  return { block, registered };
}

/**
 * Detect the operator's AI hosts and, with their confirmation, register the
 * server (§3.7 #6). Falls back to printing the block when nothing is detected or
 * no host was registered.
 */
async function offerHostRegistration(
  io: WalletInitIo,
  spec: McpServerSpec,
  detectDeps: HostDetectDeps,
  effects: HostRegisterEffects,
): Promise<{ registered: HostTarget[]; block: string }> {
  const block = renderWalletMcpConfigBlock({ packageName: spec.packageName, serverKey: spec.serverKey, env: spec.env });
  let hosts: HostTarget[] = [];
  try {
    hosts = detectHosts(detectDeps);
  } catch {
    hosts = [];
  }

  if (hosts.length === 0) {
    io.write("No known AI host detected. Paste this into your host's MCP config:");
    io.write("");
    io.write(block);
    return { registered: [], block };
  }

  io.write(`Detected: ${hosts.map((h) => h.label).join(", ")}. I can register the DePix server for you.`);
  const registered: HostTarget[] = [];
  for (const host of hosts) {
    const answer = await io.question(`Register with ${host.label}? [Y/n]: `);
    if (normalize(answer) === "n" || normalize(answer) === "no") continue;
    const outcome = await registerWithHost(host, spec, effects);
    io.write(outcome.ok ? `  OK — ${outcome.detail}` : `  Skipped — ${outcome.detail}`);
    if (outcome.ok) registered.push(host);
  }

  if (registered.length === 0) {
    io.write("");
    io.write("Not registered automatically. Paste this into your host's MCP config:");
    io.write("");
    io.write(block);
  } else {
    io.write("Restart the host(s) above so they pick up the new server.");
  }
  return { registered, block };
}

export type { StoreUnlockResult, UnlockBackend };
