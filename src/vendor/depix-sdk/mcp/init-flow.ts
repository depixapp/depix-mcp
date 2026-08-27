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
 * Path:      src/mcp/init-flow.ts
 * Generated: scripts/vendor-engine.mjs (npm run vendor:engine)
 *
 * DePix App owns this code and distributes THIS copy under Apache-2.0. The
 * `@depixapp/sdk` lineage of the same source remains AGPL-3.0-only; nothing
 * from that published tarball is reused here (spec §2.2).
 */
// First-run ceremony for the local wallet — the engine half of `init`
// (unified-MCP spec §1.5). The unified bin (`npx -y @depixapp/mcp init`) parses
// argv and calls runWalletInit(); this module owns everything human.
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
//      suppressed (raw-mode stdin, no dependency), and the printed `mcpServers`
//      block carries a PLACEHOLDER, never the real value. A generated
//      passphrase is displayed exactly once, in the same TTY, because the
//      operator cannot use a passphrase they were never shown.
//   4. The mnemonic goes to the ritual's own output path and nowhere else: not
//      logged, not returned, not written to disk by this module.
//   5. The wallet is CLOSED before returning — the dataDir lock is released, so
//      the MCP server the operator is about to start can open it.

import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { runBackupRitual, type RitualIo, type RitualOptions } from "../backup-ritual.js";
import { WalletError } from "../errors.js";
import { registerSecret } from "../logger.js";
import { MIN_PASSPHRASE_LENGTH } from "../store/crypto.js";
import { SeedStore } from "../store/seed-store.js";
import { DepixWallet, type CreateOptions, type OpenOptions, type RestoreOptions } from "../wallet.js";
import { DEFAULT_WALLET_INIT_COMMAND } from "./errors.js";

/** Default npm package of the unified MCP — what the printed block runs. */
export const DEFAULT_MCP_PACKAGE = "@depixapp/mcp";
/** Default key of the printed `mcpServers` entry. */
export const DEFAULT_MCP_SERVER_KEY = "depix";
/** Attempts allowed on the passphrase / mnemonic prompts before giving up. */
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

/** Terminal I/O for the ceremony: the ritual's pair plus an echo-free read. */
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
   * The `mcpServers` block that was printed. Safe to log/return: the passphrase
   * is a placeholder and no seed material is in it.
   */
  configBlock: string;
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
}

// ── passphrase generation ────────────────────────────────────────────────────

// Look-alike-free alphabet (no 0/O/1/l/I): the operator retypes this into a
// config file. 56 symbols ≈ 5.8 bits/char → 24 chars ≈ 139 bits.
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

// ── the paste-ready config block ─────────────────────────────────────────────

/** Placeholder that stands in for the real passphrase in the printed block. */
export const PASSPHRASE_PLACEHOLDER = "<the passphrase you typed>";
const API_KEY_PLACEHOLDER = "<your DePix API key: sk_test_… or sk_live_…>";

/**
 * The `mcpServers` JSON the operator pastes into Claude/Cursor. Secrets are
 * PLACEHOLDERS by construction — this function has no access to the real ones.
 */
