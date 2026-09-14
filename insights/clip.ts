import type { ClipSignal } from "../contract.js";
import { countWords, fillerCount, wordEdits } from "./text.js";

export type Surface = "composer" | "field" | "cli" | "other";
export type Engine = "llama" | "whisper";

export interface NewClip {
  at: number;
  day: string;
  surface: Surface;
  language: string | null;
  durationMs: number;
  rawText: string;
  text: string;
  rawWords: number;
  words: number;
  fixes: number;
  fillers: number;
  translated: boolean;
  polished: boolean;
  asrMs: number | null;
  polishMs: number | null;
  engine: Engine;
  model: string;
}

/** The dock names its clips `bb-dock.*`; bb's composer sends `recording.*`; the CLI sends the real file name. */
export function surfaceFor(filename: string): Surface {
  if (filename.startsWith("bb-dock.")) return "field";
  if (filename.startsWith("recording.")) return "composer";
  if (filename.trim() !== "") return "cli";
  return "other";
}

/** Calendar day in a fixed offset (default: this process's local zone). */
export function dayOf(ms: number, tzOffsetMinutes: number = -new Date(ms).getTimezoneOffset()): string {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function deriveClip(signal: ClipSignal, tzOffsetMinutes?: number): NewClip | null {
  const text = signal.text.trim();
  if (text === "") return null;
  return {
    at: signal.at,
    day: dayOf(signal.at, tzOffsetMinutes),
    surface: surfaceFor(signal.filename),
    language: signal.language,
    durationMs: signal.durationMs,
    rawText: signal.rawText,
    text,
    rawWords: countWords(signal.rawText),
    words: countWords(text),
    // A translation rewrites every word; only same-language polishing counts as fixes.
    fixes: signal.translated ? 0 : wordEdits(signal.rawText, text),
    fillers: fillerCount(signal.rawText),
    translated: signal.translated,
    polished: signal.polished,
    asrMs: signal.asrMs,
    polishMs: signal.polishMs,
    engine: signal.engine,
    model: signal.model,
  };
}
