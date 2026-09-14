import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "./schema";
import { InsightsStore, type NewClip } from "./store";

const clip = (o: Partial<NewClip> = {}): NewClip => ({
  at: 1_000, day: "2026-09-15", surface: "composer", language: "English", durationMs: 5000, rawText: "raw", text: "Text.",
  rawWords: 1, words: 1, fixes: 0, fillers: 0, translated: false, polished: true, asrMs: 100, polishMs: 50, engine: "llama", model: "qwen3-asr", ...o,
});

let store: InsightsStore;
beforeEach(() => {
  const db = new Database(":memory:");
  migrate(db);
  migrate(db); // idempotent
  store = new InsightsStore(db);
});

describe("InsightsStore", () => {
  it("inserts and reads usage rows without text", () => {
    store.insertClip(clip());
    store.insertClip(clip({ at: 2_000, surface: "field", words: 5 }));
    const rows = store.usageRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ at: 2_000, surface: "field", words: 5, category: null });
    expect(rows[0]).not.toHaveProperty("text");
  });
  it("tracks uncategorized clips and stores labels", () => {
    const id = store.insertClip(clip({ text: "commit this" }));
    expect(store.uncategorized(10)).toEqual([{ id, text: "commit this" }]);
    store.setCategory(id, "code");
    expect(store.uncategorized(10)).toEqual([]);
    expect(store.usageRows()[0]!.category).toBe("code");
  });
  it("clear removes everything", () => {
    store.insertClip(clip());
    store.clear();
    expect(store.count()).toBe(0);
  });
});

describe("profile + samples", () => {
  it("stores and reads the profile", () => {
    expect(store.getProfile()).toBeNull();
    store.setProfile({ generatedAt: 5, wordsAt: 100, title: "Context Clarifier", description: "d", catchphrase: "c", peakTitle: "Monday at 9 p.m.", peakDescription: "p", mostUsedWord: "deploy", mostCorrectedWord: "like" });
    expect(store.getProfile()).toMatchObject({ title: "Context Clarifier", wordsAt: 100, mostUsedWord: "deploy" });
  });
  it("returns recent texts newest first and raw/polished pairs for non-translated clips", () => {
    store.insertClip(clip({ at: 1, text: "first", rawText: "um first" }));
    store.insertClip(clip({ at: 2, text: "second", rawText: "second", translated: true }));
    store.insertClip(clip({ at: 3, text: "third", rawText: "uh third" }));
    expect(store.recentTexts(2)).toEqual(["third", "second"]);
    expect(store.recentPairs(10)).toEqual([{ rawText: "uh third", text: "third" }, { rawText: "um first", text: "first" }]);
    expect(store.totalWords()).toBe(3);
  });
});

describe("leaderboard store", () => {
  it("joins, verifies, upserts days, ranks by period, leaves", () => {
    store.lbJoin({ id: "aaaa", displayName: "Ann", tokenHash: "h1", now: 1, ipHash: null });
    store.lbJoin({ id: "bbbb", displayName: "Bob", tokenHash: "h2", now: 1, ipHash: null });
    expect(store.lbVerify("aaaa", "h1")).toBe(true);
    expect(store.lbVerify("aaaa", "nope")).toBe(false);
    expect(store.lbVerify("zzzz", "h1")).toBe(false);
    store.lbUpsertDays("aaaa", [{ day: "2026-09-14", words: 100, clips: 2 }, { day: "2026-09-08", words: 500, clips: 5 }], 10);
    store.lbUpsertDays("bbbb", [{ day: "2026-09-15", words: 300, clips: 3 }], 10);
    store.lbUpsertDays("aaaa", [{ day: "2026-09-14", words: 150, clips: 3 }], 11); // upsert replaces
    expect(store.lbTotals({ start: "2026-09-14", end: "2026-09-20" })).toEqual([
      { memberId: "aaaa", displayName: "Ann", words: 150 },
      { memberId: "bbbb", displayName: "Bob", words: 300 },
    ]);
    expect(store.lbTotals(null)).toEqual([
      { memberId: "aaaa", displayName: "Ann", words: 650 },
      { memberId: "bbbb", displayName: "Bob", words: 300 },
    ]);
    expect(store.lbMemberCount()).toBe(2);
    store.lbLeave("aaaa");
    expect(store.lbMemberCount()).toBe(1);
    expect(store.lbTotals(null)).toEqual([{ memberId: "bbbb", displayName: "Bob", words: 300 }]);
  });
  it("daily totals for the client report", () => {
    store.insertClip(clip({ day: "2026-09-14", words: 10 }));
    store.insertClip(clip({ day: "2026-09-14", words: 5 }));
    store.insertClip(clip({ day: "2026-09-15", words: 7 }));
    expect(store.dailyTotalsSince("2026-09-14")).toEqual([{ day: "2026-09-14", words: 15, clips: 2 }, { day: "2026-09-15", words: 7, clips: 1 }]);
  });
});
