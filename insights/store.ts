import type Database from "better-sqlite3";
import type { Category } from "../contract.js";
import type { NewClip, Surface } from "./clip.js";
import type { MemberTotal, ReportDay } from "./leaderboard.js";
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

export interface ProfileRow {
  generatedAt: number;
  wordsAt: number;
  title: string;
  description: string;
  catchphrase: string;
  peakTitle: string;
  peakDescription: string;
  mostUsedWord: string | null;
  mostCorrectedWord: string | null;
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

  totalWords(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(words), 0) AS n FROM clips").get() as { n: number }).n;
  }

  /** Newest first. */
  recentTexts(limit: number): string[] {
    return (this.db.prepare("SELECT text FROM clips ORDER BY at DESC LIMIT ?").all(limit) as { text: string }[]).map((r) => r.text);
  }

  /** Raw/polished pairs of same-language clips, newest first — translations are not corrections. */
  recentPairs(limit: number): { rawText: string; text: string }[] {
    return this.db
      .prepare("SELECT raw_text AS rawText, text FROM clips WHERE translated = 0 ORDER BY at DESC LIMIT ?")
      .all(limit) as { rawText: string; text: string }[];
  }

  getProfile(): ProfileRow | null {
    const row = this.db
      .prepare(
        "SELECT generated_at, words_at, title, description, catchphrase, peak_title, peak_description, most_used_word, most_corrected_word FROM profile WHERE id = 1",
      )
      .get() as
      | { generated_at: number; words_at: number; title: string; description: string; catchphrase: string; peak_title: string; peak_description: string; most_used_word: string | null; most_corrected_word: string | null }
      | undefined;
    if (row === undefined) return null;
    return {
      generatedAt: row.generated_at,
      wordsAt: row.words_at,
      title: row.title,
      description: row.description,
      catchphrase: row.catchphrase,
      peakTitle: row.peak_title,
      peakDescription: row.peak_description,
      mostUsedWord: row.most_used_word,
      mostCorrectedWord: row.most_corrected_word,
    };
  }

  setProfile(profile: ProfileRow): void {
    this.db
      .prepare(
        `INSERT INTO profile (id, generated_at, words_at, title, description, catchphrase, peak_title, peak_description, most_used_word, most_corrected_word)
         VALUES (1, @generatedAt, @wordsAt, @title, @description, @catchphrase, @peakTitle, @peakDescription, @mostUsedWord, @mostCorrectedWord)
         ON CONFLICT(id) DO UPDATE SET generated_at = excluded.generated_at, words_at = excluded.words_at, title = excluded.title,
           description = excluded.description, catchphrase = excluded.catchphrase, peak_title = excluded.peak_title,
           peak_description = excluded.peak_description, most_used_word = excluded.most_used_word, most_corrected_word = excluded.most_corrected_word`,
      )
      .run(profile);
  }

  dailyTotalsSince(day: string): ReportDay[] {
    return this.db
      .prepare("SELECT day, SUM(words) AS words, COUNT(*) AS clips FROM clips WHERE day >= ? GROUP BY day ORDER BY day ASC")
      .all(day) as ReportDay[];
  }

  // ---- leaderboard (public host side)
  lbJoin(m: { id: string; displayName: string; tokenHash: string; now: number; ipHash: string | null }): void {
    this.db
      .prepare("INSERT INTO lb_members (id, display_name, token_hash, created_at, last_seen, ip_hash) VALUES (@id, @displayName, @tokenHash, @now, @now, @ipHash)")
      .run(m);
  }

  lbVerify(memberId: string, tokenHash: string): boolean {
    const row = this.db.prepare("SELECT token_hash FROM lb_members WHERE id = ?").get(memberId) as { token_hash: string } | undefined;
    return row !== undefined && row.token_hash === tokenHash;
  }

  lbRename(memberId: string, displayName: string): void {
    this.db.prepare("UPDATE lb_members SET display_name = ? WHERE id = ?").run(displayName, memberId);
  }

  lbUpsertDays(memberId: string, days: readonly ReportDay[], now: number): void {
    const upsert = this.db.prepare(
      `INSERT INTO lb_daily (member_id, day, words, clips, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(member_id, day) DO UPDATE SET words = excluded.words, clips = excluded.clips, updated_at = excluded.updated_at`,
    );
    const touch = this.db.prepare("UPDATE lb_members SET last_seen = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const d of days) upsert.run(memberId, d.day, d.words, d.clips, now);
      touch.run(now, memberId);
    })();
  }

  /** Words per member within [start, end] (inclusive days), or all time when null. */
  lbTotals(range: { start: string; end: string } | null): MemberTotal[] {
    const sql =
      range === null
        ? "SELECT m.id AS memberId, m.display_name AS displayName, COALESCE(SUM(d.words), 0) AS words FROM lb_members m LEFT JOIN lb_daily d ON d.member_id = m.id GROUP BY m.id ORDER BY m.id"
        : "SELECT m.id AS memberId, m.display_name AS displayName, COALESCE(SUM(d.words), 0) AS words FROM lb_members m LEFT JOIN lb_daily d ON d.member_id = m.id AND d.day >= ? AND d.day <= ? GROUP BY m.id ORDER BY m.id";
    const stmt = this.db.prepare(sql);
    return (range === null ? stmt.all() : stmt.all(range.start, range.end)) as MemberTotal[];
  }

  lbMemberCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM lb_members").get() as { n: number }).n;
  }

  lbLeave(memberId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM lb_daily WHERE member_id = ?").run(memberId);
      this.db.prepare("DELETE FROM lb_members WHERE id = ?").run(memberId);
    })();
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM clips").get() as { n: number }).n;
  }

  clear(): void {
    this.db.exec("DELETE FROM clips; DELETE FROM profile;");
  }
}
