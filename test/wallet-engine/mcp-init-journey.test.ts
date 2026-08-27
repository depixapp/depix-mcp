// The §1.5/§3.7 DoD journey, over the REAL engine (no backend injected): a clean
// machine runs `init`, gets a wallet whose backup gate is open, and the block it
// printed points at that dataDir with NO secret. Then the second run reprints
// instead of failing, and a wallet whose ritual was abandoned is finished by
// re-running.
//
// The keychain and host detection ARE stubbed (an in-memory keychain, no hosts)
// so the journey never writes to the real OS keychain or spawns `claude`. Only
// those and the terminal are doubles; the wallet, seed store and LWK are real.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWalletInit, type WalletInitIo } from "../../src/wallet-engine/mcp/init-flow.js";
import type { HostDetectDeps } from "../../src/wallet-engine/mcp/host-register.js";
import type { CommandRunner, UnlockStoreDeps } from "../../src/wallet-engine/store/unlock-store.js";
import { DepixWallet } from "../../src/wallet-engine/wallet.js";
import { connectMountedWallet } from "./support/mcp.js";

const PASSPHRASE = "correct-horse-battery-staple";
const TTY = { stdin: true, stdout: true };
const NO_HOSTS: HostDetectDeps = { platform: "linux", home: "/tmp", env: {}, exists: () => false, hasCommand: () => false };

/** An in-memory keychain so init never touches the real OS store. */
function fakeUnlock(): Partial<UnlockStoreDeps> {
  const vault = new Map<string, string>();
  const run: CommandRunner = async (_command, args, input) => {
    const a = args.indexOf("-a");
    const acct = a >= 0 ? args[a + 1]! : args[args.indexOf("account") + 1]!;
    if (args[0] === "add-generic-password" || args[0] === "store") {
      vault.set(acct, args[0] === "store" ? (input ?? "") : args[args.indexOf("-w") + 1]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      const v = vault.get(acct);
      return v === undefined ? { code: 44, stdout: "", stderr: "" } : { code: 0, stdout: `${v}\n`, stderr: "" };
    }
    return { code: null, stdout: "", stderr: "" };
  };
  const files = { read: async () => undefined, write: async () => undefined, remove: async () => undefined };
  return { platform: "darwin", home: "/tmp", run, files };
}

const SIDE_EFFECT_FREE = { hostDetect: NO_HOSTS };

let dataDir: string;
const openedWallets: DepixWallet[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-sdk-init-"));
});

