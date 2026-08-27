// The wallet's unlock key, kept in the OS credential store (spec §3.7 #8).
//
// The passphrase encrypts the seed at rest; it must NEVER be written into an MCP
// host's config file (which gets synced, pasted into a chat, or committed). So
// `init` stores an unlock key — the passphrase itself — in the operating
// system's own password store, the same protected place a browser keeps
// passwords, and the wallet reads it there at boot. The host config carries no
// secret at all.
//
// HONEST SCOPE (spec §3.7): this closes the mundane leaks (a synced/pasted/
// committed config). It is NOT a wall against a malicious agent that already has
// a shell as the same OS user — that agent reaches this store too. The real wall
// is Safe Mode (its own spec); the durable defence is funding the wallet with
// only what you would be OK losing.
//
// Backends, in order of preference per platform:
//   - macOS  → `security`     (Keychain)
//   - Linux  → `secret-tool`  (libsecret / GNOME Keyring, KWallet, …)
//   - anything else, or a keychain that is absent/failing → a 0600 file under
//     the home dir, OUTSIDE any project or the wallet dir.
// A keychain that is unavailable NEVER fails init — it falls through to the file
// (§3.7: "nunca falhe o init por não achar keychain"). The secret never appears
// in an error, a log or a command that a `ps` peer could read beyond the argv a
// same-user attacker could already read anyway.

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { registerSecret } from "../logger.js";
import { ensureDir, writeFileDurable } from "./fs-util.js";

/** Keychain service/label the entries live under. */
export const UNLOCK_KEYCHAIN_SERVICE = "depix-wallet-mcp";
/** Home-dir directory for the 0600 file fallback — sibling to the wallet, never inside it. */
export const UNLOCK_FALLBACK_DIRNAME = ".depix-wallet-unlock";

/** Where an unlock key ended up (surfaced to the operator so they know the boot path). */
export type UnlockBackend = "keychain" | "file" | "unavailable";

export interface StoreUnlockResult {
  backend: UnlockBackend;
  /** For "keychain"/"file": a human name of the store. For "unavailable": why. */
  detail: string;
}

