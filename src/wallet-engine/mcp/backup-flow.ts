// `npx -y @depixapp/mcp backup` — the human ceremony that shows an EXISTING
// wallet's 12 words again (unified-MCP spec §1.5).
//
// Until now the only way to re-read the seed was a developer one-liner around
// `DepixWallet.open(...).exportMnemonic()`, whose words land as loose text in
// whatever ran it — a terminal that scrolls, a log, a chat transcript. This
// command puts the same words behind the init rite's guards: a real terminal, an
// abort window, a passphrase typed by a human, and an automatic screen wipe.
//
// INVARIANTS (the init ones, unchanged — see init-flow.ts):
//   1. NEVER an MCP tool. Re-reading a seed is a human act at a terminal; as a
//      tool the 12 words would transit model context and conversation logs.
//   2. TTY-only. It refuses when stdin or stdout is not a TTY — that refusal IS
//      the mechanism that keeps the words out of a pipe. Because a PTY proves a
//      terminal and not a PRIVATE one, the operator still gets the abort warning
//      before anything is displayed.
//   3. The passphrase is ALWAYS typed here, with echo suppressed, even when the
//      OS keychain already holds an unlock key. That auto-unlock exists so the
//      SERVER can boot unattended; dumping the seed is a different act, and it
//      demands the human prove the passphrase. So open() is called with the
//      typed value, which outranks $DEPIX_WALLET_PASSPHRASE and the keychain —
//      a wallet whose passphrase was forgotten cannot be dumped from a machine
//      that would otherwise start it on its own.
//   4. The mnemonic goes to the ritual's output path and nowhere else: not
//      logged, not returned (the result carries counts, never words), not
//      written to disk by this module.
//   5. The wallet is CLOSED before the words are displayed. The dataDir lock is
//      released while the operator copies onto paper — the MCP server can be
//      restarted mid-ceremony — and it never outlives this process.

import { displayMnemonic } from "../backup-ritual.js";
import { DepixSdkError, WalletError } from "../errors.js";
import { registerSecret } from "../logger.js";
import { SeedStore } from "../store/seed-store.js";
import { DepixWallet, type OpenOptions } from "../wallet.js";
import { DEFAULT_WALLET_INIT_COMMAND } from "./errors.js";
import {
  DEFAULT_MCP_PACKAGE,
  confirmSeedDisplay,
  createTtyInitIo,
  resolveCeremonyDataDir,
  type WalletInitIo,
} from "./init-flow.js";

/** Passphrase attempts before the ceremony gives up having shown nothing. */
const MAX_PASSPHRASE_ATTEMPTS = 3;

/** The subset of an OPEN wallet this ceremony touches. DepixWallet satisfies it. */
export interface BackupWallet {
  exportMnemonic(): Promise<string>;
  close(): Promise<void>;
}

/**
 * The wallet operations the ceremony drives. Defaults to DepixWallet + the
 * on-disk seed store; injected in tests so the flow runs with no LWK engine and
 * no dataDir.
 */
export interface BackupWalletBackend {
  /** Metadata of the wallet in `dataDir`, or null when there is none. Reads NO secret. */
  inspect(dataDir: string): Promise<{ backupConfirmed: boolean } | null>;
  open(options: OpenOptions): Promise<BackupWallet>;
}

/** What the ceremony did. Carries NO word and NO passphrase — by construction. */
export interface WalletBackupResult {
  dataDir: string;
  /** How many words were displayed (12 for a BIP39 12-word seed). */
  wordCount: number;
  /** Whether this wallet's first-run backup challenge had already been passed. */
  backupConfirmed: boolean;
  /** true once the screen + scrollback wipe ran. */
  screenCleared: boolean;
}

export interface RunWalletBackupOptions {
  /** Wallet dir. Default: $DEPIX_WALLET_DIR ?? ~/.depix-wallet (the wallet's own rule). */
  dataDir?: string;
  /** npm package named in the guidance. Default `@depixapp/mcp`. */
  packageName?: string;
  /** Terminal I/O. Default: a real TTY reader whose secret prompt does not echo. */
  io?: WalletInitIo;
  /** TTY detection override (tests). Default: process.stdin.isTTY && process.stdout.isTTY. */
  tty?: { stdin: boolean; stdout: boolean };
  /** Environment read for the dataDir default + the shared-terminal markers. */
  env?: Record<string, string | undefined>;
  /** Wallet backend. Default: DepixWallet + SeedStore. */
  backend?: BackupWalletBackend;
}

/** DepixWallet + the on-disk seed store — what the bin runs against. */
export const defaultBackupWalletBackend: BackupWalletBackend = {
  async inspect(dataDir: string): Promise<{ backupConfirmed: boolean } | null> {
    // Plaintext metadata only (the seed stays encrypted): tells "no wallet here"
    // from "wallet here" WITHOUT a passphrase, so the operator is sent to `init`
    // before being asked to type anything.
    const file = await new SeedStore(dataDir).read();
    return file ? { backupConfirmed: file.backupConfirmed === true } : null;
  },
  open: (options) => DepixWallet.open(options),
};

/** The holder pid a WALLET_DIR_LOCKED carries, when the lock file named one. */
function lockOwnerPid(err: unknown): number | null {
  const pid = err instanceof DepixSdkError ? err.details?.pid : undefined;
  return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
}

/**
 * Re-word a locked dataDir for the person at the terminal. The engine's message
 * is written for a developer wiring two processes; here the holder is almost
 * always the MCP server the operator's assistant started, and the fix is to quit
 * that app — not to pick a second DEPIX_WALLET_DIR, which would point at a
 * different wallet with different words.
 */
