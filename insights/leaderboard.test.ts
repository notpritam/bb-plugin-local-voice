import { describe, expect, it } from "vitest";
import { RateLimiter, hashToken, isoWeekRange, newMemberId, newToken, previousIsoWeekRange, rankMembers, sanitizeName, validateReportDays } from "./leaderboard";

describe("sanitizeName", () => {
  it("trims, strips control characters, enforces 2..32", () => {
    expect(sanitizeName("  Pritam  Sharma  ")).toBe("Pritam Sharma");
    expect(sanitizeName("bad\u0007name")).toBe("badname");
    expect(sanitizeName("x")).toBeNull();
    expect(sanitizeName("a".repeat(40))).toBe("a".repeat(32));
    expect(sanitizeName(42)).toBeNull();
  });
});

describe("iso weeks", () => {
  it("runs Monday..Sunday", () => {
    expect(isoWeekRange("2026-09-15")).toEqual({ start: "2026-09-14", end: "2026-09-20" }); // Tue
    expect(isoWeekRange("2026-09-13")).toEqual({ start: "2026-09-07", end: "2026-09-13" }); // Sun
    expect(previousIsoWeekRange("2026-09-15")).toEqual({ start: "2026-09-07", end: "2026-09-13" });
  });
});

describe("rankMembers", () => {
  it("ranks by words desc, ties by name, with deltas against the previous ranking", () => {
    const now = [{ memberId: "a", displayName: "Ann", words: 50 }, { memberId: "b", displayName: "Bob", words: 90 }, { memberId: "c", displayName: "Cid", words: 50 }];
    const previous = [{ memberId: "a", displayName: "Ann", words: 100 }, { memberId: "b", displayName: "Bob", words: 10 }];
    expect(rankMembers(now, previous)).toEqual([
      { rank: 1, memberId: "b", displayName: "Bob", words: 90, delta: 1 },
      { rank: 2, memberId: "a", displayName: "Ann", words: 50, delta: -1 },
      { rank: 3, memberId: "c", displayName: "Cid", words: 50, delta: null },
    ]);
    expect(rankMembers(now, null)[0]!.delta).toBeNull();
  });
});

describe("validateReportDays", () => {
  it("accepts up to 8 sane days and rejects the rest", () => {
    expect(validateReportDays([{ day: "2026-09-15", words: 120, clips: 3 }])).toEqual({ ok: true, days: [{ day: "2026-09-15", words: 120, clips: 3 }] });
    expect(validateReportDays([{ day: "2026-9-1", words: 1, clips: 1 }]).ok).toBe(false);
    expect(validateReportDays([{ day: "2026-09-15", words: 60_001, clips: 1 }]).ok).toBe(false);
    expect(validateReportDays([{ day: "2026-09-15", words: -1, clips: 1 }]).ok).toBe(false);
    expect(validateReportDays(Array.from({ length: 9 }, (_, i) => ({ day: `2026-09-0${(i % 9) + 1}`, words: 1, clips: 1 }))).ok).toBe(false);
    expect(validateReportDays("nope").ok).toBe(false);
  });
});

describe("tokens + rate limiter", () => {
  it("makes opaque ids and hashes tokens deterministically", () => {
    expect(newMemberId()).toMatch(/^[a-z0-9]{12}$/u);
    expect(newToken()).toHaveLength(43);
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
  it("allows a burst then refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 3, refillPerMs: 1 / 1000, now: () => now });
    expect([limiter.take("ip"), limiter.take("ip"), limiter.take("ip"), limiter.take("ip")]).toEqual([true, true, true, false]);
    now = 1000;
    expect(limiter.take("ip")).toBe(true);
    expect(limiter.take("other")).toBe(true);
  });
});
