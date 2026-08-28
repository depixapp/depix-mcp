// `npx -y @depixapp/mcp backup` — the ceremony that shows an EXISTING wallet's
// 12 words again (unified-MCP spec §1.5 / §3.7 #2).
//
// What these tests pin: it REFUSES without a TTY (the guard that keeps the words
// out of a pipe, a log or a chat transcript); it ALWAYS asks a human for the
// passphrase, even when the env already carries one; three wrong passphrases
// abort with NOTHING on screen; the screen is wiped only AFTER the operator
// confirms; the wallet — and with it the dataDir lock — is closed BEFORE the
// words are displayed; a dir held by another process is explained by pid; and
// neither the mnemonic nor the passphrase escapes the rite: not in the returned
// value, not in an error, not in any line outside the ritual block.
//
// The wallet backend and the terminal are injected, so the ceremony itself never
// runs for real: no TTY, no LWK engine, no dataDir.

import { describe, expect, it } from "vitest";
import {
  runWalletBackup,
  type BackupWallet,
  type BackupWalletBackend,
  type RunWalletBackupOptions,
} from "../../src/wallet-engine/mcp/backup-flow.js";
import type { WalletInitIo } from "../../src/wallet-engine/mcp/init-flow.js";
import type { OpenOptions } from "../../src/wallet-engine/wallet.js";
import { WalletError } from "../../src/wallet-engine/errors.js";

const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const WORDS = MNEMONIC.split(" ");
const PASSPHRASE = "correct-horse-battery-staple";
const DATA_DIR = "/tmp/does-not-exist/.depix-wallet";
const CLEAR_MARK = "<<CLEAR>>";
const CLOSE_MARK = "<<WALLET-CLOSED>>";

const TTY = { stdin: true, stdout: true };
/** The whole happy script: the abort-window "continue", then the pacing Enter. */
const HAPPY_ANSWERS = ["continue", ""];

