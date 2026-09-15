import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const share = z.object({ key: z.string(), label: z.string(), clips: z.number(), share: z.number() });
export const usageReportSchema = z.object({
  totals: z.object({ words: z.number(), clips: z.number(), durationMs: z.number(), books: z.number() }),
  month: z.object({ words: z.number(), previousWords: z.number(), deltaPct: z.number().nullable() }),
  wpm: z.object({ value: z.number().nullable(), topPercent: z.number().nullable() }),
  fixes: z.object({ edits: z.number(), fillers: z.number(), translated: z.number() }),
  surfaces: z.array(share),
  categories: z.array(share),
  languages: z.array(z.object({ language: z.string(), clips: z.number(), share: z.number() })),
  streak: z.object({ current: z.number(), longest: z.number() }),
  heatmap: z.object({
    start: z.string(),
    weeks: z.number(),
    days: z.array(z.object({ day: z.string(), words: z.number(), level: z.number() })),
  }),
  peak: z.object({ weekday: z.number(), hour: z.number(), label: z.string() }).nullable(),
  generatedAt: z.number(),
});
export type UsageReportDto = z.infer<typeof usageReportSchema>;

export const voiceProfileSchema = z.object({
  generatedAt: z.number(),
  title: z.string(),
  description: z.string(),
  catchphrase: z.string(),
  peakTitle: z.string(),
  peakDescription: z.string(),
  mostUsedWord: z.string().nullable(),
  mostCorrectedWord: z.string().nullable(),
});
export const voiceReportSchema = z.object({
  profile: voiceProfileSchema.nullable(),
  wordsTotal: z.number(),
  wordsUntilNext: z.number(),
  generating: z.boolean(),
});
export type VoiceReportDto = z.infer<typeof voiceReportSchema>;

const rankedMember = z.object({ rank: z.number(), memberId: z.string(), displayName: z.string(), words: z.number(), delta: z.number().nullable() });
export const boardPageSchema = z.object({
  period: z.enum(["week", "all"]),
  total: z.number(),
  offset: z.number(),
  members: z.array(rankedMember),
  me: rankedMember.nullable(),
});
export type BoardPageDto = z.infer<typeof boardPageSchema>;
export const leaderboardStatusSchema = z.object({
  enabled: z.boolean(),
  joined: z.boolean(),
  memberId: z.string().nullable(),
  displayName: z.string(),
  url: z.string(),
  lastReportAt: z.number().nullable(),
  lastError: z.string().nullable(),
});
export type LeaderboardStatusDto = z.infer<typeof leaderboardStatusSchema>;

const inviteRow = z.object({ code: z.string(), label: z.string(), maxUses: z.number(), uses: z.number(), createdAt: z.number(), revokedAt: z.number().nullable() });
const memberOverview = z.object({ memberId: z.string(), displayName: z.string(), createdAt: z.number(), lastSeen: z.number(), inviteCode: z.string().nullable(), days: z.number(), words: z.number() });
const eventRow = z.object({ at: z.number(), kind: z.enum(["join", "report", "leave", "rejected"]), memberId: z.string().nullable(), ipHash: z.string().nullable(), detail: z.string().nullable() });
export const adminOverviewSchema = z.object({
  hosting: z.boolean(),
  maxMembers: z.number(),
  counts: z.object({ members: z.number(), join: z.number(), report: z.number(), leave: z.number(), rejected: z.number() }),
  members: z.array(memberOverview),
  invites: z.array(inviteRow),
  events: z.array(eventRow),
});
export type AdminOverviewDto = z.infer<typeof adminOverviewSchema>;

export const leaderboardRpcContract = defineRpcContract({
  leaderboard_admin_overview: { input: z.null(), output: adminOverviewSchema },
  leaderboard_admin_invite_create: { input: z.object({ label: z.string().min(1).max(60), maxUses: z.number().int().min(1).max(1000) }).strict(), output: z.object({ code: z.string() }).strict() },
  leaderboard_admin_invite_revoke: { input: z.object({ code: z.string().min(1) }).strict(), output: z.object({ ok: z.boolean() }).strict() },
  leaderboard_admin_member_remove: { input: z.object({ memberId: z.string().min(1) }).strict(), output: z.object({ ok: z.boolean() }).strict() },
  leaderboard_status: { input: z.null(), output: leaderboardStatusSchema },
  leaderboard_join: { input: z.null(), output: z.object({ ok: z.boolean(), memberId: z.string().optional(), message: z.string().optional() }).strict() },
  leaderboard_leave: { input: z.null(), output: z.object({ ok: z.boolean(), message: z.string().optional() }).strict() },
  leaderboard_board: { input: z.object({ period: z.enum(["week", "all"]), offset: z.number().int().min(0) }).strict(), output: boardPageSchema },
});

export const insightsRpcContract = defineRpcContract({
  insights_usage: { input: z.null(), output: usageReportSchema },
  insights_clear: { input: z.null(), output: z.object({ ok: z.literal(true) }).strict() },
  insights_voice: { input: z.null(), output: voiceReportSchema },
  insights_regenerate: { input: z.null(), output: z.object({ ok: z.boolean(), message: z.string().optional() }).strict() },
});