export interface CommandResult {
  /** Process exit code, or null when the binary could not be spawned at all. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a keychain CLI with args and optional stdin. NEVER shell-interpolated:
 * the secret travels as an argv element (macOS) or on stdin (Linux), so a
 * metacharacter in a passphrase is inert. Returns `{ code: null }` when the
 * binary is missing, rather than throwing — an absent keychain is a fall-through,
 * not a failure.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
) => Promise<CommandResult>;

/** The 0600-file fallback's filesystem, injected so the resolver is unit-testable. */
export interface UnlockFileBackend {
  read(path: string): Promise<string | undefined>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface UnlockStoreDeps {
  platform: NodeJS.Platform;
  home: string;
  run: CommandRunner;
  files: UnlockFileBackend;
}

const defaultRun: CommandRunner = async (command, args, input) => {
  const { spawn } = await import("node:child_process");
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    // ENOENT (binary not installed) resolves to code:null — the caller treats a
    // missing keychain as "use the file", never as an init-breaking error.
    child.on("error", () => resolve({ code: null, stdout, stderr }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
};

const defaultFiles: UnlockFileBackend = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
  async write(path, contents) {
    await ensureDir(join(path, ".."));
    await writeFileDurable(path, contents);
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};

function resolveDeps(deps?: Partial<UnlockStoreDeps>): UnlockStoreDeps {
  return {
    platform: deps?.platform ?? process.platform,
    home: deps?.home ?? homedir(),
    run: deps?.run ?? defaultRun,
    files: deps?.files ?? defaultFiles,
  };
}

/** The keychain "account" for a wallet dir — the dataDir path itself keeps wallets distinct. */
function accountFor(dataDir: string): string {
  return dataDir;
}

/**
 * A home dir the 0600 fallback may live under: an absolute path, never empty.
 * With no HOME/USERPROFILE `homedir()` returns "", which would make the fallback
 * path cwd-relative — possibly a project dir where the key could be committed.
 * When this is false the fallback is REFUSED (backend "unavailable"): better to
 * not persist the key than to persist it somewhere it could leak.
 */
function hasSafeHome(home: string): boolean {
  return home !== "" && isAbsolute(home);
}

/** 0600 fallback path: a per-dataDir file, named by a hash so the real path never leaks into it. */
export function fallbackFilePath(dataDir: string, home: string): string {
  const digest = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
  return join(home, UNLOCK_FALLBACK_DIRNAME, `${digest}.key`);
}

/**
 * Keychain argv for the current platform, or null when there is no keychain CLI
 * to try. Secrets are base64 so the value round-trips byte-for-byte (a raw `-w`
 * read strips a trailing newline; libsecret adds none — base64 sidesteps both).
 * Exported for the unit test: this path has no real keychain in CI.
 */
export function keychainCommand(
  platform: NodeJS.Platform,
  op: "store" | "read" | "delete",
  account: string,
  secretB64?: string,
): { command: string; args: string[]; input?: string } | null {
  if (platform === "darwin") {
    const svc = UNLOCK_KEYCHAIN_SERVICE;
    if (op === "store") {
      // -U updates in place if the entry already exists (a re-run is not an error).
      return { command: "security", args: ["add-generic-password", "-U", "-a", account, "-s", svc, "-w", secretB64 ?? ""] };
    }
    if (op === "read") {
      return { command: "security", args: ["find-generic-password", "-a", account, "-s", svc, "-w"] };
    }
    return { command: "security", args: ["delete-generic-password", "-a", account, "-s", svc] };
  }
  if (platform === "linux") {
    if (op === "store") {
      return {
        command: "secret-tool",
        args: ["store", "--label=DePix wallet unlock", "service", UNLOCK_KEYCHAIN_SERVICE, "account", account],
        input: secretB64 ?? "", // libsecret reads the secret from stdin — never argv
      };
    }
    if (op === "read") {
      return { command: "secret-tool", args: ["lookup", "service", UNLOCK_KEYCHAIN_SERVICE, "account", account] };
    }
    return { command: "secret-tool", args: ["clear", "service", UNLOCK_KEYCHAIN_SERVICE, "account", account] };
  }
  return null;
}

const enc = (secret: string): string => Buffer.from(secret, "utf8").toString("base64");
const dec = (b64: string): string => Buffer.from(b64.trim(), "base64").toString("utf8");

/**
 * Persist the unlock key. Tries the OS keychain first, then the 0600 file. Never
 * throws for a missing/failing keychain — it degrades to the file, and only
 * reports "unavailable" if even the file write fails (init then tells the
 * operator to fall back to DEPIX_WALLET_PASSPHRASE). The secret is registered
 * for redaction and never interpolated into any returned string.
 */
export async function storeUnlockKey(
  dataDir: string,
  secret: string,
  depsInput?: Partial<UnlockStoreDeps>,
): Promise<StoreUnlockResult> {
  registerSecret(secret);
  const deps = resolveDeps(depsInput);
  const account = accountFor(dataDir);
  const cmd = keychainCommand(deps.platform, "store", account, enc(secret));
  if (cmd) {
    const res = await deps.run(cmd.command, cmd.args, cmd.input);
    if (res.code === 0) {
      return { backend: "keychain", detail: keychainName(deps.platform) };
    }
    // code:null (no binary) or non-zero (locked/denied) → fall through to the file.
  }
  if (!hasSafeHome(deps.home)) {
    // No absolute home → a fallback path would be cwd-relative (possibly a
    // project dir). Refuse rather than persist the key somewhere it could leak.
    return {
      backend: "unavailable",
      detail: "no OS keychain and no absolute home dir for a fallback file — set DEPIX_WALLET_PASSPHRASE instead",
    };
  }
  try {
    await deps.files.write(fallbackFilePath(dataDir, deps.home), secret);
    return { backend: "file", detail: fallbackFilePath(dataDir, deps.home) };
  } catch {
    return {
      backend: "unavailable",
      detail: "no OS keychain and the fallback file could not be written",
    };
  }
}

/**
 * Read the unlock key: keychain first, then the 0600 file, then undefined. A
 * boot uses this AFTER an explicit passphrase (option/env) is absent — see
 * wallet.open(). Any failure is a silent "not here", never a throw: the caller
 * turns a genuine absence into the typed WALLET locked error with next_action.
 */
export async function readUnlockKey(
  dataDir: string,
  depsInput?: Partial<UnlockStoreDeps>,
): Promise<string | undefined> {
  const deps = resolveDeps(depsInput);
  const account = accountFor(dataDir);
  const cmd = keychainCommand(deps.platform, "read", account);
  if (cmd) {
    const res = await deps.run(cmd.command, cmd.args, cmd.input);
    if (res.code === 0 && res.stdout.trim() !== "") {
      const secret = dec(res.stdout);
      registerSecret(secret);
      return secret;
    }
  }
  if (hasSafeHome(deps.home)) {
    const fromFile = await deps.files.read(fallbackFilePath(dataDir, deps.home));
    if (fromFile !== undefined && fromFile !== "") {
      registerSecret(fromFile);
      return fromFile;
    }
  }
  return undefined;
}

/** Remove the unlock key from both backends (best effort; used by wipe paths). */
export async function deleteUnlockKey(dataDir: string, depsInput?: Partial<UnlockStoreDeps>): Promise<void> {
  const deps = resolveDeps(depsInput);
  const cmd = keychainCommand(deps.platform, "delete", accountFor(dataDir));
  if (cmd) await deps.run(cmd.command, cmd.args, cmd.input).catch(() => undefined);
  await deps.files.remove(fallbackFilePath(dataDir, deps.home)).catch(() => undefined);
}

function keychainName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "linux") return "the system keyring (libsecret)";
  return "the OS credential store";
}
