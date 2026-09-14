import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  surface TEXT NOT NULL,
  language TEXT,
  duration_ms INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  text TEXT NOT NULL,
  raw_words INTEGER NOT NULL,
  words INTEGER NOT NULL,
  fixes INTEGER NOT NULL,
  fillers INTEGER NOT NULL,
  translated INTEGER NOT NULL,
  polished INTEGER NOT NULL,
  asr_ms INTEGER,
  polish_ms INTEGER,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  category TEXT
);
CREATE INDEX IF NOT EXISTS clips_day ON clips(day);
CREATE INDEX IF NOT EXISTS clips_at ON clips(at);
CREATE INDEX IF NOT EXISTS clips_uncategorized ON clips(at) WHERE category IS NULL;
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at INTEGER NOT NULL,
  words_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  catchphrase TEXT NOT NULL,
  peak_title TEXT NOT NULL,
  peak_description TEXT NOT NULL,
  most_used_word TEXT,
  most_corrected_word TEXT
);
CREATE TABLE IF NOT EXISTS lb_members (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ip_hash TEXT
);
CREATE TABLE IF NOT EXISTS lb_daily (
  member_id TEXT NOT NULL,
  day TEXT NOT NULL,
  words INTEGER NOT NULL,
  clips INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, day)
);
`;

export function migrate(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;
  db.exec(DDL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
