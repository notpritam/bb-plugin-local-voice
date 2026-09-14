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

export const insightsRpcContract = defineRpcContract({
  insights_usage: { input: z.null(), output: usageReportSchema },
  insights_clear: { input: z.null(), output: z.object({ ok: z.literal(true) }).strict() },
  insights_voice: { input: z.null(), output: voiceReportSchema },
  insights_regenerate: { input: z.null(), output: z.object({ ok: z.boolean(), message: z.string().optional() }).strict() },
});
