// The §1.5 DoD journey, over the REAL engine (no backend injected): a clean
// machine runs `init`, gets a wallet whose backup gate is open, and the config
// block it printed points at that dataDir. Then the second run reprints instead
// of failing, and a wallet whose ritual was abandoned is finished by re-running.
//
// Only the terminal is a double here: the io reads the words the ritual itself
// printed and answers the challenge, exactly as a human with the paper does.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWalletInit, type WalletInitIo } from "../../src/wallet-engine/mcp/init-flow.js";
import { DepixWallet } from "../../src/wallet-engine/wallet.js";
import { connectMountedWallet } from "./support/mcp.js";

const PASSPHRASE = "correct-horse-battery-staple";
const TTY = { stdin: true, stdout: true };

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
 * remembers the numbered words the ritual printed and types them back.
 * `failChallenge` makes it type garbage instead (the abandoned-ritual case).
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
      question: async (prompt) => {
        output.push(prompt);
        const challenge = /^Word #(\d+):/.exec(prompt);
        if (challenge) {
          if (opts.failChallenge) return "notthecorrectword";
          return words.get(Number(challenge[1])) ?? "";
        }
        if (/"continue"/.test(prompt)) return "continue";
        if (/"saved"/.test(prompt)) return "saved";
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

describe("init journey — real engine (§1.5 DoD)", () => {
  it("creates a usable, backup-confirmed wallet and releases the dataDir lock", async () => {
    const { io, output } = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE] });
    const result = await runWalletInit({ io, tty: TTY, dataDir, env: {} });

    expect(result.action).toBe("created");
    expect(result.backupConfirmed).toBe(true);
    expect(result.dataDir).toBe(dataDir);

    // The block it printed points at THIS wallet and carries no secret.
    const block = JSON.parse(result.configBlock) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(block.mcpServers.depix!.env.DEPIX_WALLET_DIR).toBe(dataDir);
    expect(result.configBlock).not.toContain(PASSPHRASE);
    expect(output.join("\n")).not.toContain(PASSPHRASE);

    // The lock was released: the MCP server the operator is about to start can
    // open the wallet, and the backup gate is open (a receive address exists).
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
    // working wallet_status over MCP — clean machine → init → paste → first call.
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

  it("creates into a dataDir that does not exist yet", async () => {
    // A clean machine has no ~/.depix-wallet at all: inspect() must report
    // "empty" instead of throwing ENOENT, and create() makes the tree.
    const fresh = join(dataDir, "nested", "never-created");
    const { io } = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE] });
    const result = await runWalletInit({ io, tty: TTY, dataDir: fresh, env: {} });
    expect(result.action).toBe("created");
    expect(result.backupConfirmed).toBe(true);

    const wallet = await DepixWallet.open({
      dataDir: fresh,
      passphrase: PASSPHRASE,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    openedWallets.push(wallet);
    expect(wallet.isBackupConfirmed()).toBe(true);
  });

  it("second run over the finished wallet just reprints the block", async () => {
    const first = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE] });
    const created = await runWalletInit({ io: first.io, tty: TTY, dataDir, env: {} });

    // No secrets queued: a reprint must not prompt for anything.
    const second = operatorIo({ secrets: [] });
    const again = await runWalletInit({ io: second.io, tty: TTY, dataDir, env: {} });

    expect(again.action).toBe("already_configured");
    expect(again.backupConfirmed).toBe(true);
    expect(again.configBlock).toBe(created.configBlock);
  });

  it("finishes a wallet whose ritual was abandoned (create() persisted the seed first)", async () => {
    const abandoned = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE], failChallenge: true });
    const firstRun = await runWalletInit({
      io: abandoned.io,
      tty: TTY,
      dataDir,
      env: {},
      ritual: { maxAttempts: 1 },
    });
    expect(firstRun.action).toBe("created");
    expect(firstRun.backupConfirmed).toBe(false);

    // The wallet EXISTS but is gated: this is the state fix #11 describes.
    const gated = await DepixWallet.open({
      dataDir,
      passphrase: PASSPHRASE,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    expect(gated.isBackupConfirmed()).toBe(false);
    await expect(gated.getReceiveAddress()).rejects.toMatchObject({ code: "BACKUP_REQUIRED" });
    await gated.close();

    // Re-running init picks up exactly there: one passphrase prompt, the ritual
    // again over the SAME seed, then confirmBackup.
    const rerun = operatorIo({ secrets: [PASSPHRASE] });
    const second = await runWalletInit({ io: rerun.io, tty: TTY, dataDir, env: {} });
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
    // Mint a mnemonic with the engine itself, in a throwaway dir.
    const sourceDir = await mkdtemp(join(tmpdir(), "depix-sdk-init-src-"));
    const created = await DepixWallet.create({ dataDir: sourceDir, passphrase: PASSPHRASE });
    const mnemonic = created.mnemonic;
    await created.wallet.close();
    await rm(sourceDir, { recursive: true, force: true });

    const { io, output } = operatorIo({ secrets: [PASSPHRASE, PASSPHRASE, mnemonic] });
    const result = await runWalletInit({ io, tty: TTY, dataDir, env: {}, restore: true });
    expect(result.action).toBe("restored");
    expect(result.backupConfirmed).toBe(true);
    // The words were typed, never displayed.
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
