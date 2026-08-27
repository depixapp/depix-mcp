// The first-run ceremony (unified-MCP spec §1.5): `npx -y @depixapp/mcp init`.
//
// What these tests pin, in the spec's own terms: it REFUSES without a TTY; it
// warns (and can be aborted) BEFORE the 12 words appear; the passphrase is never
// echoed and never lands in the printed config block; a second run over a
// confirmed wallet just reprints; a second run over a wallet whose ritual failed
// re-runs the ritual and confirms; `--restore` reads the mnemonic through the
// hidden prompt; and the wallet is always closed (dataDir lock released, fix #20).
//
// I/O and the wallet backend are injected (RitualIo + InitWalletBackend), so the
// whole flow runs offline with no TTY, no LWK engine and no dataDir.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_PACKAGE,
  PASSPHRASE_PLACEHOLDER,
  detectSharedTerminalMarkers,
  generateStrongPassphrase,
  renderWalletMcpConfigBlock,
  runWalletInit,
  stripTerminalControlSequences,
  type InitWallet,
  type InitWalletBackend,
  type WalletInitIo,
} from "../../src/wallet-engine/mcp/init-flow.js";
import type { CreateOptions, OpenOptions, RestoreOptions } from "../../src/wallet-engine/wallet.js";
import { WalletError } from "../../src/wallet-engine/errors.js";

const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const WORDS = MNEMONIC.split(" ");
const PASSPHRASE = "correct-horse-battery-staple";
const DATA_DIR = "/tmp/does-not-exist/.depix-wallet";

// Deterministic ritual: always challenges positions 1, 2, 3 (same picker the
// backup-ritual suite uses).
const FIRST_POSITIONS = { random: () => 0 };

