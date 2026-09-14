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
