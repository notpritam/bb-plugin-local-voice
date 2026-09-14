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

/** What the server pushes to the host worker; the host persists it. */
export const serverHostContract = defineRpcContract({
  configure: {
    input: whisperConfigSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