/** Scripted terminal: `question` and `secret` each pull from their own queue. */
function scriptedIo(script: { answers?: string[]; secrets?: string[] } = {}): {
  io: WalletInitIo;
  output: string[];
  remaining: () => { answers: number; secrets: number };
} {
  const answers = [...(script.answers ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const output: string[] = [];
  return {
    io: {
      write: (text) => {
        output.push(text);
      },
      question: async (prompt) => {
        output.push(prompt);
        return answers.shift() ?? "";
      },
      secret: async (prompt) => {
        // The prompt is echoed (it is not secret); the ANSWER never is.
        output.push(prompt);
        if (secrets.length === 0) throw new Error("test script ran out of secrets");
        return secrets.shift()!;
      },
    },
    output,
    remaining: () => ({ answers: answers.length, secrets: secrets.length }),
  };
}

class FakeInitWallet implements InitWallet {
  closed = 0;
  constructor(private readonly state: { backupConfirmed: boolean; mnemonic: string }) {}
  isBackupConfirmed(): boolean {
    return this.state.backupConfirmed;
  }
  async exportMnemonic(): Promise<string> {
    return this.state.mnemonic;
  }
  async confirmBackup(): Promise<void> {
    this.state.backupConfirmed = true;
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

class FakeBackend implements InitWalletBackend {
  inspectCalls: string[] = [];
  createCalls: CreateOptions[] = [];
  openCalls: OpenOptions[] = [];
  restoreCalls: RestoreOptions[] = [];
  wallets: FakeInitWallet[] = [];
  /** null = empty dataDir. */
  state: { backupConfirmed: boolean; mnemonic: string } | null;
  /** Thrown by the next open() call (wrong-passphrase simulation). */
  openErrors: unknown[] = [];

  constructor(state: { backupConfirmed: boolean; mnemonic: string } | null = null) {
    this.state = state;
  }

  private hand(state: { backupConfirmed: boolean; mnemonic: string }): FakeInitWallet {
    const wallet = new FakeInitWallet(state);
    this.wallets.push(wallet);
    return wallet;
  }

  async inspect(dataDir: string): Promise<{ backupConfirmed: boolean } | null> {
    this.inspectCalls.push(dataDir);
    return this.state ? { backupConfirmed: this.state.backupConfirmed } : null;
  }
  async create(options: CreateOptions): Promise<{ mnemonic: string; backupConfirmed: boolean; wallet: InitWallet }> {
    this.createCalls.push(options);
    // Mirrors the engine: the seed is persisted BEFORE any ritual, unconfirmed.
    this.state = { backupConfirmed: false, mnemonic: MNEMONIC };
    return { mnemonic: MNEMONIC, backupConfirmed: false, wallet: this.hand(this.state) };
  }
  async open(options: OpenOptions): Promise<InitWallet> {
    this.openCalls.push(options);
    const err = this.openErrors.shift();
    if (err) throw err;
    if (!this.state) throw new WalletError("WALLET_NOT_FOUND", "no wallet");
    return this.hand(this.state);
  }
  async restore(options: RestoreOptions): Promise<InitWallet> {
    this.restoreCalls.push(options);
    this.state = { backupConfirmed: true, mnemonic: options.mnemonic };
    return this.hand(this.state);
  }
}

const TTY = { stdin: true, stdout: true };

describe("runWalletInit — TTY guard (§1.5)", () => {
  it("refuses when stdin is not a TTY, before touching the dataDir", async () => {
    const backend = new FakeBackend();
    const { io } = scriptedIo();
    await expect(
      runWalletInit({ backend, io, tty: { stdin: false, stdout: true }, dataDir: DATA_DIR, env: {} }),
    ).rejects.toMatchObject({ name: "WalletError", code: "INIT_REQUIRES_TTY" });
    expect(backend.inspectCalls).toHaveLength(0);
    expect(backend.createCalls).toHaveLength(0);
  });

  it("refuses when stdout is not a TTY (piped/redirected output)", async () => {
    const backend = new FakeBackend();
    const { io } = scriptedIo();
    await expect(
      runWalletInit({ backend, io, tty: { stdin: true, stdout: false }, dataDir: DATA_DIR, env: {} }),
    ).rejects.toMatchObject({ code: "INIT_REQUIRES_TTY" });
  });

  it("the refusal is actionable and names the bin's own command", async () => {
    const backend = new FakeBackend();
    const { io } = scriptedIo();
    const err = await runWalletInit({
      backend,
      io,
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
    expect(err.message).toContain("npx -y @acme/mcp init");
    expect(err.message).toMatch(/terminal/i);
    // Headless bootstrap stays an SDK path, and the message says so.
    expect(err.message).toContain("mnemonicSecured");
  });
});

describe("runWalletInit — create (§1.5)", () => {
  const createScript = {
    secrets: [PASSPHRASE, PASSPHRASE],
    answers: ["continue", WORDS[0]!, WORDS[1]!, WORDS[2]!, "saved"],
  };

  it("creates, runs the ritual, confirms the backup and closes the wallet", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo(createScript);
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
    });

    expect(result.action).toBe("created");
    expect(result.backupConfirmed).toBe(true);
    expect(backend.createCalls).toHaveLength(1);
    expect(backend.createCalls[0]).toMatchObject({ dataDir: DATA_DIR, passphrase: PASSPHRASE, interactive: false });
    expect(backend.state?.backupConfirmed).toBe(true);
    // The dataDir lock is released before the operator starts the server (fix #20).
    expect(backend.wallets.every((w) => w.closed === 1)).toBe(true);
    // The words went through the ritual's own output path.
    const printed = output.join("\n");
    for (const [idx, word] of WORDS.entries()) expect(printed).toContain(`${idx + 1}. ${word}`);
  });

  it("warns about a shared/recorded window BEFORE showing any word", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo(createScript);
    await runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {}, ritual: FIRST_POSITIONS });
    const warningAt = output.findIndex((line) => /SHARED, RECORDED/.test(line));
    const firstWordAt = output.findIndex((line) => line.includes(`1. ${WORDS[0]!}`));
    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(firstWordAt).toBeGreaterThan(warningAt);
  });

  it("names the multiplexer/agent env markers it detected", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo(createScript);
    await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: { TMUX: "/tmp/tmux-501/default,123,0", CLAUDECODE: "1" },
      ritual: FIRST_POSITIONS,
    });
    const printed = output.join("\n");
    expect(printed).toContain("TMUX");
    expect(printed).toContain("CLAUDECODE");
  });

  it("aborts at the warning WITHOUT creating anything", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo({ secrets: [PASSPHRASE, PASSPHRASE], answers: ["no"] });
    await expect(
      runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {} }),
    ).rejects.toMatchObject({ code: "INIT_ABORTED" });
    expect(backend.createCalls).toHaveLength(0);
    expect(output.join("\n")).not.toContain(WORDS[0]!);
  });

  it("never prints the passphrase, and the config block carries only a placeholder", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo(createScript);
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
    });
    const printed = output.join("\n");
    expect(printed).not.toContain(PASSPHRASE);
    expect(result.configBlock).not.toContain(PASSPHRASE);
    expect(result.configBlock).toContain(PASSPHRASE_PLACEHOLDER);
    // Nor does the returned value carry seed material.
    expect(JSON.stringify(result)).not.toContain(WORDS[0]!);
    expect(result.configBlock).toContain(DEFAULT_MCP_PACKAGE);
    expect(printed).toMatch(/scrollback/i);
  });

  it("re-prompts on a too-short or mistyped passphrase", async () => {
    const backend = new FakeBackend();
    const { io, output, remaining } = scriptedIo({
      secrets: ["short", PASSPHRASE, "typo-here-not-the-same", PASSPHRASE, PASSPHRASE],
      answers: ["continue", WORDS[0]!, WORDS[1]!, WORDS[2]!, "saved"],
    });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
    });
    expect(result.backupConfirmed).toBe(true);
    expect(backend.createCalls[0]?.passphrase).toBe(PASSPHRASE);
    expect(remaining().secrets).toBe(0);
    const printed = output.join("\n");
    expect(printed).toMatch(/at least 12 characters/i);
    expect(printed).toMatch(/differ/i);
  });

  it("offers to generate a passphrase, shows it ONCE and keeps it out of the block", async () => {
    const backend = new FakeBackend();
    const generated = "Test-Generated-Passphrase-1";
    const { io, output } = scriptedIo({
      secrets: [""],
      answers: ["saved", "continue", WORDS[0]!, WORDS[1]!, WORDS[2]!, "saved"],
    });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
      generatePassphrase: () => generated,
    });
    expect(backend.createCalls[0]?.passphrase).toBe(generated);
    const occurrences = output.filter((line) => line.includes(generated)).length;
    expect(occurrences).toBe(1);
    expect(result.configBlock).not.toContain(generated);
  });

  it("keeps the wallet when the ritual FAILS, and says how to finish it", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo({
      secrets: [PASSPHRASE, PASSPHRASE],
      answers: ["continue", "wrongword"],
    });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: { ...FIRST_POSITIONS, maxAttempts: 1 },
    });
    expect(result.action).toBe("created");
    expect(result.backupConfirmed).toBe(false);
    expect(backend.state?.backupConfirmed).toBe(false);
    expect(backend.wallets.every((w) => w.closed === 1)).toBe(true);
    const printed = output.join("\n");
    expect(printed).toContain("BACKUP NOT CONFIRMED");
    expect(printed).toContain("npx -y @depixapp/mcp init");
  });
});