afterEach(async () => {
  for (const w of openedWallets.splice(0)) await w.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * A terminal that behaves like an operator holding the paper backup: it
 * remembers the numbered words the ritual printed and types them back — AFTER the
 * screen clear, exactly as a human reading their paper. All other prompts take
 * their default (Enter). `failChallenge` types garbage (the abandoned-ritual case).
 */
function operatorIo(opts: { secrets: string[]; failChallenge?: boolean }): {
  io: WalletInitIo;
  output: string[];
} {
  const secrets = [...opts.secrets];
  const words = new Map<number, string>();
  const output: string[] = [];
  return {
    output,
    io: {
      write: (text) => {
        output.push(text);
        const m = /^\s*(\d{1,2})\.\s+([a-z]+)\s*$/.exec(text);
        if (m) words.set(Number(m[1]), m[2]!);
      },
      clear: () => output.push("<<CLEAR>>"),
      question: async (prompt) => {
        output.push(prompt);
        const challenge = /^Word #(\d+):/.exec(prompt);
        if (challenge) {
          if (opts.failChallenge) return "notthecorrectword";
          return words.get(Number(challenge[1])) ?? "";
        }
        if (/"continue"/.test(prompt)) return "continue";
        // Every other prompt (backup ack, limits, allowlist, operator connect)
        // takes its default.
        return "";
      },
      secret: async (prompt) => {
        output.push(prompt);
        if (secrets.length === 0) throw new Error("test io ran out of secrets");
        return secrets.shift()!;
      },
    },
  };
}

describe("init journey — real engine (§1.5/§3.7 DoD)", () => {
  it("creates a usable, backup-confirmed wallet and releases the dataDir lock", async () => {
    const { io, output } = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE] });
    const result = await runWalletInit({ io, tty: TTY, dataDir, env: {}, unlock: fakeUnlock(), ...SIDE_EFFECT_FREE });

    expect(result.action).toBe("created");
    expect(result.backupConfirmed).toBe(true);
    expect(result.dataDir).toBe(dataDir);
    expect(result.unlock?.backend).toBe("keychain");

    // The block it printed points at THIS wallet and carries no secret.
    const block = JSON.parse(result.configBlock) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(block.mcpServers.depix!.env.DEPIX_WALLET_DIR).toBe(dataDir);
    expect(result.configBlock).not.toContain(PASSPHRASE);
    expect(result.configBlock).not.toContain("DEPIX_WALLET_PASSPHRASE");
    expect(output.join("\n")).not.toContain(PASSPHRASE);

    // The lock was released and the backup gate is open (a receive address exists).
    const wallet = await DepixWallet.open({
      dataDir,
      passphrase: PASSPHRASE,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    openedWallets.push(wallet);
    expect(wallet.isBackupConfirmed()).toBe(true);
    expect(await wallet.getReceiveAddress()).toMatch(/^lq1/);

    // The seed is encrypted at rest — the mnemonic is nowhere in the file.
    const stored = await readFile(join(dataDir, "wallet.json"), "utf8");
    const mnemonic = await wallet.exportMnemonic();
    expect(stored).not.toContain(mnemonic.split(" ")[0]!);
    expect(output.join("\n")).toContain(mnemonic.split(" ")[0]!); // shown ONLY in the ritual

    // …and the LAST step of the DoD: the host started from that block reaches a
    // working wallet_status over MCP.
    const { client } = await connectMountedWallet({
      getWallet: () => wallet,
      apiKeyConfigured: true,
      keyMode: "test",
    });
    const status = await client.callTool({ name: "wallet_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    const out = (status as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(out.backup_confirmed).toBe(true);
    expect(out.mode).toBe("test");
  });

  it("stores an unlock key the wallet boots from with NO passphrase in env", async () => {
    // A shared in-memory keychain across init and the boot: init stores, boot reads.
    const unlock = fakeUnlock();
    const { io } = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE] });
    await runWalletInit({ io, tty: TTY, dataDir, env: {}, unlock, ...SIDE_EFFECT_FREE });

    // No DEPIX_WALLET_PASSPHRASE, no passphrase option — the keychain is the only
    // source, and open() finds it there (§3.7 #8).
    const wallet = await DepixWallet.open({
      dataDir,
      unlock,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    openedWallets.push(wallet);
    expect(wallet.isBackupConfirmed()).toBe(true);
    expect(await wallet.exportMnemonic()).toMatch(/^\w+( \w+){11}$/);
  });

  it("second run over the finished wallet reprints a passphrase-free block, prompting for nothing", async () => {
    const first = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE] });
    await runWalletInit({ io: first.io, tty: TTY, dataDir, env: {}, unlock: fakeUnlock(), ...SIDE_EFFECT_FREE });

    // No secrets queued: a reprint must not prompt for anything.
    const second = operatorIo({ secrets: [] });
    const again = await runWalletInit({ io: second.io, tty: TTY, dataDir, env: {}, ...SIDE_EFFECT_FREE });

    expect(again.action).toBe("already_configured");
    expect(again.backupConfirmed).toBe(true);
    expect(again.configBlock).not.toContain("DEPIX_WALLET_PASSPHRASE");
    expect(again.env.DEPIX_WALLET_DIR).toBe(dataDir);
  });

  it("finishes a wallet whose ritual was abandoned (create() persisted the seed first)", async () => {
    const abandoned = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE], failChallenge: true });
    const firstRun = await runWalletInit({
      io: abandoned.io,
      tty: TTY,
      dataDir,
      env: {},
      ritual: { maxAttempts: 1 },
      unlock: fakeUnlock(),
      ...SIDE_EFFECT_FREE,
    });
    expect(firstRun.action).toBe("created");
    expect(firstRun.backupConfirmed).toBe(false);

    const gated = await DepixWallet.open({
      dataDir,
      passphrase: PASSPHRASE,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    expect(gated.isBackupConfirmed()).toBe(false);
    await expect(gated.getReceiveAddress()).rejects.toMatchObject({ code: "BACKUP_REQUIRED" });
    await gated.close();

    const rerun = operatorIo({ secrets: [PASSPHRASE] });
    const second = await runWalletInit({ io: rerun.io, tty: TTY, dataDir, env: {}, unlock: fakeUnlock(), ...SIDE_EFFECT_FREE });
    expect(second.action).toBe("backup_ritual_rerun");
    expect(second.backupConfirmed).toBe(true);

    const wallet = await DepixWallet.open({
      dataDir,
      passphrase: PASSPHRASE,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    openedWallets.push(wallet);
    expect(wallet.isBackupConfirmed()).toBe(true);
    expect(await wallet.getReceiveAddress()).toMatch(/^lq1/);
  });

  it("--restore imports an existing mnemonic, born confirmed", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "depix-sdk-init-src-"));
    const created = await DepixWallet.create({ dataDir: sourceDir, passphrase: PASSPHRASE });
    const mnemonic = created.mnemonic;
    await created.wallet.close();
    await rm(sourceDir, { recursive: true, force: true });

    const { io, output } = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE, mnemonic] });
    const result = await runWalletInit({ io, tty: TTY, dataDir, env: {}, restore: true, unlock: fakeUnlock(), ...SIDE_EFFECT_FREE });
    expect(result.action).toBe("restored");
    expect(result.backupConfirmed).toBe(true);
    expect(output.join("\n")).not.toContain(mnemonic.split(" ")[0]!);

    const wallet = await DepixWallet.open({
      dataDir,
      passphrase: PASSPHRASE,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    openedWallets.push(wallet);
    expect(wallet.isBackupConfirmed()).toBe(true);
    expect(await wallet.exportMnemonic()).toBe(mnemonic);
  });
});
