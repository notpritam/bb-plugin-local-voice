import type Database from "better-sqlite3";
import type { Category } from "../contract.js";
import type { NewClip, Surface } from "./clip.js";
export type { NewClip } from "./clip.js";

export interface UsageRow {
  at: number;
  day: string;
  surface: Surface;
  language: string | null;
  durationMs: number;
  rawWords: number;
  words: number;
  fixes: number;
  fillers: number;
  translated: boolean;
  category: Category | null;
}

interface UsageDbRow {
  at: number; day: string; surface: Surface; language: string | null; duration_ms: number;
  raw_words: number; words: number; fixes: number; fillers: number; translated: number; category: Category | null;
}

export class InsightsStore {
  constructor(private readonly db: Database.Database) {}

  insertClip(clip: NewClip): number {
    const result = this.db
      .prepare(
        `INSERT INTO clips (at, day, surface, language, duration_ms, raw_text, text, raw_words, words, fixes, fillers, translated, polished, asr_ms, polish_ms, engine, model)
         VALUES (@at, @day, @surface, @language, @durationMs, @rawText, @text, @rawWords, @words, @fixes, @fillers, @translated, @polished, @asrMs, @polishMs, @engine, @model)`,
      )
      .run({ ...clip, translated: clip.translated ? 1 : 0, polished: clip.polished ? 1 : 0 });
    return Number(result.lastInsertRowid);
  }

  usageRows(): UsageRow[] {
    const rows = this.db
      .prepare(
        "SELECT at, day, surface, language, duration_ms, raw_words, words, fixes, fillers, translated, category FROM clips ORDER BY at ASC",
      )
      .all() as UsageDbRow[];
    return rows.map((r) => ({
      at: r.at,
      day: r.day,
      surface: r.surface,
      language: r.language,
      durationMs: r.duration_ms,
      rawWords: r.raw_words,
      words: r.words,
      fixes: r.fixes,
      fillers: r.fillers,
      translated: r.translated === 1,
      category: r.category,
    }));
  }

  uncategorized(limit: number): { id: number; text: string }[] {
    return this.db.prepare("SELECT id, text FROM clips WHERE category IS NULL ORDER BY at ASC LIMIT ?").all(limit) as {
      id: number;
      text: string;
    }[];
  }

  setCategory(id: number, category: Category): void {
    this.db.prepare("UPDATE clips SET category = ? WHERE id = ?").run(category, id);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM clips").get() as { n: number }).n;
  }

  clear(): void {
    this.db.exec("DELETE FROM clips; DELETE FROM profile;");
  }
}
