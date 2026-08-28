// The owner session at rest. Same envelope as the sk_ credential store
// (AES-256-GCM under an Argon2id key) but its OWN file and its OWN AAD, so a
// sealed blob cannot be moved between the two slots and still decrypt.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCredentialStore } from "../src/wallet-engine/agent/credential-store.js";
import {
  OWNER_SESSION_FILE,
  OwnerSessionStore,
} from "../src/wallet-engine/agent/owner-session-store.js";

const PASS = "correct horse battery staple";
const ACCESS = "eyJhbGciOiJSUzI1NiJ9.PAYLOAD.OWNER-ACCESS-TOKEN-VALUE";
const REFRESH = "wos_refresh_TOKEN_VALUE";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "depix-owner-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("OwnerSessionStore", () => {
  it("round-trips the session", async () => {
    const store = new OwnerSessionStore({ dataDir: dir, passphrase: PASS });
    await store.save({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: 1_700_000_000_000,
      provider: "google",
      email: "dono@example.com",
    });
    expect(await store.load()).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: 1_700_000_000_000,
      provider: "google",
      email: "dono@example.com",
    });
  });

  it("holds NO plaintext token on disk — whole-string comparison", async () => {
    const store = new OwnerSessionStore({ dataDir: dir, passphrase: PASS });
    await store.save({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 1 });
    const raw = await readFile(join(dir, OWNER_SESSION_FILE), "utf8");
    expect(raw).not.toContain(ACCESS);
    expect(raw).not.toContain(REFRESH);
    // Not even the JWT's own header segment, which is constant and recognisable.
    expect(raw).not.toContain("eyJhbGciOiJSUzI1NiJ9");
  });

  it("the wrong passphrase fails the GCM tag instead of returning garbage", async () => {
    await new OwnerSessionStore({ dataDir: dir, passphrase: PASS }).save({
      accessToken: ACCESS,
      expiresAt: 1,
    });
    await expect(
      new OwnerSessionStore({ dataDir: dir, passphrase: "an entirely different one" }).load(),
    ).rejects.toMatchObject({ code: "owner_session_unreadable" });
  });

  it("a sealed sk_ credential blob cannot be swapped into the owner slot", async () => {
    // Different AAD, same passphrase: the tag must not verify.
    await new AgentCredentialStore({ dataDir: dir, passphrase: PASS }).save({
      testKey: "sk_test_A",
      active: "test",
    });
    const creds = JSON.parse(await readFile(join(dir, "agent-credentials.json"), "utf8"));
    await writeFile(
      join(dir, OWNER_SESSION_FILE),
      JSON.stringify({
        format: "depix-owner-session",
        version: 1,
        salt: creds.salt,
        secret: creds.secret,
      }),
    );
    await expect(new OwnerSessionStore({ dataDir: dir, passphrase: PASS }).load()).rejects.toMatchObject({
      code: "owner_session_unreadable",
    });
  });

  it("load() is null when nothing was ever stored", async () => {
    expect(await new OwnerSessionStore({ dataDir: dir, passphrase: PASS }).load()).toBeNull();
  });

  it("exists() reports the file WITHOUT the passphrase (so `account status` can run locked)", async () => {
    expect(await OwnerSessionStore.exists(dir)).toBe(false);
    await new OwnerSessionStore({ dataDir: dir, passphrase: PASS }).save({ accessToken: ACCESS, expiresAt: 1 });
    expect(await OwnerSessionStore.exists(dir)).toBe(true);
  });

  it("clear() removes the file and reports whether there was one", async () => {
    const store = new OwnerSessionStore({ dataDir: dir, passphrase: PASS });
    expect(await store.clear()).toBe(false);
    await store.save({ accessToken: ACCESS, expiresAt: 1 });
    expect(await store.clear()).toBe(true);
    expect(await OwnerSessionStore.exists(dir)).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("refuses a weak passphrase rather than sealing tokens under it", async () => {
    await expect(
      new OwnerSessionStore({ dataDir: dir, passphrase: "short" }).save({ accessToken: ACCESS, expiresAt: 1 }),
    ).rejects.toThrow();
  });

  it("a corrupted file is a typed error, not a silent empty session", async () => {
    await writeFile(join(dir, OWNER_SESSION_FILE), "{not json");
    await expect(new OwnerSessionStore({ dataDir: dir, passphrase: PASS }).load()).rejects.toMatchObject({
      code: "owner_session_corrupted",
    });
  });
});
