// The OS-keychain unlock key (spec §3.7 #8): stored so the passphrase never
// lands in a host config, resolved keychain → 0600 file → undefined, and never
// leaking the secret through an error or a command that echoes it.
//
// The `security`/`secret-tool` CLIs are faked (a Map-backed keychain) so the
// store/read round-trip is exercised byte-for-byte with no real keychain.

import { describe, expect, it } from "vitest";
import {
  fallbackFilePath,
  keychainCommand,
  readUnlockKey,
  storeUnlockKey,
  type CommandResult,
  type CommandRunner,
  type UnlockFileBackend,
} from "../../src/wallet-engine/store/unlock-store.js";

const DATA_DIR = "/home/tester/.depix-wallet";
const HOME = "/home/tester";

/** An in-memory 0600-file backend. */
function memFiles(seed: Record<string, string> = {}): UnlockFileBackend & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    read: async (p) => store.get(p),
    write: async (p, c) => void store.set(p, c),
    remove: async (p) => void store.delete(p),
  };
}

/**
 * A Map-backed keychain that mimics `security` (value in argv `-w`) and
 * `secret-tool` (value on stdin). Records every argv so a test can prove the
 * plaintext never travels as an argument on Linux.
 */
function fakeKeychain(): { run: CommandRunner; calls: { command: string; args: string[]; input?: string }[] } {
  const vault = new Map<string, string>();
  const calls: { command: string; args: string[]; input?: string }[] = [];
  const accountOf = (args: readonly string[]): string => {
    const i = args.indexOf("-a"); // security
    if (i >= 0) return args[i + 1]!;
    const j = args.indexOf("account"); // secret-tool
    return j >= 0 ? args[j + 1]! : "";
  };
  const run: CommandRunner = async (command, args, input) => {
    calls.push({ command, args: [...args], input });
    const account = accountOf(args);
    const empty: CommandResult = { code: null, stdout: "", stderr: "" };
    if (command === "security") {
      if (args[0] === "add-generic-password") {
        const w = args.indexOf("-w");
        vault.set(account, args[w + 1]!);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") {
        const v = vault.get(account);
        return v === undefined ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: `${v}\n`, stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        vault.delete(account);
        return { code: 0, stdout: "", stderr: "" };
      }
    }
    if (command === "secret-tool") {
      if (args[0] === "store") {
        vault.set(account, input ?? "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "lookup") {
        const v = vault.get(account);
        return v === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: v, stderr: "" };
      }
      if (args[0] === "clear") {
        vault.delete(account);
        return { code: 0, stdout: "", stderr: "" };
      }
    }
    return empty;
  };
  return { run, calls };
}

describe("keychainCommand", () => {
  it("builds macOS `security` argv with the base64 value in -w", () => {
    const cmd = keychainCommand("darwin", "store", DATA_DIR, "YmFzZTY0")!;
    expect(cmd.command).toBe("security");
    expect(cmd.args).toContain("add-generic-password");
    expect(cmd.args[cmd.args.indexOf("-w") + 1]).toBe("YmFzZTY0");
    expect(cmd.args[cmd.args.indexOf("-a") + 1]).toBe(DATA_DIR);
  });

  it("builds Linux `secret-tool` that reads the value from STDIN, never argv", () => {
    const cmd = keychainCommand("linux", "store", DATA_DIR, "YmFzZTY0")!;
    expect(cmd.command).toBe("secret-tool");
    expect(cmd.input).toBe("YmFzZTY0");
    expect(cmd.args).not.toContain("YmFzZTY0"); // the secret is on stdin, not an argument
  });

  it("has no keychain CLI for other platforms", () => {
    expect(keychainCommand("win32", "store", DATA_DIR, "x")).toBeNull();
  });
});

describe("storeUnlockKey + readUnlockKey round-trip", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`round-trips a secret EXACTLY through the ${platform} keychain (base64, trailing newline safe)`, async () => {
      const kc = fakeKeychain();
      const files = memFiles();
      const deps = { platform, home: HOME, run: kc.run, files };
      const secret = "correct horse battery staple\n"; // trailing newline would break a raw read
      const stored = await storeUnlockKey(DATA_DIR, secret, deps);
      expect(stored.backend).toBe("keychain");
      // Nothing was written to the file fallback when the keychain took it.
      expect(files.store.size).toBe(0);
      const read = await readUnlockKey(DATA_DIR, deps);
      expect(read).toBe(secret);
    });
  }

  it("on Linux, the plaintext passphrase never appears in any argv", async () => {
    const kc = fakeKeychain();
    const deps = { platform: "linux" as const, home: HOME, run: kc.run, files: memFiles() };
    const secret = "super-secret-passphrase";
    await storeUnlockKey(DATA_DIR, secret, deps);
    for (const call of kc.calls) {
      expect(call.args.join(" ")).not.toContain(secret);
    }
  });
});

describe("storeUnlockKey — degradation (never fails init)", () => {
  it("falls back to the 0600 file when there is no keychain CLI (e.g. win32)", async () => {
    const files = memFiles();
    const kc = fakeKeychain();
    const res = await storeUnlockKey(DATA_DIR, "a-passphrase", { platform: "win32", home: HOME, run: kc.run, files });
    expect(res.backend).toBe("file");
    expect(files.store.get(fallbackFilePath(DATA_DIR, HOME))).toBe("a-passphrase");
    // A win32 store never even tries the keychain.
    expect(kc.calls).toHaveLength(0);
  });

  it("falls back to the file when the keychain command fails (locked/denied)", async () => {
    const files = memFiles();
    const failing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "User interaction is not allowed." });
    const res = await storeUnlockKey(DATA_DIR, "pp", { platform: "darwin", home: HOME, run: failing, files });
    expect(res.backend).toBe("file");
    expect(files.store.get(fallbackFilePath(DATA_DIR, HOME))).toBe("pp");
  });

  it("reports 'unavailable' (and does NOT throw) when neither keychain nor file works", async () => {
    const throwing: UnlockFileBackend = {
      read: async () => undefined,
      write: async () => {
        throw new Error("read-only fs");
      },
      remove: async () => undefined,
    };
    const res = await storeUnlockKey(DATA_DIR, "pp", { platform: "win32", home: HOME, run: fakeKeychain().run, files: throwing });
    expect(res.backend).toBe("unavailable");
    // The reason is secret-free.
    expect(res.detail).not.toContain("pp");
  });
});

describe("readUnlockKey — precedence and absence", () => {
  it("prefers the keychain over the fallback file", async () => {
    const kc = fakeKeychain();
    const deps = { platform: "darwin" as const, home: HOME, run: kc.run, files: memFiles() };
    await storeUnlockKey(DATA_DIR, "from-keychain", deps);
    // A stale file value must lose to the keychain.
    deps.files.store.set(fallbackFilePath(DATA_DIR, HOME), "from-file");
    expect(await readUnlockKey(DATA_DIR, deps)).toBe("from-keychain");
  });

  it("reads the 0600 file when the keychain has nothing", async () => {
    const files = memFiles({ [fallbackFilePath(DATA_DIR, HOME)]: "file-secret" });
    const kc = fakeKeychain(); // empty vault
    expect(await readUnlockKey(DATA_DIR, { platform: "darwin", home: HOME, run: kc.run, files })).toBe("file-secret");
  });

  it("returns undefined when neither backend has a key (a locked wallet)", async () => {
    const kc = fakeKeychain();
    expect(await readUnlockKey(DATA_DIR, { platform: "linux", home: HOME, run: kc.run, files: memFiles() })).toBeUndefined();
  });
});
