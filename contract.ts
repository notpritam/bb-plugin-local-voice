import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The `<serviceId>` segment of `BB_TRANSCRIPTION=local/<model>`. */
export const LOCAL_VOICE_SERVICE_ID = "local";

export const whisperConfigSchema = z
  .object({
    /** whisper.cpp fallback: where ggml-<model>.bin files live. */
    modelsDir: z.string().min(1),
    /** whisper-cli thread count. */
    threads: z.number().int().min(1).max(64),
    /** Polisher outputs English (translating when needed); off keeps the spoken language. */
    translate: z.boolean(),
    /** Run the polisher (fillers, punctuation, lists, identifiers) on every clip. */
    polish: z.boolean(),
    /** llama-server router serving the ASR and polisher models. */
    serverUrl: z.string().min(1),
    /** Router alias of the polisher model. */
    polishModel: z.string().min(1),
  })
  .strict();
export type WhisperConfig = z.infer<typeof whisperConfigSchema>;

export const CATEGORIES = ["prompt", "note", "message", "code", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

/** What the server calls on the host worker. */
export const serverHostContract = defineRpcContract({
  configure: {
    input: whisperConfigSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  classify: {
    input: z.object({ texts: z.array(z.string().min(1)).min(1).max(20) }).strict(),
    output: z.object({ labels: z.array(z.enum(CATEGORIES).nullable()) }).strict(),
  },
});

/** One finished dictation, emitted by the host after a successful transcription. */
export const clipSignalSchema = z
  .object({
    at: z.number().int().nonnegative(),
    filename: z.string(),
    mimeType: z.string(),
    language: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    rawText: z.string(),
    text: z.string(),
    polished: z.boolean(),
    translated: z.boolean(),
    asrMs: z.number().int().nonnegative().nullable(),
    polishMs: z.number().int().nonnegative().nullable(),
    engine: z.enum(["llama", "whisper"]),
    model: z.string(),
  })
  .strict();
export type ClipSignal = z.infer<typeof clipSignalSchema>;

export const hostSignals = {
  clip: { payload: clipSignalSchema },
} satisfies ExperimentalHostSignals;
