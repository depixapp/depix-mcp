// Interactive backup ritual (spec §2.9 / §3.7 #2 — TTY mode of create()).
//
// Print the 12 words, let the operator write them down, then CLEAR the screen
// (and scrollback) and challenge 2-3 of them at random positions. Clearing
// first is the whole point (§3.7 #2): re-typing words that are still on screen
// proves nothing — only an operator who actually copied them onto paper can
// answer once they are hidden. Only a fully passed challenge confirms the
// backup; any failure leaves the receive gate closed.
//
// I/O is injected so the ritual is unit-testable; create() wires it to readline
// on a real TTY. The words go to the interactive terminal — never through the
// logger (which would try to redact them anyway).

/** Clears the visible screen AND the scrollback, then homes the cursor. */
export const CLEAR_SCREEN_AND_SCROLLBACK = "\u001b[2J\u001b[3J\u001b[H";

export interface RitualIo {
  write(text: string): void;
  question(prompt: string): Promise<string>;
  /**
   * Wipe the screen and scrollback (the §3.7 #2 cleanup). A real TTY emits
   * CLEAR_SCREEN_AND_SCROLLBACK; some terminals ignore the 3J (scrollback) half,
   * so callers still print a residual-scrollback warning.
   */
  clear(): void;
}

export interface RitualOptions {
  /** Uniform [0,1) source — injectable for deterministic tests. */
  random?: () => number;
  /** Full challenge rounds before giving up. Default 3. */
  maxAttempts?: number;
  /** Number of word positions challenged. Default 3. */
  challengeCount?: number;
}

function normalizeAnswer(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Print the seed words, numbered and in order, and return them. The ONE place
 * that renders a mnemonic for a human: the first-run ritual below and the
 * `backup` command (mcp/backup-flow.ts) call it, so the operator reads the same
 * screen whichever door they came through, and a change to the warning copy
 * cannot reach one door and miss the other.
 */
export function displayMnemonic(mnemonic: string, io: Pick<RitualIo, "write">): string[] {
  const words = mnemonic.trim().split(/\s+/);
  io.write("");
  io.write("=== WALLET BACKUP — WRITE THESE 12 WORDS DOWN, IN ORDER ===");
  io.write("Anyone with these words controls the funds. Store them offline.");
  io.write("");
  for (const [idx, word] of words.entries()) {
    io.write(`  ${idx + 1}. ${word}`);
  }
  io.write("");
  return words;
}

function pickPositions(total: number, count: number, random: () => number): number[] {
  const available = Array.from({ length: total }, (_, i) => i);
  const picked: number[] = [];
  while (picked.length < count && available.length > 0) {
    const idx = Math.min(Math.floor(random() * available.length), available.length - 1);
    picked.push(available.splice(idx, 1)[0]!);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * Run the full ritual. Returns true only when, AFTER the words are cleared from
 * the screen, the operator answers the challenged positions from their paper
 * backup. The screen-clear is what makes the challenge meaningful (§3.7 #2).
 */
export async function runBackupRitual(
  mnemonic: string,
  io: RitualIo,
  options: RitualOptions = {}
): Promise<boolean> {
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? 3;
  const challengeCount = options.challengeCount ?? 3;
  const words = displayMnemonic(mnemonic, io);

  // The pacing gate: nothing is challenged while the words are still readable.
  // The prompt accepts any input — its only job is to wait for the operator to
  // finish copying before the screen is wiped.
  await io.question("Written them all down? Press Enter to HIDE them and prove it: ");
  io.clear();
  io.write("The 12 words are hidden now — answer from your paper backup, not the screen.");

  let challengePassed = false;
  for (let attempt = 0; attempt < maxAttempts && !challengePassed; attempt++) {
    const positions = pickPositions(words.length, challengeCount, random);
    challengePassed = true;
    for (const pos of positions) {
      const answer = await io.question(`Word #${pos + 1}: `);
      if (normalizeAnswer(answer) !== words[pos]) {
        io.write("That word does not match your backup. Check the paper and try again.");
        challengePassed = false;
        break;
      }
    }
  }
  if (!challengePassed) {
    io.write("Backup NOT confirmed. Receive addresses stay blocked until you run confirmBackup().");
    return false;
  }

  io.write("Backup confirmed.");
  return true;
}
