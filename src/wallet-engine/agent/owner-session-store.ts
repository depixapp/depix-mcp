// Encrypted at-rest store for the OPERATOR's own DePix login (`depix-mcp login`).
// Same envelope as AgentCredentialStore — AES-256-GCM under an Argon2id key
// derived from the passphrase and a per-store salt, written durably — but its
// OWN file and its OWN AAD, so a sealed blob cannot be moved between the two
// slots and still decrypt.
//
// TWO IDENTITIES, TWO FILES, ON PURPOSE: agent-credentials.json holds the sk_
// keys of the account the AGENT registered for itself; this file holds the
// human operator's session. Which of the two authenticates a request is decided
// by `depix-mcp account`, never by whichever file happened to be written last.

import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { AgentError } from "../errors.js";
import { defaultLogger, type Logger } from "../logger.js";
import { aesGcmDecrypt, aesGcmEncrypt, assertStrongPassphrase, deriveKey, randomIv, randomSalt } from "../store/crypto.js";
import { ensureDir, writeFileDurable } from "../store/fs-util.js";

export const OWNER_SESSION_FILE = "owner-session.json";

/** The operator's session. Every field is sealed — the email is PII. */
export interface OwnerSession {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms after which the access token must be refreshed. */
  expiresAt: number;
  /** "google" / "github" / whatever the operator signed in with. */
  provider?: string;
  email?: string;
}

interface OwnerSessionFileV1 {
  format: "depix-owner-session";
  version: 1;
  salt: string;
  secret: { iv: string; ct: string };
}

const AAD = utf8ToBytes("depix-owner-session");

export interface OwnerSessionStoreOptions {
  dataDir: string;
  passphrase: string;
  logger?: Logger;
}

export class OwnerSessionStore {
  private readonly dataDir: string;
  private readonly passphrase: string;
  private readonly logger: Logger;
  private readonly path: string;

  constructor(options: OwnerSessionStoreOptions) {
    this.dataDir = options.dataDir;
    this.passphrase = options.passphrase;
    this.logger = options.logger ?? defaultLogger;
    this.path = join(this.dataDir, OWNER_SESSION_FILE);
  }

  /** Is there a session on this machine? Answers WITHOUT the passphrase, so
   * `account status` still reports "signed in (locked)" with none configured. */
  static async exists(dataDir: string): Promise<boolean> {
    try {
      return (await stat(join(dataDir, OWNER_SESSION_FILE))).isFile();
    } catch {
      return false;
    }
  }

  private async readFileV1(): Promise<OwnerSessionFileV1 | null> {
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
      throw new AgentError("owner_session_corrupted", `Owner session file is not valid JSON: ${this.path}`, {
        cause: err,
      });
    }
    const file = parsed as OwnerSessionFileV1;
    if (file?.format !== "depix-owner-session" || file.version !== 1 || !file.secret?.ct) {
      throw new AgentError("owner_session_corrupted", `Owner session file has an unexpected shape: ${this.path}`);
    }
    return file;
  }

  /** Persist the session (fresh salt), overwriting any existing one. */
  async save(session: OwnerSession): Promise<void> {
    assertStrongPassphrase(this.passphrase);
    await ensureDir(this.dataDir);
    const salt = randomSalt();
    const iv = randomIv();
    const key = await deriveKey(this.passphrase, salt);
    const ct = await aesGcmEncrypt(utf8ToBytes(JSON.stringify(session)), key, iv, AAD);
    const file: OwnerSessionFileV1 = {
      format: "depix-owner-session",
      version: 1,
      salt: base64.encode(salt),
      secret: { iv: base64.encode(iv), ct: base64.encode(ct) },
    };
    await writeFileDurable(this.path, JSON.stringify(file));
    // Provider only: the email is PII and the tokens are the whole point.
    this.logger.debug("owner.session.saved", { provider: session.provider ?? null });
  }

  /** Load and decrypt the session, or null when none is stored. */
  async load(): Promise<OwnerSession | null> {
    const file = await this.readFileV1();
    if (!file) return null;
    const key = await deriveKey(this.passphrase, base64.decode(file.salt));
    let plaintext: Uint8Array;
    try {
      plaintext = await aesGcmDecrypt(base64.decode(file.secret.ct), key, base64.decode(file.secret.iv), AAD);
    } catch (err) {
      throw new AgentError(
        "owner_session_unreadable",
        "Could not decrypt the stored owner login: wrong passphrase or the file was tampered with.",
        { cause: err },
      );
    }
    return JSON.parse(new TextDecoder().decode(plaintext)) as OwnerSession;
  }

  /** Remove the session. Reports whether there was one (for `logout`'s wording). */
  async clear(): Promise<boolean> {
    const existed = await OwnerSessionStore.exists(this.dataDir);
    await rm(this.path, { force: true });
    if (existed) this.logger.debug("owner.session.cleared", {});
    return existed;
  }
}
