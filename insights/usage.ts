import type { Category } from "../contract.js";
import type { Surface } from "./clip.js";
import type { UsageRow } from "./store.js";

export interface Share {
  key: string;
  label: string;
  clips: number;
  share: number;
}
export interface UsageReport {
  totals: { words: number; clips: number; durationMs: number; books: number };
  month: { words: number; previousWords: number; deltaPct: number | null };
  wpm: { value: number | null; topPercent: number | null };
  fixes: { edits: number; fillers: number; translated: number };
  surfaces: Share[];
  categories: Share[];
  languages: { language: string; clips: number; share: number }[];
  streak: { current: number; longest: number };
  heatmap: { start: string; weeks: number; days: { day: string; words: number; level: number }[] };
  peak: { weekday: number; hour: number; label: string } | null;
  generatedAt: number;
}

const DAY_MS = 86_400_000;
const HEATMAP_WEEKS = 24;
const SURFACE_LABELS: Record<Surface, string> = {
  composer: "Agent prompts (composer)",
  field: "Other fields",
  cli: "CLI",
  other: "Other",
};
const CATEGORY_LABELS: Record<Category, string> = {
  prompt: "AI prompts",
  note: "Notes & plans",
  message: "Messages",
  code: "Code instructions",
  other: "Other",
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Reference band against typical speakers; decorative, like the app it imitates. */
export function wpmTopPercent(wpm: number): number {
  if (wpm < 80) return 90;
  if (wpm < 100) return 70;
  if (wpm < 120) return 50;
  if (wpm < 140) return 30;
  if (wpm < 160) return 10;
  if (wpm < 180) return 3;
  return 1;
}

function shifted(ms: number, tz: number): Date {
  return new Date(ms + tz * 60_000);
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
}
function shares<K extends string>(counts: Map<K, number>, labels: Record<K, string>, order: readonly K[], total: number): Share[] {
  return order.map((key) => {
    const clips = counts.get(key) ?? 0;
    return { key, label: labels[key], clips, share: total === 0 ? 0 : Math.round((clips / total) * 100) };
  });
}

export function buildUsageReport(rows: UsageRow[], now: Date, tzOffsetMinutes: number = -now.getTimezoneOffset()): UsageReport {
  const tz = tzOffsetMinutes;
  const today = isoDay(shifted(now.getTime(), tz));
  const thisMonth = today.slice(0, 7);
  const previousMonthDate = shifted(now.getTime(), tz);
  previousMonthDate.setUTCDate(1);
  previousMonthDate.setUTCMonth(previousMonthDate.getUTCMonth() - 1);
  const previousMonth = isoDay(previousMonthDate).slice(0, 7);

  const totals = { words: 0, clips: rows.length, durationMs: 0, books: 0 };
  const month = { words: 0, previousWords: 0, deltaPct: null as number | null };
  const fixes = { edits: 0, fillers: 0, translated: 0 };
  let recentRawWords = 0;
  let recentDuration = 0;
  const surfaceCounts = new Map<Surface, number>();
  const categoryCounts = new Map<Category, number>();
  const languageCounts = new Map<string, number>();
  const wordsByDay = new Map<string, number>();
  const peakBuckets = new Map<string, number>();
  const cutoff30 = now.getTime() - 30 * DAY_MS;

  for (const r of rows) {
    totals.words += r.words;
    totals.durationMs += r.durationMs;
    if (r.day.startsWith(thisMonth)) month.words += r.words;
    else if (r.day.startsWith(previousMonth)) month.previousWords += r.words;
    fixes.edits += r.fixes;
    fixes.fillers += r.fillers;
    if (r.translated) fixes.translated += 1;
    if (r.at >= cutoff30 && r.durationMs > 0) {
      recentRawWords += r.rawWords;
      recentDuration += r.durationMs;
    }
    surfaceCounts.set(r.surface, (surfaceCounts.get(r.surface) ?? 0) + 1);
    const category = r.category ?? "other";
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    const language = r.language ?? "Unknown";
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    wordsByDay.set(r.day, (wordsByDay.get(r.day) ?? 0) + r.words);
    const local = shifted(r.at, tz);
    const bucket = `${local.getUTCDay()}:${local.getUTCHours()}`;
    peakBuckets.set(bucket, (peakBuckets.get(bucket) ?? 0) + 1);
  }
  totals.books = Math.round((totals.words / 100_000) * 10) / 10;
  month.deltaPct = month.previousWords === 0 ? null : Math.round(((month.words - month.previousWords) / month.previousWords) * 100);
  const wpmValue = recentDuration > 0 ? Math.round(recentRawWords / (recentDuration / 60_000)) : null;

  // Streaks over calendar days with at least one clip.
  const days = [...wordsByDay.keys()].sort();
  const daySet = new Set(days);
  let current = 0;
  let cursor = daySet.has(today) ? today : addDays(today, -1);
  while (daySet.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const d of days) {
    run = previous !== null && addDays(previous, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = d;
  }

  // Heatmap: 24 weeks ending this week, weeks start on Sunday; levels are quartiles of non-zero days.
  const todayDate = new Date(Date.parse(`${today}T00:00:00Z`));
  const weekStart = addDays(today, -todayDate.getUTCDay());
  const start = addDays(weekStart, -(HEATMAP_WEEKS - 1) * 7);
  const nonZero = days
    .map((d) => wordsByDay.get(d)!)
    .filter((w) => w > 0)
    .sort((a, b) => a - b);
  const quantile = (q: number) => (nonZero.length === 0 ? 0 : nonZero[Math.min(nonZero.length - 1, Math.floor(q * nonZero.length))]!);
  const q1 = quantile(0.25);
  const q2 = quantile(0.5);
  const q3 = quantile(0.75);
  const level = (w: number) => (w === 0 ? 0 : w <= q1 ? 1 : w <= q2 ? 2 : w < q3 ? 3 : 4);
  const heatDays: UsageReport["heatmap"]["days"] = [];
  for (let i = 0; i < HEATMAP_WEEKS * 7; i += 1) {
    const d = addDays(start, i);
    const w = wordsByDay.get(d) ?? 0;
    heatDays.push({ day: d, words: w, level: level(w) });
  }

  let peak: UsageReport["peak"] = null;
  let best = 0;
  for (const [bucket, n] of peakBuckets) {
    if (n <= best) continue;
    best = n;
    const [wd, h] = bucket.split(":").map(Number) as [number, number];
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    peak = { weekday: wd, hour: h, label: `${WEEKDAYS[wd]} at ${hour12} ${h < 12 ? "a.m." : "p.m."}` };
  }

  const languages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, clips]) => ({ language, clips, share: Math.round((clips / rows.length) * 100) }));

  return {
    totals,
    month,
    wpm: { value: wpmValue, topPercent: wpmValue === null ? null : wpmTopPercent(wpmValue) },
    fixes,
    surfaces: shares(surfaceCounts, SURFACE_LABELS, ["composer", "field", "cli", "other"], rows.length),
    categories: shares(categoryCounts, CATEGORY_LABELS, ["prompt", "note", "message", "code", "other"], rows.length),
    languages,
    streak: { current, longest },
    heatmap: { start, weeks: HEATMAP_WEEKS, days: heatDays },
    peak,
    generatedAt: now.getTime(),
  };
}
