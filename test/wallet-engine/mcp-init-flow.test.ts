// The first-run ceremony v2 (unified-MCP spec §1.5 / §3.7): `npx -y @depixapp/mcp init`.
//
// What these tests pin, in the spec's own terms: it REFUSES without a TTY; it
// warns (and can be aborted) BEFORE the 12 words appear; the passphrase is never
// echoed and NEVER lands in the printed block (an OS-keychain unlock key holds it
// instead); there is NO API key in the block; spending limits + an allowlist are
// a step (§3.7 #1); the operator can connect an op_ token (§3.7 #7); the host is
// auto-registered (§3.7 #6); and the scrollback is cleared at the end (§3.7 #3).
//
// I/O, the wallet backend, the keychain and host detection are all injected, so
// the whole flow runs offline with no TTY, no LWK engine, no dataDir and no real
// keychain or `claude` CLI.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_PACKAGE,
  OPERATOR_OAUTH_START_URL,
  buildServerEnv,
  detectSharedTerminalMarkers,
  generateStrongPassphrase,
  parseAllowlistInput,
  parseBrlToCents,
  renderWalletMcpConfigBlock,
  runWalletInit,
  stripTerminalControlSequences,
  type InitWallet,
  type InitWalletBackend,
  type WalletInitIo,
  type WalletLimits,
} from "../../src/wallet-engine/mcp/init-flow.js";
import type { HostDetectDeps, HostRegisterEffects } from "../../src/wallet-engine/mcp/host-register.js";
import type { CommandRunner, UnlockStoreDeps } from "../../src/wallet-engine/store/unlock-store.js";
import type { CreateOptions, OpenOptions, RestoreOptions } from "../../src/wallet-engine/wallet.js";
import { WalletError } from "../../src/wallet-engine/errors.js";

const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const WORDS = MNEMONIC.split(" ");
const PASSPHRASE = "correct-horse-battery-staple";
const DATA_DIR = "/tmp/does-not-exist/.depix-wallet";
const CLEAR_MARK = "<<CLEAR>>";

const FIRST_POSITIONS = { random: () => 0 };
const NO_HOSTS: HostDetectDeps = { platform: "linux", home: "/tmp", env: {}, exists: () => false, hasCommand: () => false };

/** An in-memory keychain so storeUnlockKey reports "keychain" without spawning `security`. */
function fakeUnlock(): { deps: Partial<UnlockStoreDeps>; vault: Map<string, string> } {
  const vault = new Map<string, string>();
  const run: CommandRunner = async (command, args, input) => {
    const a = args.indexOf("-a");
    const acct = a >= 0 ? args[a + 1]! : args[args.indexOf("account") + 1]!;
    if (args[0] === "add-generic-password") {
      vault.set(acct, args[args.indexOf("-w") + 1]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "store") {
      vault.set(acct, input ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: null, stdout: "", stderr: "" };
  };
  return { deps: { platform: "darwin", home: "/tmp", run, files: memFiles() }, vault };
}

function memFiles() {
  const store = new Map<string, string>();
  return { read: async (p: string) => store.get(p), write: async (p: string, c: string) => void store.set(p, c), remove: async () => undefined };
}

/** Scripted terminal: `question`/`secret` pull from their queues; `clear` records a marker. */
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
      write: (text) => void output.push(text),
      question: async (prompt) => {
        output.push(prompt);
        return answers.shift() ?? "";
      },
      secret: async (prompt) => {
        output.push(prompt);
        if (secrets.length === 0) throw new Error("test script ran out of secrets");
        return secrets.shift()!;
      },
      clear: () => void output.push(CLEAR_MARK),
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
  state: { backupConfirmed: boolean; mnemonic: string } | null;
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

/** The prompt answers of the happy create path AFTER the seed-display "continue". */
const RITUAL_ANSWERS = ["", WORDS[0]!, WORDS[1]!, WORDS[2]!]; // pacing Enter + 3 challenged words
const LIMITS_DEFAULT_ANSWERS = ["", "", ""]; // per-tx, daily, allowlist — all default/empty
const OPERATOR_LATER = ["2"];

function createRun(over: Partial<Parameters<typeof runWalletInit>[0]> = {}) {
  const backend = new FakeBackend();
  const unlock = fakeUnlock();
  const io = scriptedIo({
    secrets: [PASSPHRASE, PASSPHRASE],
    answers: ["continue", ...RITUAL_ANSWERS, ...LIMITS_DEFAULT_ANSWERS, ...OPERATOR_LATER],
  });
  const run = runWalletInit({
    backend,
    io: io.io,
    tty: TTY,
    dataDir: DATA_DIR,
    env: {},
    ritual: FIRST_POSITIONS,
    unlock: unlock.deps,
    hostDetect: NO_HOSTS,
    ...over,
  });
  return { backend, unlock, io, run };
}

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
    expect(err.message).toContain("mnemonicSecured");
  });
});