describe("runWalletInit — second run (§1.5 fix #11)", () => {
  it("reprints the config block when the wallet is there and CONFIRMED", async () => {
    const backend = new FakeBackend({ backupConfirmed: true, mnemonic: MNEMONIC });
    const { io, output } = scriptedIo();
    const result = await runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {} });

    expect(result.action).toBe("already_configured");
    expect(result.backupConfirmed).toBe(true);
    expect(result.configBlock).toContain(PASSPHRASE_PLACEHOLDER);
    // No WALLET_ALREADY_EXISTS, no ritual, no prompts, no wallet opened at all.
    expect(backend.createCalls).toHaveLength(0);
    expect(backend.openCalls).toHaveLength(0);
    const printed = output.join("\n");
    expect(printed).not.toContain(WORDS[0]!);
    expect(printed).toMatch(/already set up/i);
  });

  it("re-runs the ritual over an UNCONFIRMED wallet and confirms the backup", async () => {
    const state = { backupConfirmed: false, mnemonic: MNEMONIC };
    const backend = new FakeBackend(state);
    const { io, output } = scriptedIo({
      secrets: [PASSPHRASE],
      answers: ["continue", WORDS[0]!, WORDS[1]!, WORDS[2]!, "saved"],
    });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
    });

    expect(result.action).toBe("backup_ritual_rerun");
    expect(result.backupConfirmed).toBe(true);
    expect(state.backupConfirmed).toBe(true);
    expect(backend.createCalls).toHaveLength(0);
    expect(backend.openCalls).toHaveLength(1);
    // `init` is a local, offline ceremony: it must not start re-driving pending
    // withdrawals/conversions while the operator reads their words.
    expect(backend.openCalls[0]).toMatchObject({
      dataDir: DATA_DIR,
      passphrase: PASSPHRASE,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    expect(backend.wallets.every((w) => w.closed === 1)).toBe(true);
    const printed = output.join("\n");
    for (const [idx, word] of WORDS.entries()) expect(printed).toContain(`${idx + 1}. ${word}`);
    expect(printed).not.toContain(PASSPHRASE);
  });

  it("leaves the backup unconfirmed (and the wallet closed) when the rerun fails again", async () => {
    const state = { backupConfirmed: false, mnemonic: MNEMONIC };
    const backend = new FakeBackend(state);
    const { io, output } = scriptedIo({ secrets: [PASSPHRASE], answers: ["continue", "nope"] });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: { ...FIRST_POSITIONS, maxAttempts: 1 },
    });
    expect(result.backupConfirmed).toBe(false);
    expect(state.backupConfirmed).toBe(false);
    expect(backend.wallets.every((w) => w.closed === 1)).toBe(true);
    expect(output.join("\n")).toContain("BACKUP NOT CONFIRMED");
  });

  it("re-prompts on a wrong passphrase before giving up", async () => {
    const state = { backupConfirmed: false, mnemonic: MNEMONIC };
    const backend = new FakeBackend(state);
    backend.openErrors = [new WalletError("WRONG_PASSPHRASE", "wrong passphrase")];
    const { io, output } = scriptedIo({
      secrets: ["not-the-passphrase", PASSPHRASE],
      answers: ["continue", WORDS[0]!, WORDS[1]!, WORDS[2]!, "saved"],
    });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
    });
    expect(result.backupConfirmed).toBe(true);
    expect(backend.openCalls).toHaveLength(2);
    expect(output.join("\n")).toMatch(/does not open this wallet/i);
  });

  it("propagates a non-passphrase open failure untouched", async () => {
    const backend = new FakeBackend({ backupConfirmed: false, mnemonic: MNEMONIC });
    backend.openErrors = [new WalletError("DIR_LOCKED", "another process holds the dataDir lock")];
    const { io } = scriptedIo({ secrets: [PASSPHRASE] });
    await expect(
      runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {} }),
    ).rejects.toMatchObject({ code: "DIR_LOCKED" });
  });
});