export function renderWalletMcpConfigBlock(opts: {
  dataDir: string;
  packageName?: string;
  serverKey?: string;
}): string {
  const block = {
    mcpServers: {
      [opts.serverKey ?? DEFAULT_MCP_SERVER_KEY]: {
        command: "npx",
        args: ["-y", opts.packageName ?? DEFAULT_MCP_PACKAGE],
        env: {
          DEPIX_API_KEY: API_KEY_PLACEHOLDER,
          DEPIX_WALLET_PASSPHRASE: PASSPHRASE_PLACEHOLDER,
          DEPIX_WALLET_DIR: opts.dataDir,
        },
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

/** Real-terminal I/O: readline for prompts, raw-mode stdin for secrets. */
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

function resolveDataDir(explicit: string | undefined, env: Record<string, string | undefined>): string {
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
 * Run the first-run ceremony (spec §1.5). Creates, restores, resumes an
 * unfinished ritual, or just reprints the config — decided by what is already in
 * the dataDir. Returns WITHOUT the mnemonic or the passphrase, ever.
 */
export async function runWalletInit(options: RunWalletInitOptions = {}): Promise<WalletInitResult> {
  const env = options.env ?? process.env;
  const dataDir = resolveDataDir(options.dataDir, env);
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

  if (options.restore === true) {
    return restoreFlow({ io, backend, dataDir, packageName, options, existing: existing !== null });
  }
  if (existing === null) {
    return createFlow({ io, backend, dataDir, packageName, options, env, initCommand });
  }
  if (existing.backupConfirmed) {
    // Second run, nothing to do (§1.5 fix #11): create() would throw
    // WALLET_ALREADY_EXISTS, which is not an error the operator caused. Reprint.
    io.write("");
    io.write("A wallet is already set up here and its backup is confirmed — nothing to create.");
    const configBlock = finish({ io, dataDir, packageName, options, secretShown: false });
    return { action: "already_configured", dataDir, backupConfirmed: true, configBlock };
  }
  return resumeRitualFlow({ io, backend, dataDir, packageName, options, env, initCommand });
}

interface FlowArgs {
  io: WalletInitIo;
  backend: InitWalletBackend;
  dataDir: string;
  packageName: string;
  options: RunWalletInitOptions;
}

async function createFlow(
  args: FlowArgs & { env: Record<string, string | undefined>; initCommand: string },
): Promise<WalletInitResult> {
  const { io, backend, dataDir, packageName, options, env, initCommand } = args;
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

  if (!backupConfirmed) {
    warnBackupUnconfirmed(io, initCommand);
  }
  const configBlock = finish({ io, dataDir, packageName, options, secretShown: true });
  return { action: "created", dataDir, backupConfirmed, configBlock };
}

async function restoreFlow(args: FlowArgs & { existing: boolean }): Promise<WalletInitResult> {
  const { io, backend, dataDir, packageName, options, existing } = args;
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
  const configBlock = finish({ io, dataDir, packageName, options, secretShown: passphraseShown });
  return { action: "restored", dataDir, backupConfirmed: true, configBlock };
}

async function resumeRitualFlow(
  args: FlowArgs & { env: Record<string, string | undefined>; initCommand: string },
): Promise<WalletInitResult> {
  const { io, backend, dataDir, packageName, options, env, initCommand } = args;
  io.write("");
  io.write("A wallet already exists here, but its backup was never confirmed — the words were shown and the");
  io.write("challenge was not completed. Receive addresses stay blocked until it is. Let's finish it now.");

  const wallet = await openWithPassphrase(io, backend, dataDir);
  let backupConfirmed = wallet.isBackupConfirmed();
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

  if (!backupConfirmed) {
    warnBackupUnconfirmed(io, initCommand);
  }
  const configBlock = finish({ io, dataDir, packageName, options, secretShown: true });
  return { action: "backup_ritual_rerun", dataDir, backupConfirmed, configBlock };
}

/** Open an existing wallet, re-prompting on a wrong passphrase. */
async function openWithPassphrase(
  io: WalletInitIo,
  backend: InitWalletBackend,
  dataDir: string,
): Promise<InitWallet> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const passphrase = await io.secret("Passphrase for this wallet (not echoed): ");
    registerSecret(passphrase);
    try {
      // No crash-resume on this open: `init` is a local, offline ceremony — it
      // must not start re-broadcasting withdrawals or re-driving swaps.
      return await backend.open({
        dataDir,
        passphrase,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false,
      });
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
 * Nothing typed is ever echoed.
 */
async function promptNewPassphrase(
  io: WalletInitIo,
  options: RunWalletInitOptions,
): Promise<{ passphrase: string; displayed: boolean }> {
  const generate = options.generatePassphrase ?? (() => generateStrongPassphrase());
  io.write("");
  io.write(
    `Choose a passphrase (min ${MIN_PASSPHRASE_LENGTH} chars). It encrypts the seed on this disk and is NOT stored: ` +
      "the MCP server reads it from DEPIX_WALLET_PASSPHRASE at start-up.",
  );
  io.write("Nothing you type at these prompts is echoed.");
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

/**
 * The abort window before the words appear (spec §1.5 fix #6). TTY-ness proves
 * a terminal, never a PRIVATE one — so say it plainly and make the operator act.
 */
async function confirmSeedDisplay(io: WalletInitIo, env: Record<string, string | undefined>): Promise<void> {
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
      "INIT_ABORTED",
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

/** Print the paste-ready block + the closing hygiene advice. */
function finish(args: {
  io: WalletInitIo;
  dataDir: string;
  packageName: string;
  options: RunWalletInitOptions;
  /** Was ANY secret on screen — the 12 words, or a GENERATED passphrase? */
  secretShown: boolean;
}): string {
  const { io, dataDir, packageName, options, secretShown } = args;
  const configBlock = renderWalletMcpConfigBlock({
    dataDir,
    packageName,
    serverKey: options.serverKey,
  });
  io.write("");
  io.write("=== PASTE THIS INTO YOUR MCP HOST (Claude Desktop/Code, Cursor, …) ===");
  io.write(configBlock);
  io.write("");
  io.write(`Replace the two placeholders: your DePix API key, and the passphrase you just used (${PASSPHRASE_PLACEHOLDER}).`);
  io.write("The passphrase is deliberately NOT printed here — this terminal just showed secrets.");
  io.write("Then restart the host and call wallet_status to confirm the connection.");
  if (secretShown) {
    io.write("");
    io.write("Last step — CLEAR THIS TERMINAL'S SCROLLBACK: a secret was on screen (the 12 words, or the generated passphrase).");
    io.write("  macOS Terminal/iTerm: Cmd+K · elsewhere: clear && printf '\\033[3J'");
  }
  return configBlock;
}