describe("runWalletInit — create (§3.7)", () => {
  it("creates, runs the post-cleanup ritual, confirms the backup and closes the wallet", async () => {
    const { backend, io, run } = createRun();
    const result = await run;
    expect(result.action).toBe("created");
    expect(result.backupConfirmed).toBe(true);
    expect(backend.createCalls).toHaveLength(1);
    expect(backend.createCalls[0]).toMatchObject({ dataDir: DATA_DIR, passphrase: PASSPHRASE, interactive: false });
    expect(backend.state?.backupConfirmed).toBe(true);
    expect(backend.wallets.every((w) => w.closed === 1)).toBe(true);
    const printed = io.output.join("\n");
    for (const [idx, word] of WORDS.entries()) expect(printed).toContain(`${idx + 1}. ${word}`);
  });

  it("warns about a shared/recorded window BEFORE showing any word", async () => {
    const { io, run } = createRun();
    await run;
    const warningAt = io.output.findIndex((line) => /SHARED, RECORDED/.test(line));
    const firstWordAt = io.output.findIndex((line) => line.includes(`1. ${WORDS[0]!}`));
    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(firstWordAt).toBeGreaterThan(warningAt);
  });

  it("names the multiplexer/agent env markers it detected", async () => {
    const { io, run } = createRun({ env: { TMUX: "/tmp/tmux-501/default,123,0", CLAUDECODE: "1" } });
    await run;
    const printed = io.output.join("\n");
    expect(printed).toContain("TMUX");
    expect(printed).toContain("CLAUDECODE");
  });

  it("aborts at the warning WITHOUT creating anything", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo({ secrets: [PASSPHRASE, PASSPHRASE], answers: ["no"] });
    await expect(
      runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {}, hostDetect: NO_HOSTS, unlock: fakeUnlock().deps }),
    ).rejects.toMatchObject({ code: "INIT_ABORTED" });
    expect(backend.createCalls).toHaveLength(0);
    expect(output.join("\n")).not.toContain(WORDS[0]!);
  });

  it("keeps the passphrase and API key OUT of the block — only non-secret env remains", async () => {
    const { io, run } = createRun();
    const result = await run;
    const printed = io.output.join("\n");
    expect(printed).not.toContain(PASSPHRASE);
    expect(result.configBlock).not.toContain(PASSPHRASE);
    // The v2 block carries NO passphrase key and NO API key key at all.
    expect(result.configBlock).not.toContain("DEPIX_WALLET_PASSPHRASE");
    expect(result.configBlock).not.toContain("DEPIX_API_KEY");
    expect(JSON.stringify(result)).not.toContain(WORDS[0]!);
    expect(result.env.DEPIX_WALLET_DIR).toBe(DATA_DIR);
    expect(result.configBlock).toContain(DEFAULT_MCP_PACKAGE);
  });

  it("saves the unlock key in the keychain instead of a config file (§3.7 #8)", async () => {
    const { unlock, run } = createRun();
    const result = await run;
    expect(result.unlock?.backend).toBe("keychain");
    // The passphrase is in the keychain vault (base64), not the config.
    expect([...unlock.vault.values()].some((v) => Buffer.from(v, "base64").toString("utf8") === PASSPHRASE)).toBe(true);
  });

  it("captures default limits into the guardrail env (§3.7 #1)", async () => {
    const { run } = createRun();
    const result = await run;
    expect(result.limits).toEqual<WalletLimits>({
      perTxBrlCents: 10_000,
      dailyBrlCents: 50_000,
      allowlistLiquidAddresses: [],
    });
    expect(result.env.DEPIX_GUARDRAIL_PER_TX_BRL_CENTS).toBe("10000");
    expect(result.env.DEPIX_GUARDRAIL_DAILY_BRL_CENTS).toBe("50000");
    expect(result.env.DEPIX_GUARDRAIL_ALLOWLIST).toBeUndefined();
  });

  it("parses custom limits + an allowlist into the env", async () => {
    const { run } = createRun({
      io: scriptedIo({
        secrets: [PASSPHRASE, PASSPHRASE],
        answers: ["continue", ...RITUAL_ANSWERS, "250", "1000", "lq1aaa, lq1bbb", "2"],
      }).io,
    });
    const result = await run;
    expect(result.limits).toMatchObject({ perTxBrlCents: 25_000, dailyBrlCents: 100_000 });
    expect(result.limits?.allowlistLiquidAddresses).toEqual(["lq1aaa", "lq1bbb"]);
    const allow = JSON.parse(result.env.DEPIX_GUARDRAIL_ALLOWLIST!) as { enabled: boolean; liquidAddresses: string[] };
    expect(allow).toEqual({ enabled: true, liquidAddresses: ["lq1aaa", "lq1bbb"] });
  });

  it("connects the operator token when the operator chooses [1] (§3.7 #7)", async () => {
    const { run } = createRun({
      io: scriptedIo({
        secrets: [PASSPHRASE, PASSPHRASE],
        answers: ["continue", ...RITUAL_ANSWERS, "", "", "", "1", "op_live_abc"],
      }).io,
    });
    const result = await run;
    expect(result.operatorConnected).toBe(true);
    expect(result.env.DEPIX_OPERATOR_TOKEN).toBe("op_live_abc");
  });

  it("leaves the operator token out when [2] later is chosen, and names the OAuth URL", async () => {
    const { io, run } = createRun();
    const result = await run;
    expect(result.operatorConnected).toBe(false);
    expect(result.env.DEPIX_OPERATOR_TOKEN).toBeUndefined();
    expect(io.output.join("\n")).toContain(OPERATOR_OAUTH_START_URL);
  });

  it("clears the scrollback at the end and warns about residual history (§3.7 #3)", async () => {
    const { io, run } = createRun();
    await run;
    // Two clears happen: one inside the ritual, one at the end.
    expect(io.output.filter((l) => l === CLEAR_MARK).length).toBeGreaterThanOrEqual(2);
    expect(io.output.join("\n")).toMatch(/scrollback/i);
  });

  it("tells the operator to create the account through the assistant — no API key pasted", async () => {
    const { io, run } = createRun();
    await run;
    const printed = io.output.join("\n");
    expect(printed).toMatch(/create your DePix account/i);
    // The rite states plainly that no API key is pasted (rather than asking for one).
    expect(printed).toMatch(/never paste an API key/i);
  });

  it("re-prompts on a too-short or mistyped passphrase", async () => {
    const { io, output, remaining } = scriptedIo({
      secrets: ["short", PASSPHRASE, "typo-here-not-the-same", PASSPHRASE, PASSPHRASE],
      answers: ["continue", ...RITUAL_ANSWERS, ...LIMITS_DEFAULT_ANSWERS, ...OPERATOR_LATER],
    });
    const backend = new FakeBackend();
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
      unlock: fakeUnlock().deps,
      hostDetect: NO_HOSTS,
    });
    expect(result.backupConfirmed).toBe(true);
    expect(backend.createCalls[0]?.passphrase).toBe(PASSPHRASE);
    expect(remaining().secrets).toBe(0);
    const printed = output.join("\n");
    expect(printed).toMatch(/at least 12 characters/i);
    expect(printed).toMatch(/differ/i);
  });

  it("offers to generate a passphrase, shows it ONCE and keeps it out of the block", async () => {
    const generated = "Test-Generated-Passphrase-1";
    const { io, output } = scriptedIo({
      secrets: [""],
      answers: ["saved", "continue", ...RITUAL_ANSWERS, ...LIMITS_DEFAULT_ANSWERS, ...OPERATOR_LATER],
    });
    const backend = new FakeBackend();
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
      generatePassphrase: () => generated,
      unlock: fakeUnlock().deps,
      hostDetect: NO_HOSTS,
    });
    expect(backend.createCalls[0]?.passphrase).toBe(generated);
    expect(output.filter((line) => line.includes(generated)).length).toBe(1);
    expect(result.configBlock).not.toContain(generated);
  });

  it("keeps the wallet when the ritual FAILS, and says how to finish it", async () => {
    const { io, output } = scriptedIo({
      secrets: [PASSPHRASE, PASSPHRASE],
      answers: ["continue", "", "wrongword", ...LIMITS_DEFAULT_ANSWERS, ...OPERATOR_LATER],
    });
    const backend = new FakeBackend();
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: { ...FIRST_POSITIONS, maxAttempts: 1 },
      unlock: fakeUnlock().deps,
      hostDetect: NO_HOSTS,
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

describe("runWalletInit — host auto-registration (§3.7 #6)", () => {
  it("registers with a detected host and does NOT print the block", async () => {
    const registered: string[] = [];
    const effects: HostRegisterEffects = {
      runCommand: async (_c, args) => {
        registered.push(args.join(" "));
        return { code: 0, stderr: "" };
      },
      readFile: async () => undefined,
      writeFile: async () => undefined,
    };
    const { run } = createRun({
      hostDetect: { ...NO_HOSTS, hasCommand: (c) => c === "claude" },
      hostEffects: effects,
      io: scriptedIo({
        secrets: [PASSPHRASE, PASSPHRASE],
        answers: ["continue", ...RITUAL_ANSWERS, ...LIMITS_DEFAULT_ANSWERS, "2", "y"], // "y" registers with the host
      }).io,
    });
    const result = await run;
    expect(result.registeredHosts).toEqual(["claude-code"]);
    expect(registered[0]).toContain("mcp add");
    // The block is still returned for the record, but it was not the fallback path.
    expect(result.configBlock).toContain(DEFAULT_MCP_PACKAGE);
  });

  it("prints the block when the operator declines the detected host", async () => {
    const backend = new FakeBackend();
    const io = scriptedIo({
      secrets: [PASSPHRASE, PASSPHRASE],
      answers: ["continue", ...RITUAL_ANSWERS, ...LIMITS_DEFAULT_ANSWERS, "2", "n"], // decline
    });
    const result = await runWalletInit({
      backend,
      io: io.io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
      unlock: fakeUnlock().deps,
      hostDetect: { ...NO_HOSTS, hasCommand: (c) => c === "claude" },
      hostEffects: {
        runCommand: async () => ({ code: 0, stderr: "" }),
        readFile: async () => undefined,
        writeFile: async () => undefined,
      },
    });
    expect(result.registeredHosts).toEqual([]);
    expect(io.output.join("\n")).toContain('"mcpServers"');
  });
});

describe("runWalletInit — second run (§1.5 fix #11)", () => {
  it("reprints a passphrase-free block when the wallet is there and CONFIRMED, prompting for nothing", async () => {
    const backend = new FakeBackend({ backupConfirmed: true, mnemonic: MNEMONIC });
    const { io, output } = scriptedIo();
    const result = await runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {}, hostDetect: NO_HOSTS });
    expect(result.action).toBe("already_configured");
    expect(result.backupConfirmed).toBe(true);
    expect(result.configBlock).not.toContain("DEPIX_WALLET_PASSPHRASE");
    expect(result.env.DEPIX_WALLET_DIR).toBe(DATA_DIR);
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
      answers: ["continue", ...RITUAL_ANSWERS, ...LIMITS_DEFAULT_ANSWERS, ...OPERATOR_LATER],
    });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
      unlock: fakeUnlock().deps,
      hostDetect: NO_HOSTS,
    });
    expect(result.action).toBe("backup_ritual_rerun");
    expect(result.backupConfirmed).toBe(true);
    expect(state.backupConfirmed).toBe(true);
    expect(backend.createCalls).toHaveLength(0);
    expect(backend.openCalls).toHaveLength(1);
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

  it("re-prompts on a wrong passphrase before giving up", async () => {
    const state = { backupConfirmed: false, mnemonic: MNEMONIC };
    const backend = new FakeBackend(state);
    backend.openErrors = [new WalletError("WRONG_PASSPHRASE", "wrong passphrase")];
    const { io, output } = scriptedIo({
      secrets: ["not-the-passphrase", PASSPHRASE],
      answers: ["continue", ...RITUAL_ANSWERS, ...LIMITS_DEFAULT_ANSWERS, ...OPERATOR_LATER],
    });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      ritual: FIRST_POSITIONS,
      unlock: fakeUnlock().deps,
      hostDetect: NO_HOSTS,
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
      runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {}, hostDetect: NO_HOSTS, unlock: fakeUnlock().deps }),
    ).rejects.toMatchObject({ code: "DIR_LOCKED" });
  });
});

