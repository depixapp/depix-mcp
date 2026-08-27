// Boot-time unlock precedence (spec §3.7 #8): DepixWallet.open() resolves the
// passphrase option → $DEPIX_WALLET_PASSPHRASE → the OS-keychain unlock key. The
// keychain is faked (in-memory), so this runs with no real OS store.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeUnlockKey, type CommandRunner, type UnlockStoreDeps } from "../../src/wallet-engine/store/unlock-store.js";
import { DepixWallet } from "../../src/wallet-engine/wallet.js";
import { isDepixSdkError } from "../../src/wallet-engine/errors.js";

const PASSPHRASE = "correct-horse-battery-staple";

/** A shared in-memory keychain (round-trips base64 exactly). */
function fakeUnlock(): Partial<UnlockStoreDeps> {
  const vault = new Map<string, string>();
  const run: CommandRunner = async (_command, args, input) => {
    const acct = args.indexOf("-a") >= 0 ? args[args.indexOf("-a") + 1]! : args[args.indexOf("account") + 1]!;
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

let dataDir: string;
const opened: DepixWallet[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "depix-unlock-"));
  const created = await DepixWallet.create({ dataDir, passphrase: PASSPHRASE });
  await created.wallet.close();
});

afterEach(async () => {
  for (const w of opened.splice(0)) await w.close().catch(() => {});
  delete process.env.DEPIX_WALLET_PASSPHRASE;
  await rm(dataDir, { recursive: true, force: true });
});

describe("DepixWallet.open — unlock precedence (§3.7 #8)", () => {
  it("opens from the OS keychain when no option/env passphrase is set", async () => {
    const unlock = fakeUnlock();
    await storeUnlockKey(dataDir, PASSPHRASE, unlock);
    const wallet = await DepixWallet.open({
      dataDir,
      unlock,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    opened.push(wallet);
    expect(await wallet.exportMnemonic()).toMatch(/^\w+( \w+){11}$/);
  });

  it("lets $DEPIX_WALLET_PASSPHRASE WIN over a (wrong) keychain value — the CI override still works", async () => {
    const unlock = fakeUnlock();
    await storeUnlockKey(dataDir, "the-wrong-passphrase", unlock);
    process.env.DEPIX_WALLET_PASSPHRASE = PASSPHRASE;
    // If the keychain were consulted first, this would be WRONG_PASSPHRASE.
    const wallet = await DepixWallet.open({
      dataDir,
      unlock,
      resumePendingWithdrawalsOnOpen: false,
      resumePendingConversionsOnOpen: false,
    });
    opened.push(wallet);
    // It opened at all: the env passphrase decrypted the seed. A consulted-first
    // keychain would have raised WRONG_PASSPHRASE on the wrong value.
    expect(await wallet.exportMnemonic()).toMatch(/^\w+( \w+){11}$/);
  });

  it("stays locked (WEAK_PASSPHRASE, naming the env) when neither env nor keychain has a key", async () => {
    const unlock = fakeUnlock(); // empty vault, no env
    await expect(
      DepixWallet.open({ dataDir, unlock, resumePendingWithdrawalsOnOpen: false, resumePendingConversionsOnOpen: false }),
    ).rejects.toSatisfy((err: unknown) => isDepixSdkError(err, "WEAK_PASSPHRASE"));
  });
});