describe("runWalletInit — restore (§1.5)", () => {
  it("reads the mnemonic through the HIDDEN prompt and never echoes it", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo({ secrets: [PASSPHRASE, PASSPHRASE, MNEMONIC] });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      restore: true,
    });

    expect(result.action).toBe("restored");
    // restore() is born backup-confirmed: typing the words IS the proof.
    expect(result.backupConfirmed).toBe(true);
    expect(backend.restoreCalls).toHaveLength(1);
    expect(backend.restoreCalls[0]).toMatchObject({ dataDir: DATA_DIR, passphrase: PASSPHRASE, mnemonic: MNEMONIC });
    expect(backend.createCalls).toHaveLength(0);
    expect(backend.wallets.every((w) => w.closed === 1)).toBe(true);
    const printed = output.join("\n");
    expect(printed).not.toContain(WORDS[0]!);
    expect(printed).not.toContain(PASSPHRASE);
  });

  it("advises clearing the scrollback when a GENERATED passphrase was displayed", async () => {
    const backend = new FakeBackend();
    const generated = "Generated-Restore-Passphrase-1";
    const { io, output } = scriptedIo({ secrets: ["", MNEMONIC], answers: ["saved"] });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      restore: true,
      generatePassphrase: () => generated,
    });
    expect(backend.restoreCalls[0]?.passphrase).toBe(generated);
    expect(result.configBlock).not.toContain(generated);
    expect(output.join("\n")).toMatch(/scrollback/i);
  });

  it("does NOT nag about the scrollback when nothing was displayed", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo({ secrets: [PASSPHRASE, PASSPHRASE, MNEMONIC] });
    await runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {}, restore: true });
    expect(output.join("\n")).not.toMatch(/scrollback/i);
  });

  it("refuses an empty mnemonic without writing anything", async () => {
    const backend = new FakeBackend();
    const { io } = scriptedIo({ secrets: [PASSPHRASE, PASSPHRASE, "   "] });
    await expect(
      runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {}, restore: true }),
    ).rejects.toMatchObject({ code: "INVALID_MNEMONIC" });
    expect(backend.restoreCalls).toHaveLength(0);
  });

  it("warns that restoring over an existing wallet re-encrypts it", async () => {
    const backend = new FakeBackend({ backupConfirmed: true, mnemonic: MNEMONIC });
    const { io, output } = scriptedIo({ secrets: [PASSPHRASE, PASSPHRASE, MNEMONIC] });
    await runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {}, restore: true });
    expect(output.join("\n")).toContain("DESCRIPTOR_MISMATCH");
  });
});