describe("runWalletInit — restore (§1.5)", () => {
  it("reads the mnemonic through the HIDDEN prompt and never echoes it", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo({
      secrets: [PASSPHRASE, PASSPHRASE, MNEMONIC],
      answers: [...LIMITS_DEFAULT_ANSWERS, ...OPERATOR_LATER],
    });
    const result = await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      restore: true,
      unlock: fakeUnlock().deps,
      hostDetect: NO_HOSTS,
    });
    expect(result.action).toBe("restored");
    expect(result.backupConfirmed).toBe(true);
    expect(backend.restoreCalls).toHaveLength(1);
    expect(backend.restoreCalls[0]).toMatchObject({ dataDir: DATA_DIR, passphrase: PASSPHRASE, mnemonic: MNEMONIC });
    expect(backend.createCalls).toHaveLength(0);
    expect(backend.wallets.every((w) => w.closed === 1)).toBe(true);
    const printed = output.join("\n");
    expect(printed).not.toContain(WORDS[0]!);
    expect(printed).not.toContain(PASSPHRASE);
  });

  it("does NOT clear the scrollback when nothing secret was displayed (typed passphrase restore)", async () => {
    const backend = new FakeBackend();
    const { io, output } = scriptedIo({
      secrets: [PASSPHRASE, PASSPHRASE, MNEMONIC],
      answers: [...LIMITS_DEFAULT_ANSWERS, ...OPERATOR_LATER],
    });
    await runWalletInit({
      backend,
      io,
      tty: TTY,
      dataDir: DATA_DIR,
      env: {},
      restore: true,
      unlock: fakeUnlock().deps,
      hostDetect: NO_HOSTS,
    });
    // A typed passphrase and a typed mnemonic mean no secret was on screen, so the
    // end-of-flow clear is skipped.
    expect(output).not.toContain(CLEAR_MARK);
  });

  it("refuses an empty mnemonic without writing anything", async () => {
    const backend = new FakeBackend();
    const { io } = scriptedIo({ secrets: [PASSPHRASE, PASSPHRASE, "   "] });
    await expect(
      runWalletInit({ backend, io, tty: TTY, dataDir: DATA_DIR, env: {}, restore: true, hostDetect: NO_HOSTS }),
    ).rejects.toMatchObject({ code: "INVALID_MNEMONIC" });
    expect(backend.restoreCalls).toHaveLength(0);
  });
});