/** Scripted terminal: `question`/`secret` pull from their queues; `clear` records a marker. */
function scriptedIo(script: { answers?: string[]; secrets?: string[] } = {}): {
  io: WalletInitIo;
  output: string[];
  secretPrompts: string[];
} {
  const answers = [...(script.answers ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const output: string[] = [];
  const secretPrompts: string[] = [];
  return {
    io: {
      write: (text) => void output.push(text),
      question: async (prompt) => {
        output.push(prompt);
        return answers.shift() ?? "";
      },
      secret: async (prompt) => {
        output.push(prompt);
        secretPrompts.push(prompt);
        if (secrets.length === 0) throw new Error("test script ran out of secrets");
        return secrets.shift()!;
      },
      clear: () => void output.push(CLEAR_MARK),
    },
    output,
    secretPrompts,
  };
}

class FakeBackupWallet implements BackupWallet {
  closed = 0;
  constructor(
    private readonly mnemonic: string,
    private readonly output: string[],
  ) {}
  async exportMnemonic(): Promise<string> {
    return this.mnemonic;
  }
  async close(): Promise<void> {
    this.closed++;
    this.output.push(CLOSE_MARK);
  }
}

class FakeBackend implements BackupWalletBackend {
  inspectCalls: string[] = [];
  openCalls: OpenOptions[] = [];
  wallets: FakeBackupWallet[] = [];
  /** Errors thrown by the next open() calls, in order. */
  openErrors: unknown[] = [];

  constructor(
    private readonly output: string[],
    private readonly existing: { backupConfirmed: boolean } | null = { backupConfirmed: true },
    private readonly mnemonic = MNEMONIC,
  ) {}

  async inspect(dataDir: string): Promise<{ backupConfirmed: boolean } | null> {
    this.inspectCalls.push(dataDir);
    return this.existing;
  }

  async open(options: OpenOptions): Promise<BackupWallet> {
    this.openCalls.push(options);
    const err = this.openErrors.shift();
    if (err) throw err;
    const wallet = new FakeBackupWallet(this.mnemonic, this.output);
    this.wallets.push(wallet);
    return wallet;
  }
}

function backupRun(over: Partial<RunWalletBackupOptions> = {}, script: { answers?: string[]; secrets?: string[] } = {}) {
  const io = scriptedIo({ answers: script.answers ?? HAPPY_ANSWERS, secrets: script.secrets ?? [PASSPHRASE] });
  const backend = new FakeBackend(io.output);
  const run = runWalletBackup({ backend, io: io.io, tty: TTY, dataDir: DATA_DIR, env: {}, ...over });
  return { io, backend, run };
}

/** Index of the first line carrying word #1 in the ritual's numbered format. */
function firstWordAt(output: string[]): number {
  return output.findIndex((line) => line.includes(`1. ${WORDS[0]!}`));
}

/** Did ANY numbered word line reach the screen? The negative assertion for the abort paths. */
function anyNumberedWordLine(output: string[]): boolean {
  return output.some((line) => /^\s+\d+\.\s+[a-z]+$/.test(line));
}

describe("runWalletBackup — TTY guard (§1.5)", () => {
  it("refuses when stdin is not a TTY, before touching the dataDir or asking anything", async () => {
    const io = scriptedIo();
    const backend = new FakeBackend(io.output);
    await expect(
      runWalletBackup({ backend, io: io.io, tty: { stdin: false, stdout: true }, dataDir: DATA_DIR, env: {} }),
    ).rejects.toMatchObject({ name: "WalletError", code: "BACKUP_REQUIRES_TTY" });
    expect(backend.inspectCalls).toHaveLength(0);
    expect(backend.openCalls).toHaveLength(0);
    expect(io.output).toHaveLength(0);
  });

  it("refuses when stdout is not a TTY — the case that would pipe the words into a log", async () => {
    const io = scriptedIo();
    const backend = new FakeBackend(io.output);
    await expect(
      runWalletBackup({ backend, io: io.io, tty: { stdin: true, stdout: false }, dataDir: DATA_DIR, env: {} }),
    ).rejects.toMatchObject({ code: "BACKUP_REQUIRES_TTY" });
  });

  it("the refusal names this bin's own backup command", async () => {
    const io = scriptedIo();
    const backend = new FakeBackend(io.output);
    const err = await runWalletBackup({
      backend,
      io: io.io,
      tty: { stdin: false, stdout: false },
      dataDir: DATA_DIR,
      env: {},
      packageName: "@acme/mcp",
    }).then(
      () => {
        throw new Error("expected the non-TTY invocation to refuse");
      },
      (e: unknown) => e as WalletError,
    );
    expect(err).toBeInstanceOf(WalletError);
    expect(err.message).toContain("npx -y @acme/mcp backup");
    expect(err.message).toMatch(/terminal/i);
  });
});

describe("runWalletBackup — the happy ceremony", () => {
  it("shows the 12 words in the ritual's format and reports the count, never the words", async () => {
    const { io, run } = backupRun();
    const result = await run;
    expect(result).toMatchObject({ dataDir: DATA_DIR, wordCount: 12, backupConfirmed: true, screenCleared: true });
    for (const [idx, word] of WORDS.entries()) expect(io.output.join("\n")).toContain(`  ${idx + 1}. ${word}`);
  });

  it("clears the screen only AFTER the operator confirms — order, not just presence", async () => {
    const { io, run } = backupRun();
    await run;
    const wordsAt = firstWordAt(io.output);
    const confirmAt = io.output.findIndex((line) => /Written them all down\?/.test(line));
    const clearAt = io.output.indexOf(CLEAR_MARK);
    const doneAt = io.output.findIndex((line) => line.includes("Backup done. This screen was cleared."));
    expect(wordsAt).toBeGreaterThanOrEqual(0);
    expect(confirmAt).toBeGreaterThan(wordsAt);
    expect(clearAt).toBeGreaterThan(confirmAt);
    expect(doneAt).toBeGreaterThan(clearAt);
  });

  it("tells the operator to use paper, and not a photo or a file", async () => {
    const { io, run } = backupRun();
    await run;
    expect(io.output.join("\n")).toContain("Write them on paper. Don't photograph them, don't save them to a file.");
  });

  it("warns about a shared/recorded window BEFORE any word reaches the screen", async () => {
    const { io, run } = backupRun();
    await run;
    const warningAt = io.output.findIndex((line) => /SHARED, RECORDED/.test(line));
    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(firstWordAt(io.output)).toBeGreaterThan(warningAt);
  });

  it("aborts at that warning with NOTHING displayed", async () => {
    const { io, backend, run } = backupRun({}, { answers: ["no"], secrets: [PASSPHRASE] });
    await expect(run).rejects.toMatchObject({ code: "BACKUP_ABORTED" });
    expect(anyNumberedWordLine(io.output)).toBe(false);
    expect(io.output.join("\n")).not.toContain(MNEMONIC);
    expect(backend.wallets.every((w) => w.closed === 1)).toBe(true);
  });

  it("closes the wallet — releasing the dataDir lock — BEFORE the words go on screen", async () => {
    const { io, backend, run } = backupRun();
    await run;
    expect(backend.wallets).toHaveLength(1);
    expect(backend.wallets[0]!.closed).toBe(1);
    expect(io.output.indexOf(CLOSE_MARK)).toBeGreaterThanOrEqual(0);
    expect(io.output.indexOf(CLOSE_MARK)).toBeLessThan(firstWordAt(io.output));
  });

  it("opens without resuming withdrawals or conversions — backup is an offline read", async () => {
    const { backend, run } = backupRun();
    await run;
    expect(backend.openCalls[0]).toMatchObject({
      dataDir: DATA_DIR,
      passphrase: PASSPHRASE,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
  });
});

describe("runWalletBackup — the passphrase is always a human's", () => {
  it("prompts (echo suppressed) EVEN when the env already carries the passphrase", async () => {
    const { io, backend, run } = backupRun({ env: { DEPIX_WALLET_PASSPHRASE: "the-servers-own-unlock-key" } });
    await run;
    expect(io.secretPrompts).toHaveLength(1);
    expect(io.secretPrompts[0]).toMatch(/not echoed/i);
    // The TYPED value is what opens the wallet — it outranks env and keychain.
    expect(backend.openCalls[0]!.passphrase).toBe(PASSPHRASE);
  });

  it("re-prompts on a wrong passphrase and succeeds on the next try", async () => {
    const { io, backend, run } = backupRun({}, { answers: HAPPY_ANSWERS, secrets: ["wrong-one-here", PASSPHRASE] });
    backend.openErrors.push(new WalletError("WRONG_PASSPHRASE", "Decryption failed — wrong passphrase or corrupted data"));
    const result = await run;
    expect(result.wordCount).toBe(12);
    expect(backend.openCalls).toHaveLength(2);
    expect(io.output.join("\n")).toMatch(/does not open this wallet/i);
  });

  it("three wrong passphrases abort with NOTHING shown", async () => {
    const io = scriptedIo({ answers: HAPPY_ANSWERS, secrets: ["nope-one", "nope-two", "nope-three"] });
    const backend = new FakeBackend(io.output);
    for (let i = 0; i < 3; i++) {
      backend.openErrors.push(new WalletError("WRONG_PASSPHRASE", "Decryption failed — wrong passphrase or corrupted data"));
    }
    const err = await runWalletBackup({ backend, io: io.io, tty: TTY, dataDir: DATA_DIR, env: {} }).then(
      () => {
        throw new Error("expected three wrong passphrases to abort");
      },
      (e: unknown) => e as WalletError,
    );
    expect(err.code).toBe("BACKUP_PASSPHRASE_FAILED");
    expect(backend.openCalls).toHaveLength(3);
    expect(anyNumberedWordLine(io.output)).toBe(false);
    expect(io.output.join("\n")).not.toContain(MNEMONIC);
    // The typed attempts never come back in the message the operator reads.
    for (const attempt of ["nope-one", "nope-two", "nope-three"]) expect(err.message).not.toContain(attempt);
  });

  it("does not retry an error that is not about the passphrase", async () => {
    const { backend, run } = backupRun();
    backend.openErrors.push(new WalletError("WALLET_CORRUPTED", "wallet.json is unreadable"));
    await expect(run).rejects.toMatchObject({ code: "WALLET_CORRUPTED" });
    expect(backend.openCalls).toHaveLength(1);
  });
});

describe("runWalletBackup — a wallet that is missing or busy", () => {
  it("points at `init` when there is no wallet, without asking for a passphrase", async () => {
    const io = scriptedIo();
    const backend = new FakeBackend(io.output, null);
    const err = await runWalletBackup({ backend, io: io.io, tty: TTY, dataDir: DATA_DIR, env: {} }).then(
      () => {
        throw new Error("expected a missing wallet to refuse");
      },
      (e: unknown) => e as WalletError,
    );
    expect(err.code).toBe("WALLET_NOT_FOUND");
    expect(err.message).toContain("npx -y @depixapp/mcp init");
    expect(err.message).toContain(DATA_DIR);
    expect(io.secretPrompts).toHaveLength(0);
  });

  it("explains a locked dataDir by pid and says to close the MCP host first", async () => {
    const { backend, run } = backupRun();
    backend.openErrors.push(
      new WalletError("WALLET_DIR_LOCKED", "Data dir is locked by another process (pid 4242).", {
        details: { pid: 4242 },
      }),
    );
    const err = await run.then(
      () => {
        throw new Error("expected a locked dataDir to refuse");
      },
      (e: unknown) => e as WalletError,
    );
    expect(err.code).toBe("WALLET_DIR_LOCKED");
    expect(err.message).toContain("4242");
    expect(err.message).toMatch(/close|quit/i);
    expect(err.message).toContain("npx -y @depixapp/mcp backup");
    // A busy dir is not a wrong passphrase: one attempt, no re-prompt loop.
    expect(backend.openCalls).toHaveLength(1);
  });
});

describe("runWalletBackup — leak checks", () => {
  it("the returned value carries no mnemonic and no passphrase, even serialized", async () => {
    const { run } = backupRun();
    const result = await run;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(MNEMONIC);
    expect(serialized).not.toContain(PASSPHRASE);
    expect(Object.values(result).join(" ")).not.toContain(MNEMONIC);
  });

  it("the words appear ONLY inside the ritual block — never before it, never after the wipe", async () => {
    const { io, run } = backupRun();
    await run;
    const start = firstWordAt(io.output);
    const clearAt = io.output.indexOf(CLEAR_MARK);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(start);
    const outside = [...io.output.slice(0, start), ...io.output.slice(clearAt)];
    // The FULL phrase, never a single word: "able"/"access" are ordinary English
    // and would match prose in the surrounding copy.
    expect(outside.join("\n")).not.toContain(MNEMONIC);
    expect(anyNumberedWordLine(outside)).toBe(false);
  });

  it("the passphrase is never echoed back into the output", async () => {
    const { io, run } = backupRun();
    await run;
    expect(io.output.join("\n")).not.toContain(PASSPHRASE);
  });
});
