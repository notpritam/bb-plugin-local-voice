import { describe, expect, it } from "vitest";
import type { UsageRow } from "./store";
import { buildUsageReport, wpmTopPercent } from "./usage";

const NOW = new Date(Date.UTC(2026, 8, 15, 12, 0, 0)); // Tue 15 Sep 2026
const day = (offset: number) => new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
const row = (o: Partial<UsageRow> & { day: string }): UsageRow => ({
  at: Date.parse(`${o.day}T09:00:00Z`), surface: "composer", language: "English", durationMs: 60_000,
  rawWords: 150, words: 140, fixes: 10, fillers: 3, translated: false, category: null, ...o,
});

describe("wpmTopPercent", () => {
  it("maps wpm to the reference band", () => {
    expect(wpmTopPercent(70)).toBe(90);
    expect(wpmTopPercent(125)).toBe(30);
    expect(wpmTopPercent(190)).toBe(1);
  });
});

describe("buildUsageReport", () => {
  it("returns zeros for no rows", () => {
    const report = buildUsageReport([], NOW, 0);
    expect(report.totals).toEqual({ words: 0, clips: 0, durationMs: 0, books: 0 });
    expect(report.wpm).toEqual({ value: null, topPercent: null });
    expect(report.streak).toEqual({ current: 0, longest: 0 });
    expect(report.peak).toBeNull();
    expect(report.heatmap.days).toHaveLength(24 * 7);
  });
  it("totals, month delta, wpm, fixes", () => {
    const rows = [row({ day: "2026-08-20", words: 1000 }), row({ day: "2026-09-10", words: 1500 }), row({ day: day(0), words: 500, translated: true, fixes: 0 })];
    const report = buildUsageReport(rows, NOW, 0);
    expect(report.totals.words).toBe(3000);
    expect(report.totals.books).toBe(0);
    expect(report.month).toEqual({ words: 2000, previousWords: 1000, deltaPct: 100 });
    expect(report.wpm.value).toBe(150); // 450 raw words over 3 min
    expect(report.fixes).toEqual({ edits: 20, fillers: 9, translated: 1 });
  });
  it("streaks: today counts, an empty today falls back to yesterday, gaps break", () => {
    const rows = [row({ day: day(0) }), row({ day: day(1) }), row({ day: day(2) }), row({ day: day(5) }), row({ day: day(6) }), row({ day: day(7) }), row({ day: day(8) })];
    expect(buildUsageReport(rows, NOW, 0).streak).toEqual({ current: 3, longest: 4 });
    expect(buildUsageReport(rows.slice(1), NOW, 0).streak.current).toBe(2);
  });
  it("surfaces, categories and languages shares; peak weekday/hour", () => {
    const rows = [row({ day: day(0), surface: "composer", category: "prompt", language: "English" }), row({ day: day(0), surface: "field", category: "note", language: "Hindi" }), row({ day: day(1), surface: "composer", category: null, language: "English" })];
    const report = buildUsageReport(rows, NOW, 0);
    expect(report.surfaces.find((s) => s.key === "composer")).toMatchObject({ clips: 2, share: 67 });
    expect(report.categories.find((c) => c.key === "other")).toMatchObject({ clips: 1 });
    expect(report.languages[0]).toMatchObject({ language: "English", clips: 2 });
    expect(report.peak).toMatchObject({ hour: 9 });
  });
  it("heatmap levels bucket non-zero days", () => {
    const rows = [row({ day: day(0), words: 10 }), row({ day: day(1), words: 1000 }), row({ day: day(2), words: 500 })];
    const days = buildUsageReport(rows, NOW, 0).heatmap.days;
    const byDay = new Map(days.map((d) => [d.day, d]));
    expect(byDay.get(day(1))!.level).toBe(4);
    expect(byDay.get(day(0))!.level).toBeGreaterThanOrEqual(1);
    expect(byDay.get(day(3))!.level).toBe(0);
  });
});