describe("the non-secret config block + env builder", () => {
  it("renders a block from an env map with no secret fields", () => {
    const env = { DEPIX_WALLET_DIR: DATA_DIR, DEPIX_GUARDRAIL_PER_TX_BRL_CENTS: "10000" };
    const block = JSON.parse(renderWalletMcpConfigBlock({ env })) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const entry = block.mcpServers.depix!;
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", DEFAULT_MCP_PACKAGE]);
    expect(entry.env).toEqual(env);
    expect(JSON.stringify(entry.env)).not.toContain("PASSPHRASE");
    expect(JSON.stringify(entry.env)).not.toContain("API_KEY");
  });

  it("is parameterized by package name and server key", () => {
    const block = JSON.parse(
      renderWalletMcpConfigBlock({ packageName: "@acme/mcp", serverKey: "acme", env: {} }),
    ) as { mcpServers: Record<string, { args: string[] }> };
    expect(block.mcpServers.acme!.args).toEqual(["-y", "@acme/mcp"]);
    expect(block.mcpServers.depix).toBeUndefined();
  });

  it("buildServerEnv includes limits, an allowlist and an operator token only when set", () => {
    const limits: WalletLimits = { perTxBrlCents: 10_000, dailyBrlCents: 50_000, allowlistLiquidAddresses: [] };
    const bare = buildServerEnv({ dataDir: DATA_DIR, limits });
    expect(bare).toEqual({
      DEPIX_WALLET_DIR: DATA_DIR,
      DEPIX_GUARDRAIL_PER_TX_BRL_CENTS: "10000",
      DEPIX_GUARDRAIL_DAILY_BRL_CENTS: "50000",
    });
    const full = buildServerEnv({
      dataDir: DATA_DIR,
      limits: { ...limits, allowlistLiquidAddresses: ["lq1x"] },
      operatorToken: "op_1",
    });
    expect(JSON.parse(full.DEPIX_GUARDRAIL_ALLOWLIST!)).toEqual({ enabled: true, liquidAddresses: ["lq1x"] });
    expect(full.DEPIX_OPERATOR_TOKEN).toBe("op_1");
  });
});

