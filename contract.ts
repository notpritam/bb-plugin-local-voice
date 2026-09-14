import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The `<serviceId>` segment of `BB_TRANSCRIPTION=whisper/<model>`. */
export const WHISPER_SERVICE_ID = "whisper";

export const whisperConfigSchema = z
  .object({
    modelsDir: z.string().min(1),
    threads: z.number().int().min(1).max(64),
    translate: z.boolean(),
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