function lockedDirError(err: unknown, backupCommand: string): WalletError {
  const pid = lockOwnerPid(err);
  const holder = pid === null ? "another process" : `another process (pid ${pid})`;
  return new WalletError(
    "WALLET_DIR_LOCKED",
    `This wallet is open in ${holder} — normally the depix-mcp server your AI app started. ` +
      `Quit that app (or stop that process), then run \`${backupCommand}\` again. ` +
      "Nothing was opened and nothing was shown.",
    { cause: err, ...(pid === null ? {} : { details: { pid } }) },
  );
}

/**
 * Ask for the passphrase, open the wallet, take the words, close it again.
 * Returns ONLY the mnemonic: the typed passphrase dies with this frame, so no
 * caller can put it in a result, a log or an error.
 */
async function readMnemonicWithPassphrase(
  io: WalletInitIo,
  backend: BackupWalletBackend,
  dataDir: string,
  backupCommand: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_PASSPHRASE_ATTEMPTS; attempt++) {
    const passphrase = await io.secret("Passphrase for this wallet (not echoed): ");
    registerSecret(passphrase);
    let wallet: BackupWallet;
    try {
      // No crash-resume: `backup` is an offline read — it must not start
      // re-broadcasting withdrawals or re-driving swaps to show 12 words.
      wallet = await backend.open({
        dataDir,
        passphrase,
        resumePendingWithdrawalsOnOpen: false,
        resumePendingConversionsOnOpen: false,
      });
    } catch (err) {
      const code = err instanceof DepixSdkError ? err.code : undefined;
      if (code === "WALLET_DIR_LOCKED") throw lockedDirError(err, backupCommand);
      if (code !== "WRONG_PASSPHRASE" && code !== "WEAK_PASSPHRASE") throw err;
      io.write("That passphrase does not open this wallet. Try again.");
      continue;
    }
    try {
      return await wallet.exportMnemonic();
    } finally {
      // INVARIANT 5 — the lock is released here, before anything is displayed.
      await wallet.close();
    }
  }
  // The failed attempts are NOT attached, not even as a cause: a wrong
  // passphrase is often a right one with a typo, and this message is the one
  // that gets pasted into a chat when someone asks for help.
  throw new WalletError(
    "BACKUP_PASSPHRASE_FAILED",
    `The wallet did not open after ${MAX_PASSPHRASE_ATTEMPTS} attempts. Nothing was shown. ` +
      "The passphrase is the one you set at first run and stored in your password manager — " +
      "without it these words cannot be recovered from this computer.",
  );
}

/**
 * Show an existing wallet's 12 words again. TTY-only, always passphrase-gated,
 * and the screen is wiped before it returns.
 */
export async function runWalletBackup(options: RunWalletBackupOptions = {}): Promise<WalletBackupResult> {
  const env = options.env ?? process.env;
  const dataDir = resolveCeremonyDataDir(options.dataDir, env);
  const packageName = options.packageName ?? DEFAULT_MCP_PACKAGE;
  const backupCommand = `npx -y ${packageName} backup`;
  const initCommand =
    packageName === DEFAULT_MCP_PACKAGE ? DEFAULT_WALLET_INIT_COMMAND : `npx -y ${packageName} init`;
  const backend = options.backend ?? defaultBackupWalletBackend;
  const tty = options.tty ?? {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
  };

  // INVARIANT 2 — the refusal comes first, before the dataDir is even read. A
  // ceremony that runs head-less is a ceremony whose output can be captured.
  if (!tty.stdin || !tty.stdout) {
    throw new WalletError(
      "BACKUP_REQUIRES_TTY",
      `\`${backupCommand}\` displays your 12 seed words and needs a real terminal — ` +
        `stdin is ${tty.stdin ? "a TTY" : "NOT a TTY"} and stdout is ${tty.stdout ? "a TTY" : "NOT a TTY"} here. ` +
        "Run it yourself in a terminal window: not piped, not redirected, not from an agent or CI job. " +
        "This refusal is the point — it is what keeps the words out of a log or a chat transcript.",
    );
  }

  const io = options.io ?? createTtyInitIo();
  const existing = await backend.inspect(dataDir);
  if (existing === null) {
    throw new WalletError(
      "WALLET_NOT_FOUND",
      `No wallet in ${dataDir}. There are no words to show yet — run \`${initCommand}\` to create one ` +
        "(or set DEPIX_WALLET_DIR to the dir that holds your wallet).",
    );
  }

  io.write("");
  io.write("=== DePix wallet — show the 12 words again ===");
  io.write(`Wallet dir: ${dataDir}`);
  io.write("Nothing leaves this machine: the seed is decrypted here, shown here, and this screen is wiped at the end.");
  io.write("");
  io.write("Your passphrase is required even if this computer can unlock the wallet on its own — that");
  io.write("auto-unlock exists so the server can start, not so anyone at this keyboard can read the seed.");

  const mnemonic = await readMnemonicWithPassphrase(io, backend, dataDir, backupCommand);

  await confirmSeedDisplay(io, env, "BACKUP_ABORTED");

  const words = displayMnemonic(mnemonic, io);
  io.write("Write them on paper. Don't photograph them, don't save them to a file.");
  io.write("");
  await io.question("Written them all down? Press Enter to clear this screen: ");
  io.clear();
  io.write("Backup done. This screen was cleared.");
  io.write("If your terminal cannot clear its scrollback, the words may still be in this window's history —");
  io.write("close the window to be safe.");

  return { dataDir, wordCount: words.length, backupConfirmed: existing.backupConfirmed, screenCleared: true };
}
