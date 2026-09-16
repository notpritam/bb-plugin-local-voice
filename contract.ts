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
    /** Router alias of the recogniser used by the plugin's own recording path. */
    asrModel: z.string().min(1).default("qwen3-asr"),
  })
  .strict();
export type WhisperConfig = z.infer<typeof whisperConfigSchema>;

const clipId = z.string().regex(/^[a-z0-9-]{8,64}$/u);
/** A base64 slice of a recording as it arrives from the browser (≤ 2 MiB decoded). */
const slice = z.string().max(2_800_000);

export const CATEGORIES = ["prompt", "note", "message", "code", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

const recAck = z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), message: z.string() }).strict()]);

/** What the server calls on the host worker. */
export const serverHostContract = defineRpcContract({
  configure: {
    input: whisperConfigSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  // ---- Recording sessions: slices stream in, chunks are recognised as they land,
  // and the outcome comes back as the `rec` signal (no call waits on the model).
  recStart: {
    input: z.object({ id: clipId, mime: z.string().min(1), model: z.string().min(1).nullable() }).strict(),
    output: recAck,
  },
  recAppend: {
    input: z.object({ id: clipId, seq: z.number().int().nonnegative(), data: slice }).strict(),
    output: recAck,
  },
  recFinish: {
    input: z.object({ id: clipId }).strict(),
    output: recAck,
  },
  recCancel: {
    input: z.object({ id: clipId }).strict(),
    output: recAck,
  },
  /** A whole clip at once (retries, the non-streamed fallback); the outcome is the `rec` signal too. */
  recTranscribe: {
    input: z.object({ id: clipId, mime: z.string().min(1), model: z.string().min(1).nullable(), data: z.string().max(12_000_000) }).strict(),
    output: recAck,
  },
  classify: {
    input: z.object({ texts: z.array(z.string().min(1)).min(1).max(20) }).strict(),
    output: z.object({ labels: z.array(z.enum(CATEGORIES).nullable()) }).strict(),
  },
  profile: {
    input: z.object({ sample: z.array(z.string()).max(300), stats: z.string().max(4000) }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), title: z.string(), description: z.string(), catchphrase: z.string(), peakDescription: z.string() }).strict(),
      z.object({ ok: z.literal(false) }).strict(),
    ]),
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

/** The outcome of a recording session. */
export const recSignalSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      id: clipId,
      at: z.number().int().nonnegative(),
      mime: z.string(),
      model: z.string(),
      language: z.string().nullable(),
      durationMs: z.number().int().nonnegative(),
      rawText: z.string(),
      text: z.string(),
      polished: z.boolean(),
      translated: z.boolean(),
      asrMs: z.number().int().nonnegative().nullable(),
      polishMs: z.number().int().nonnegative().nullable(),
      chunks: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ ok: z.literal(false), id: clipId, at: z.number().int().nonnegative(), code: z.string(), message: z.string() }).strict(),
]);
export type RecSignal = z.infer<typeof recSignalSchema>;

export const hostSignals = {
  clip: { payload: clipSignalSchema },
  rec: { payload: recSignalSchema },
} satisfies ExperimentalHostSignals;
