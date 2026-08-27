// Interactive backup ritual (spec §2.9 / §3.7 #2 — post-cleanup positional quiz).
import { describe, expect, it } from "vitest";
import { runBackupRitual, type RitualIo } from "../../src/wallet-engine/backup-ritual.js";

const MNEMONIC =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";
const WORDS = MNEMONIC.split(" ");
const CLEAR_MARK = "<<CLEAR>>";

function scriptedIo(answers: string[]): { io: RitualIo; output: string[] } {
  const output: string[] = [];
  let i = 0;
  return {
    io: {
      write: (text) => {
        output.push(text);
      },
      question: async (prompt) => {
        output.push(prompt);
        return answers[i++] ?? "";
      },
      clear: () => {
        output.push(CLEAR_MARK);
      },
    },
    output,
  };
}

// Deterministic "random": always picks the lowest available positions.
const firstPositions = () => 0;
// The pacing answer for "written them down? Press Enter" (any input proceeds).
const ACK = "";

describe("runBackupRitual — post-cleanup positional quiz", () => {
  it("passes when the challenged words are answered after the screen is cleared", async () => {
    const { io, output } = scriptedIo([ACK, WORDS[0]!, WORDS[1]!, WORDS[2]!]);
    const ok = await runBackupRitual(MNEMONIC, io, { random: firstPositions });
    expect(ok).toBe(true);
    const printed = output.join("\n");
    for (const [idx, word] of WORDS.entries()) {
      expect(printed).toContain(`${idx + 1}. ${word}`);
    }
  });

  it("clears the screen BEFORE any word is challenged (the whole point of §3.7 #2)", async () => {
    const { io, output } = scriptedIo([ACK, WORDS[0]!, WORDS[1]!, WORDS[2]!]);
    await runBackupRitual(MNEMONIC, io, { random: firstPositions });
    const clearAt = output.indexOf(CLEAR_MARK);
    const firstChallengeAt = output.findIndex((l) => /^Word #\d+:/.test(l));
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(firstChallengeAt).toBeGreaterThan(clearAt);
    // No word list is re-printed AFTER the clear: the challenge answers cannot be
    // read off the screen.
    const afterClear = output.slice(clearAt + 1).join("\n");
    for (const word of WORDS) expect(afterClear).not.toContain(`. ${word}`);
  });

  it("shows all 12 words BEFORE the clear (so the operator can copy them)", async () => {
    const { io, output } = scriptedIo([ACK, WORDS[0]!, WORDS[1]!, WORDS[2]!]);
    await runBackupRitual(MNEMONIC, io, { random: firstPositions });
    const clearAt = output.indexOf(CLEAR_MARK);
    const beforeClear = output.slice(0, clearAt).join("\n");
    for (const [idx, word] of WORDS.entries()) expect(beforeClear).toContain(`${idx + 1}. ${word}`);
  });

  it("fails when a challenged word is wrong (after retries)", async () => {
    const wrongRound = ["wrongword", WORDS[1]!, WORDS[2]!];
    const { io } = scriptedIo([ACK, ...wrongRound, ...wrongRound, ...wrongRound]);
    const ok = await runBackupRitual(MNEMONIC, io, { random: firstPositions, maxAttempts: 3 });
    expect(ok).toBe(false);
  });

  it("accepts word answers case/whitespace-insensitively", async () => {
    const { io } = scriptedIo([ACK, ` ${WORDS[0]!.toUpperCase()} `, WORDS[1]!, WORDS[2]!]);
    const ok = await runBackupRitual(MNEMONIC, io, { random: firstPositions });
    expect(ok).toBe(true);
  });
});
