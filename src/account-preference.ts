// Which persona `depix-mcp account use` selected. A PREFERENCE, not a secret:
// it names an identity, it does not authenticate one, so it is plain JSON next
// to the wallet instead of a slot in the encrypted store. (0600 anyway — this
// file names the operator's choice, and nothing else on the machine needs it.)
//
// Anything unreadable — missing, truncated, hand-edited, an unknown persona —
// reads back as NO selection. A corrupt preference must degrade to the default
// precedence, never abort a boot over a file that holds no credential.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The two identities a local server can act as. */
export type Persona = "agent" | "owner";
export const PERSONAS: readonly Persona[] = ["agent", "owner"];

export const ACCOUNT_PREFERENCE_FILE = "account-preference.json";

function isPersona(value: unknown): value is Persona {
  return typeof value === "string" && (PERSONAS as readonly string[]).includes(value);
}

export async function readAccountPreference(dataDir: string): Promise<Persona | undefined> {
  let text: string;
  try {
    text = await readFile(join(dataDir, ACCOUNT_PREFERENCE_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { persona?: unknown };
    return isPersona(parsed.persona) ? parsed.persona : undefined;
  } catch {
    return undefined;
  }
}

export async function writeAccountPreference(dataDir: string, persona: Persona): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDir, ACCOUNT_PREFERENCE_FILE),
    JSON.stringify({ format: "depix-account-preference", version: 1, persona }),
    { mode: 0o600 },
  );
}

/** Back to the default precedence. A no-op when nothing was ever selected. */
export async function clearAccountPreference(dataDir: string): Promise<void> {
  await rm(join(dataDir, ACCOUNT_PREFERENCE_FILE), { force: true });
}
