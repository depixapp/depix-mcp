// Encrypted at-rest store for the account's sk_ API keys (§3.1 / §9.2). Mirrors
// the AgentKeyStore/seed-store envelope: the key material is sealed with
// AES-256-GCM under a key derived (Argon2id) from the passphrase + a per-store
// salt, written durably (fsync). It is a SEPARATE file from the Ed25519 identity
// (agent-identity.json) and from the seed (wallet.json): the sk_ is neither the
// identity nor the seed, and never lands in either in plaintext.
//
// register_account writes the starter test + live keys here and marks which is
// active; on the next boot the resolver reads the active one back (given the
// passphrase) so the agent keeps using the account it created — no restart, no
// key pasted into a config.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { AgentError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { aesGcmDecrypt, aesGcmEncrypt, assertStrongPassphrase, deriveKey, randomIv, randomSalt } from "../store/crypto.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";

export const AGENT_CREDENTIALS_FILE = "agent-credentials.json";

/** Which minted key is the one requests use. */
export type ActiveKeyMode = "test" | "live";

/** The plaintext credentials held in memory / returned by load(). */
export interface AgentCredentials {
  /** sk_test_… starter key (sandbox). */
  testKey: string;
  /** sk_live_… starter key (production), when the account was issued one. */
  liveKey?: string;
  /** Which of the two the resolver should serve. */
  active: ActiveKeyMode;
}

interface CredentialsFileV1 {
  format: "depix-agent-credentials";
  version: 1;
  salt: string;
  active: ActiveKeyMode;
  /** Sealed JSON of { testKey, liveKey } — the active pointer stays plaintext. */
  secret: { iv: string; ct: string };
}

// AAD binds the ciphertext to this file's purpose so a sealed blob from another
// store cannot be swapped in and decrypt.
const AAD = utf8ToBytes("depix-agent-credentials");

export interface AgentCredentialStoreOptions {
  dataDir: string;
  passphrase: string;
  logger?: Logger;
}

export class AgentCredentialStore {
  private readonly dataDir: string;
  private readonly passphrase: string;
  private readonly logger: Logger;
  private readonly path: string;

  constructor(options: AgentCredentialStoreOptions) {
    this.dataDir = options.dataDir;
    this.passphrase = options.passphrase;
    this.logger = options.logger ?? defaultLogger;
    this.path = join(this.dataDir, AGENT_CREDENTIALS_FILE);
  }

  private async readFileV1(): Promise<CredentialsFileV1 | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AgentError("agent_store_corrupted", `Agent credentials file is not valid JSON: ${this.path}`, {
        cause: err,
      });
    }
    const file = parsed as CredentialsFileV1;
    if (file?.format !== "depix-agent-credentials" || file.version !== 1 || !file.secret?.ct) {
      throw new AgentError("agent_store_corrupted", `Agent credentials file has an unexpected shape: ${this.path}`);
    }
    return file;
  }

  /** Persist the credentials (fresh salt), overwriting any existing file. */
  async save(credentials: AgentCredentials): Promise<void> {
    assertStrongPassphrase(this.passphrase);
    await ensureDir(this.dataDir);
    const salt = randomSalt();
    const iv = randomIv();
    const key = await deriveKey(this.passphrase, salt);
    const plaintext = utf8ToBytes(JSON.stringify({ testKey: credentials.testKey, liveKey: credentials.liveKey ?? null }));
    const ct = await aesGcmEncrypt(plaintext, key, iv, AAD);
    const file: CredentialsFileV1 = {
      format: "depix-agent-credentials",
      version: 1,
      salt: base64.encode(salt),
      active: credentials.active,
      secret: { iv: base64.encode(iv), ct: base64.encode(ct) },
    };
    await writeFileDurable(this.path, JSON.stringify(file));
    this.logger.debug("agent.credentials.saved", { active: credentials.active });
  }

  /** Load and decrypt the credentials, or null when none are stored. */
  async load(): Promise<AgentCredentials | null> {
    const file = await this.readFileV1();
    if (!file) return null;
    const salt = base64.decode(file.salt);
    const key = await deriveKey(this.passphrase, salt);
    let plaintext: Uint8Array;
    try {
      plaintext = await aesGcmDecrypt(base64.decode(file.secret.ct), key, base64.decode(file.secret.iv), AAD);
    } catch (err) {
      throw new AgentError(
        "agent_key_unreadable",
        "Could not decrypt the stored API credentials: wrong passphrase or the file was tampered with.",
        { cause: err },
      );
    }
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as { testKey: string; liveKey: string | null };
    return {
      testKey: decoded.testKey,
      ...(decoded.liveKey ? { liveKey: decoded.liveKey } : {}),
      active: file.active,
    };
  }

  /** The key the `active` pointer selects, given loaded credentials. */
  static activeKey(credentials: AgentCredentials): string {
    return credentials.active === "live" && credentials.liveKey ? credentials.liveKey : credentials.testKey;
  }
}