describe("limit + allowlist parsing", () => {
  it("parses BRL amounts (reais) into cents, and rejects junk", () => {
    expect(parseBrlToCents("100")).toBe(10_000);
    expect(parseBrlToCents("100.50")).toBe(10_050);
    expect(parseBrlToCents("100,50")).toBe(10_050);
    expect(parseBrlToCents(" R$ 250 ")).toBe(25_000);
    expect(parseBrlToCents("")).toBeNull();
    expect(parseBrlToCents("abc")).toBeNull();
    expect(parseBrlToCents("0")).toBeNull();
    expect(parseBrlToCents("-5")).toBeNull();
    expect(parseBrlToCents("1.000,00")).toBeNull(); // ambiguous thousands separator
  });

  it("splits an allowlist on spaces/commas and de-duplicates", () => {
    expect(parseAllowlistInput("")).toEqual([]);
    expect(parseAllowlistInput("lq1a, lq1b lq1a")).toEqual(["lq1a", "lq1b"]);
  });
});

describe("hidden-prompt input sanitizing (raw-mode reader)", () => {
  const ESC = String.fromCharCode(27);
  it("drops arrow keys instead of appending their letters", () => {
    expect(stripTerminalControlSequences(`pass${ESC}[Aword`)).toBe("password");
    expect(stripTerminalControlSequences(`${ESC}[D${ESC}[Csecret`)).toBe("secret");
  });
  it("drops the bracketed-paste markers wrapping a pasted mnemonic", () => {
    expect(stripTerminalControlSequences(`${ESC}[200~abandon ability able${ESC}[201~`)).toBe("abandon ability able");
  });
  it("leaves ordinary passphrase text — including non-ASCII — untouched", () => {
    expect(stripTerminalControlSequences("senhor-café-24")).toBe("senhor-café-24");
  });
});

describe("helpers", () => {
  it("generates a passphrase well above the engine's 12-char floor", () => {
    const a = generateStrongPassphrase();
    expect(generateStrongPassphrase()).not.toBe(a);
    expect(a.replace(/-/g, "").length).toBe(24);
    expect(a).not.toMatch(/[01lIO]/);
  });

  it("reports only the shared-terminal markers actually set", () => {
    expect(detectSharedTerminalMarkers({})).toEqual([]);
    expect(detectSharedTerminalMarkers({ TMUX: "", STY: "1" })).toEqual(["STY"]);
    expect(detectSharedTerminalMarkers({ TMUX: "x", SSH_TTY: "/dev/ttys001" })).toEqual(["TMUX", "SSH_TTY"]);
  });
});
