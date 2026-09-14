import { describe, expect, it } from "vitest";
import { dayOf, deriveClip, surfaceFor } from "./clip";

const base = {
  at: Date.UTC(2026, 8, 15, 10, 0, 0), filename: "recording.webm", mimeType: "audio/webm", language: "English", durationMs: 6000,
  rawText: "um so we should refactor the the user service", text: "So we should refactor the user service.", polished: true, translated: false,
  asrMs: 900, polishMs: 400, engine: "llama" as const, model: "qwen3-asr",
};

describe("surfaceFor", () => {
  it("maps file names to surfaces", () => {
    expect(surfaceFor("bb-dock.webm")).toBe("field");
    expect(surfaceFor("recording.mp4")).toBe("composer");
    expect(surfaceFor("jfk.wav")).toBe("cli");
    expect(surfaceFor("")).toBe("other");
  });
});

describe("dayOf", () => {
  it("formats a local calendar day", () => {
    expect(dayOf(Date.UTC(2026, 8, 15, 23, 30), 0)).toBe("2026-09-15");
    expect(dayOf(Date.UTC(2026, 8, 15, 23, 30), 330)).toBe("2026-09-16"); // IST
  });
});

describe("deriveClip", () => {
  it("derives counts, fillers and edits", () => {
    const clip = deriveClip(base, 0)!;
    expect(clip).toMatchObject({ surface: "composer", day: "2026-09-15", rawWords: 9, words: 7, fillers: 1, fixes: 2, translated: false, polished: true });
  });
  it("zeroes fixes for translated clips and skips blank text", () => {
    expect(deriveClip({ ...base, language: "Hindi", translated: true, rawText: "यार कल", text: "Dude, yesterday" }, 0)!.fixes).toBe(0);
    expect(deriveClip({ ...base, text: "   " }, 0)).toBeNull();
  });
});
