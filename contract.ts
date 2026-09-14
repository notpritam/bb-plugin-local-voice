import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The `<serviceId>` segment of `BB_TRANSCRIPTION=local/<model>`. */
export const LOCAL_VOICE_SERVICE_ID = "local";

export const whisperConfigSchema = z
  .object({
    /** whisper.cpp fallback: where ggml-<model>.bin files live. */
    modelsDir: z.string().min(1),
    /** whisper-cli thread count. */
    threads: z.number().int().min(1).max(64),
    /** Turn non-English speech into English (Gemma step). */
    translate: z.boolean(),
    /** llama-server router serving the ASR and translation models. */
    serverUrl: z.string().min(1),
    /** Router alias of the translation model. */
    translateModel: z.string().min(1),
  })
  .strict();
export type WhisperConfig = z.infer<typeof whisperConfigSchema>;

/** What the server pushes to the host worker; the host persists it. */
export const serverHostContract = defineRpcContract({
  configure: {
    input: whisperConfigSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
