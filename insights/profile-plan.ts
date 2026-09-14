import type { UsageReport } from "./usage.js";

/** First profile after this many words; then every REFRESH_WORDS more. */
export const FIRST_PROFILE_WORDS = 200;
export const REFRESH_WORDS = 2000;
export const SAMPLE_CLIPS = 150;
export const SAMPLE_CHARS = 8000;

export function wordsUntilNext(wordsTotal: number, wordsAt: number | null): number {
  const target = wordsAt === null ? FIRST_PROFILE_WORDS : wordsAt + REFRESH_WORDS;
  return Math.max(0, target - wordsTotal);
}

export function isProfileDue(wordsTotal: number, wordsAt: number | null): boolean {
  return wordsTotal > 0 && wordsUntilNext(wordsTotal, wordsAt) === 0;
}

/** Newest-first texts trimmed to the character budget. */
export function sampleTexts(texts: readonly string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const text of texts) {
    if (used + text.length > SAMPLE_CHARS) break;
    out.push(text);
    used += text.length;
  }
  return out;
}

export function statsSummary(report: UsageReport, topWords: readonly { word: string; count: number }[]): string {
  const lines = [
    `Total words dictated: ${report.totals.words} across ${report.totals.clips} clips.`,
    `Peak time: ${report.peak?.label ?? "unknown"}.`,
    `Where: ${report.surfaces.filter((s) => s.clips > 0).map((s) => `${s.label} ${s.share}%`).join(", ") || "n/a"}.`,
    `What: ${report.categories.filter((c) => c.clips > 0).map((c) => `${c.label} ${c.share}%`).join(", ") || "n/a"}.`,
    `Languages: ${report.languages.map((l) => `${l.language} ${l.share}%`).join(", ") || "n/a"}.`,
    `Most used words: ${topWords.map((w) => w.word).join(", ") || "n/a"}.`,
  ];
  return lines.join("\n");
}
