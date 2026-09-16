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

// ---- Recordings (the plugin's own path: no bb timeout, audio kept, retry) and history.
const uid = z.string().regex(/^[a-z0-9-]{8,64}$/u);
const surface = z.enum(["composer", "field", "cli", "other"]);
const ack = z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), message: z.string() }).strict()]);
const started = z.union([z.object({ ok: z.literal(true), id: z.number() }).strict(), z.object({ ok: z.literal(false), message: z.string() }).strict()]);
export const clipRowSchema = z.object({
  id: z.number(),
  uid: z.string().nullable(),
  at: z.number(),
  day: z.string(),
  surface,
  language: z.string().nullable(),
  durationMs: z.number(),
  rawText: z.string(),
  text: z.string(),
  words: z.number(),
  fixes: z.number(),
  translated: z.boolean(),
  polished: z.boolean(),
  asrMs: z.number().nullable(),
  polishMs: z.number().nullable(),
  model: z.string(),
  status: z.enum(["recording", "transcribing", "done", "failed"]),
  error: z.string().nullable(),
  mime: z.string().nullable(),
  attempts: z.number(),
  audioBytes: z.number(),
});
export type ClipRowDto = z.infer<typeof clipRowSchema>;
export const recResultSchema = z.union([
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("done"), id: z.number(), text: z.string() }).strict(),
  z.object({ status: z.literal("failed"), id: z.number(), message: z.string() }).strict(),
]);
export type RecResultDto = z.infer<typeof recResultSchema>;

export const recordingRpcContract = defineRpcContract({
  rec_start: { input: z.object({ uid, surface, mime: z.string().min(1).max(100) }).strict(), output: started },
  rec_append: { input: z.object({ uid, seq: z.number().int().nonnegative(), data: z.string().max(2_800_000) }).strict(), output: ack },
  rec_finish: { input: z.object({ uid }).strict(), output: ack },
  rec_cancel: { input: z.object({ uid }).strict(), output: ack },
  /** Long-polls up to ~25 s for the outcome; call again on `pending`. */
  rec_result: { input: z.object({ uid }).strict(), output: recResultSchema },
  /** A whole clip at once (the fallback when slices could not be streamed). */
  rec_transcribe: { input: z.object({ uid, surface, mime: z.string().min(1).max(100), data: z.string().max(12_000_000) }).strict(), output: started },
  history_list: {
    input: z.object({ before: z.number().nullable(), limit: z.number().int().min(1).max(200), query: z.string().max(200).nullable() }).strict(),
    output: z.object({ clips: z.array(clipRowSchema), hasMore: z.boolean() }).strict(),
  },
  clip_retry: { input: z.object({ id: z.number().int() }).strict(), output: ack },
  /** Long-polls a clip (by row id) the way rec_result does a recording; for retries started from the dock. */
  clip_wait: { input: z.object({ id: z.number().int() }).strict(), output: recResultSchema },
  clip_delete: { input: z.object({ id: z.number().int() }).strict(), output: ack },
});