describe("the printed config block", () => {
  it("is valid JSON with placeholders for both secrets", () => {
    const block = JSON.parse(renderWalletMcpConfigBlock({ dataDir: DATA_DIR })) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const entry = block.mcpServers.depix!;
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", DEFAULT_MCP_PACKAGE]);
    expect(entry.env.DEPIX_WALLET_PASSPHRASE).toBe(PASSPHRASE_PLACEHOLDER);
    expect(entry.env.DEPIX_API_KEY).toMatch(/sk_test_/);
    expect(entry.env.DEPIX_WALLET_DIR).toBe(DATA_DIR);
  });

  it("is parameterized by package name and server key (the unified bin owns them)", () => {
    const block = JSON.parse(
      renderWalletMcpConfigBlock({ dataDir: DATA_DIR, packageName: "@acme/mcp", serverKey: "acme" }),
    ) as { mcpServers: Record<string, { args: string[] }> };
    expect(block.mcpServers.acme!.args).toEqual(["-y", "@acme/mcp"]);
    expect(block.mcpServers.depix).toBeUndefined();
  });
});

describe("hidden-prompt input sanitizing (raw-mode reader)", () => {
  // The reader itself needs a PTY, so the sanitizer it depends on is tested
  // directly: a per-char `ch < " "` filter is NOT enough, because only the ESC
  // of an escape sequence is a control character — the rest is printable and
  // would land in the passphrase.
  const ESC = String.fromCharCode(27);

  it("drops arrow keys instead of appending their letters", () => {
    expect(stripTerminalControlSequences(`pass${ESC}[Aword`)).toBe("password");
    expect(stripTerminalControlSequences(`${ESC}[D${ESC}[Csecret`)).toBe("secret");
  });

  it("drops SS3 (application-cursor) arrows", () => {
    expect(stripTerminalControlSequences(`${ESC}OAsecret`)).toBe("secret");
  });

  it("drops the bracketed-paste markers wrapping a pasted mnemonic", () => {
    expect(stripTerminalControlSequences(`${ESC}[200~abandon ability able${ESC}[201~`)).toBe(
      "abandon ability able",
    );
  });

  it("leaves ordinary passphrase text — including non-ASCII — untouched", () => {
    expect(stripTerminalControlSequences("correct-horse-battery-staple")).toBe(
      "correct-horse-battery-staple",
    );
    expect(stripTerminalControlSequences("senhor-café-24")).toBe("senhor-café-24");
  });
});

describe("helpers", () => {
  it("generates a passphrase well above the engine's 12-char floor", () => {
    const a = generateStrongPassphrase();
    const b = generateStrongPassphrase();
    expect(a).not.toBe(b);
    expect(a.replace(/-/g, "").length).toBe(24);
    // Look-alike-free alphabet: no 0/O/1/l/I to mistype into a config file.
    expect(a).toMatch(/^[a-zA-Z2-9-]+$/);
    expect(a).not.toMatch(/[01lIO]/);
  });

  it("reports only the shared-terminal markers actually set", () => {
    expect(detectSharedTerminalMarkers({})).toEqual([]);
    expect(detectSharedTerminalMarkers({ TMUX: "", STY: "1" })).toEqual(["STY"]);
    expect(detectSharedTerminalMarkers({ TMUX: "x", SSH_TTY: "/dev/ttys001" })).toEqual(["TMUX", "SSH_TTY"]);
  });
});
