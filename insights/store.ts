import type Database from "better-sqlite3";
import type { Category } from "../contract.js";
import type { NewClip, Surface } from "./clip.js";
import type { MemberTotal, ReportDay } from "./leaderboard.js";
export type { NewClip } from "./clip.js";

export type EventKind = "join" | "report" | "leave" | "rejected";
export interface InviteRow { code: string; label: string; maxUses: number; uses: number; createdAt: number; revokedAt: number | null }
export interface EventRow { at: number; kind: EventKind; memberId: string | null; ipHash: string | null; detail: string | null }
export interface MemberOverview { memberId: string; displayName: string; createdAt: number; lastSeen: number; inviteCode: string | null; days: number; words: number }

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
        "SELECT at, day, surface, language, duration_ms, raw_words, words, fixes, fillers, translated, category FROM clips WHERE status = 'done' AND words > 0 ORDER BY at ASC",
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
    return this.db.prepare("SELECT id, text FROM clips WHERE category IS NULL AND status = 'done' AND words > 0 ORDER BY at ASC LIMIT ?").all(limit) as {
      id: number;
      text: string;
    }[];
  }

  setCategory(id: number, category: Category): void {
    this.db.prepare("UPDATE clips SET category = ? WHERE id = ?").run(category, id);
  }

  totalWords(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(words), 0) AS n FROM clips WHERE status = 'done'").get() as { n: number }).n;
  }

  /** Newest first. */
  recentTexts(limit: number): string[] {
    return (this.db.prepare("SELECT text FROM clips WHERE status = 'done' AND words > 0 ORDER BY at DESC LIMIT ?").all(limit) as { text: string }[]).map((r) => r.text);
  }

  /** Raw/polished pairs of same-language clips, newest first — translations are not corrections. */
  recentPairs(limit: number): { rawText: string; text: string }[] {
    return this.db
      .prepare("SELECT raw_text AS rawText, text FROM clips WHERE translated = 0 AND status = 'done' AND words > 0 ORDER BY at DESC LIMIT ?")
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
      .prepare("SELECT day, SUM(words) AS words, COUNT(*) AS clips FROM clips WHERE day >= ? AND status = 'done' AND words > 0 GROUP BY day ORDER BY day ASC")
      .all(day) as ReportDay[];
  }

  // ---- leaderboard (public host side)
  lbJoin(m: { id: string; displayName: string; tokenHash: string; now: number; ipHash: string | null; inviteCode: string | null }): void {
    this.db
      .prepare(
        "INSERT INTO lb_members (id, display_name, token_hash, created_at, last_seen, ip_hash, invite_code) VALUES (@id, @displayName, @tokenHash, @now, @now, @ipHash, @inviteCode)",
      )
      .run(m);
  }

  // ---- invites (the host decides who may join)
  lbCreateInvite(i: { code: string; label: string; maxUses: number; now: number }): void {
    this.db.prepare("INSERT INTO lb_invites (code, label, max_uses, uses, created_at) VALUES (@code, @label, @maxUses, 0, @now)").run(i);
  }

  lbListInvites(): InviteRow[] {
    return (
      this.db
        .prepare("SELECT code, label, max_uses, uses, created_at, revoked_at FROM lb_invites ORDER BY created_at DESC")
        .all() as { code: string; label: string; max_uses: number; uses: number; created_at: number; revoked_at: number | null }[]
    ).map((r) => ({ code: r.code, label: r.label, maxUses: r.max_uses, uses: r.uses, createdAt: r.created_at, revokedAt: r.revoked_at }));
  }

  lbRevokeInvite(code: string, now: number): boolean {
    return this.db.prepare("UPDATE lb_invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL").run(now, code).changes === 1;
  }

  /** Atomically consume one use of an invite. */
  lbClaimInvite(code: string, now: number): { ok: true } | { ok: false; reason: "unknown" | "revoked" | "exhausted" } {
    return this.db.transaction((): { ok: true } | { ok: false; reason: "unknown" | "revoked" | "exhausted" } => {
      const row = this.db.prepare("SELECT max_uses, uses, revoked_at FROM lb_invites WHERE code = ?").get(code) as
        | { max_uses: number; uses: number; revoked_at: number | null }
        | undefined;
      if (row === undefined) return { ok: false, reason: "unknown" };
      if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
      if (row.uses >= row.max_uses) return { ok: false, reason: "exhausted" };
      this.db.prepare("UPDATE lb_invites SET uses = uses + 1 WHERE code = ?").run(code);
      void now;
      return { ok: true };
    })();
  }

  // ---- events (what the host sees happening)
  lbLogEvent(e: { at: number; kind: EventKind; memberId: string | null; ipHash: string | null; detail: string | null }): void {
    this.db.prepare("INSERT INTO lb_events (at, kind, member_id, ip_hash, detail) VALUES (@at, @kind, @memberId, @ipHash, @detail)").run(e);
    this.db.prepare("DELETE FROM lb_events WHERE id < (SELECT COALESCE(MAX(id), 0) - 5000 FROM lb_events)").run();
  }

  lbRecentEvents(limit: number): EventRow[] {
    return (
      this.db.prepare("SELECT at, kind, member_id, ip_hash, detail FROM lb_events ORDER BY id DESC LIMIT ?").all(limit) as {
        at: number; kind: EventKind; member_id: string | null; ip_hash: string | null; detail: string | null;
      }[]
    ).map((r) => ({ at: r.at, kind: r.kind, memberId: r.member_id, ipHash: r.ip_hash, detail: r.detail }));
  }

  lbEventCounts(sinceMs: number): Record<EventKind, number> {
    const counts: Record<EventKind, number> = { join: 0, report: 0, leave: 0, rejected: 0 };
    for (const r of this.db.prepare("SELECT kind, COUNT(*) AS n FROM lb_events WHERE at >= ? GROUP BY kind").all(sinceMs) as { kind: EventKind; n: number }[]) {
      counts[r.kind] = r.n;
    }
    return counts;
  }

  lbMembersOverview(): MemberOverview[] {
    return (
      this.db
        .prepare(
          `SELECT m.id AS memberId, m.display_name AS displayName, m.created_at AS createdAt, m.last_seen AS lastSeen, m.invite_code AS inviteCode,
                  COUNT(d.day) AS days, COALESCE(SUM(d.words), 0) AS words
           FROM lb_members m LEFT JOIN lb_daily d ON d.member_id = m.id
           GROUP BY m.id ORDER BY words DESC, m.created_at ASC`,
        )
        .all() as MemberOverview[]
    );
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
    return (this.db.prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'done' AND words > 0").get() as { n: number }).n;
  }

  clear(): void {
    this.db.exec("DELETE FROM clip_audio; DELETE FROM clips; DELETE FROM profile;");
  }

  // ---- recordings: a row exists from the first slice; the audio sits beside it.
  startRecording(r: { uid: string; at: number; day: string; surface: Surface; mime: string; model: string }): number {
    const result = this.db
      .prepare(
        `INSERT INTO clips (at, day, surface, language, duration_ms, raw_text, text, raw_words, words, fixes, fillers, translated, polished, asr_ms, polish_ms, engine, model, status, mime, attempts, uid)
         VALUES (@at, @day, @surface, NULL, 0, '', '', 0, 0, 0, 0, 0, 0, NULL, NULL, 'llama', @model, 'recording', @mime, 0, @uid)`,
      )
      .run(r);
    return Number(result.lastInsertRowid);
  }

  /** Slices are kept as rows (SQLite's `||` would cast a BLOB to text) and joined on read. */
  appendAudio(id: number, slice: Buffer, now: number): void {
    this.db
      .prepare("INSERT INTO clip_audio (clip_id, seq, data, bytes, updated_at) VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM clip_audio WHERE clip_id = ?), ?, ?, ?)")
      .run(id, id, slice, slice.length, now);
  }

  audioFor(id: number): { mime: string; data: Buffer; bytes: number } | null {
    const parts = this.db.prepare("SELECT data FROM clip_audio WHERE clip_id = ? ORDER BY seq ASC").all(id) as { data: Buffer }[];
    if (parts.length === 0) return null;
    const mime = (this.db.prepare("SELECT mime FROM clips WHERE id = ?").get(id) as { mime: string | null } | undefined)?.mime ?? "audio/webm";
    const data = Buffer.concat(parts.map((p) => p.data));
    return { mime, data, bytes: data.length };
  }

  clipByUid(uid: string): ClipRow | null {
    const row = this.db.prepare(`${CLIP_SELECT} WHERE c.uid = ?`).get(uid) as ClipDbRow | undefined;
    return row === undefined ? null : toClipRow(row);
  }

  clip(id: number): ClipRow | null {
    const row = this.db.prepare(`${CLIP_SELECT} WHERE c.id = ?`).get(id) as ClipDbRow | undefined;
    return row === undefined ? null : toClipRow(row);
  }

  setUid(id: number, uid: string): void {
    this.db.prepare("UPDATE clips SET uid = ? WHERE id = ?").run(uid, id);
  }

  setStatus(id: number, status: ClipStatus, error: string | null = null): void {
    this.db.prepare("UPDATE clips SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }

  /** The outcome of a recording (or a retry): metrics in, status done, one more attempt. */
  completeClip(id: number, clip: Omit<NewClip, "at" | "day" | "surface">): void {
    this.db
      .prepare(
        `UPDATE clips SET language = @language, duration_ms = @durationMs, raw_text = @rawText, text = @text, raw_words = @rawWords, words = @words,
           fixes = @fixes, fillers = @fillers, translated = @translated, polished = @polished, asr_ms = @asrMs, polish_ms = @polishMs, engine = @engine, model = @model,
           status = 'done', error = NULL, attempts = attempts + 1, category = NULL
         WHERE id = @id`,
      )
      .run({ ...clip, id, translated: clip.translated ? 1 : 0, polished: clip.polished ? 1 : 0 });
  }

  failClip(id: number, error: string): void {
    this.db.prepare("UPDATE clips SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?").run(error, id);
  }

  deleteClip(id: number): void {
    this.db.prepare("DELETE FROM clip_audio WHERE clip_id = ?").run(id);
    this.db.prepare("DELETE FROM clips WHERE id = ?").run(id);
  }

  /** Newest first; `before` pages by `at`; `query` matches the text (case-insensitive). */
  history(o: { before: number | null; limit: number; query: string | null }): ClipRow[] {
    const filters = ["1 = 1"];
    const params: (number | string)[] = [];
    if (o.before !== null) {
      filters.push("c.at < ?");
      params.push(o.before);
    }
    if (o.query !== null && o.query.trim() !== "") {
      filters.push("(c.text LIKE ? ESCAPE '\\' OR c.raw_text LIKE ? ESCAPE '\\')");
      const like = `%${o.query.trim().replace(/[%_]/gu, (m) => `\\${m}`)}%`;
      params.push(like, like);
    }
    params.push(o.limit);
    const rows = this.db.prepare(`${CLIP_SELECT} WHERE ${filters.join(" AND ")} ORDER BY c.at DESC LIMIT ?`).all(...params) as ClipDbRow[];
    return rows.map(toClipRow);
  }

  /** Drop audio of finished clips older than `before`; returns how many. */
  purgeAudioBefore(before: number): number {
    return this.db
      .prepare("DELETE FROM clip_audio WHERE clip_id IN (SELECT id FROM clips WHERE at < ? AND status = 'done')")
      .run(before).changes;
  }

  /** Rows still marked in progress from before `before` (a server restart mid-recording). */
  staleRecordings(before: number): number[] {
    return (this.db.prepare("SELECT id FROM clips WHERE status IN ('recording', 'transcribing') AND at < ?").all(before) as { id: number }[]).map((r) => r.id);
  }
}

export type ClipStatus = "recording" | "transcribing" | "done" | "failed";
export interface ClipRow {
  id: number;
  uid: string | null;
  at: number;
  day: string;
  surface: Surface;
  language: string | null;
  durationMs: number;
  rawText: string;
  text: string;
  words: number;
  fixes: number;
  translated: boolean;
  polished: boolean;
  asrMs: number | null;
  polishMs: number | null;
  model: string;
  status: ClipStatus;
  error: string | null;
  mime: string | null;
  attempts: number;
  audioBytes: number;
}
interface ClipDbRow {
  id: number; uid: string | null; at: number; day: string; surface: Surface; language: string | null; duration_ms: number; raw_text: string; text: string;
  words: number; fixes: number; translated: number; polished: number; asr_ms: number | null; polish_ms: number | null; model: string;
  status: ClipStatus; error: string | null; mime: string | null; attempts: number; audio_bytes: number | null;
}
const CLIP_SELECT = `SELECT c.id, c.uid, c.at, c.day, c.surface, c.language, c.duration_ms, c.raw_text, c.text, c.words, c.fixes, c.translated, c.polished, c.asr_ms, c.polish_ms, c.model,
  c.status, c.error, c.mime, c.attempts, (SELECT SUM(bytes) FROM clip_audio a WHERE a.clip_id = c.id) AS audio_bytes FROM clips c`;
function toClipRow(r: ClipDbRow): ClipRow {
  return {
    id: r.id,
    uid: r.uid,
    at: r.at,
    day: r.day,
    surface: r.surface,
    language: r.language,
    durationMs: r.duration_ms,
    rawText: r.raw_text,
    text: r.text,
    words: r.words,
    fixes: r.fixes,
    translated: r.translated === 1,
    polished: r.polished === 1,
    asrMs: r.asr_ms,
    polishMs: r.polish_ms,
    model: r.model,
    status: r.status,
    error: r.error,
    mime: r.mime,
    attempts: r.attempts,
    audioBytes: r.audio_bytes ?? 0,
  };
}
