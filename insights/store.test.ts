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
    store.lbJoin({ id: "aaaa", displayName: "Ann", tokenHash: "h1", now: 1, ipHash: null, inviteCode: null });
    store.lbJoin({ id: "bbbb", displayName: "Bob", tokenHash: "h2", now: 1, ipHash: null, inviteCode: null });
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

describe("invites + events (v2)", () => {
  it("creates, lists, claims, exhausts and revokes invites", () => {
    store.lbCreateInvite({ code: "ab12cd34", label: "friends", maxUses: 2, now: 1 });
    expect(store.lbListInvites()).toMatchObject([{ code: "ab12cd34", label: "friends", maxUses: 2, uses: 0, revokedAt: null }]);
    expect(store.lbClaimInvite("ab12cd34", 2)).toEqual({ ok: true });
    expect(store.lbClaimInvite("ab12cd34", 3)).toEqual({ ok: true });
    expect(store.lbClaimInvite("ab12cd34", 4)).toEqual({ ok: false, reason: "exhausted" });
    expect(store.lbClaimInvite("nope", 4)).toEqual({ ok: false, reason: "unknown" });
    store.lbCreateInvite({ code: "zz99zz99", label: "team", maxUses: 10, now: 5 });
    store.lbRevokeInvite("zz99zz99", 6);
    expect(store.lbClaimInvite("zz99zz99", 7)).toEqual({ ok: false, reason: "revoked" });
    expect(store.lbListInvites().find((i) => i.code === "zz99zz99")?.revokedAt).toBe(6);
  });
  it("records members with their invite, logs events, and builds the overview", () => {
    store.lbCreateInvite({ code: "ab12cd34", label: "friends", maxUses: 5, now: 1 });
    store.lbJoin({ id: "aaaa", displayName: "Ann", tokenHash: "h1", now: 10, ipHash: "ip1", inviteCode: "ab12cd34" });
    store.lbLogEvent({ at: 10, kind: "join", memberId: "aaaa", ipHash: "ip1", detail: null });
    store.lbUpsertDays("aaaa", [{ day: "2026-09-14", words: 100, clips: 2 }], 20);
    store.lbLogEvent({ at: 20, kind: "report", memberId: "aaaa", ipHash: "ip1", detail: "1 day" });
    const overview = store.lbMembersOverview();
    expect(overview).toEqual([{ memberId: "aaaa", displayName: "Ann", createdAt: 10, lastSeen: 20, inviteCode: "ab12cd34", days: 1, words: 100 }]);
    expect(store.lbRecentEvents(10).map((e) => e.kind)).toEqual(["report", "join"]);
    expect(store.lbEventCounts(0)).toEqual({ join: 1, report: 1, leave: 0, rejected: 0 });
  });
});
