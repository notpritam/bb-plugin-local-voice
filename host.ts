import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { LOCAL_VOICE_SERVICE_ID, serverHostContract, whisperConfigSchema, type WhisperConfig } from "./contract.js";
import { runCommand, transcribeAudio } from "./transcribe.js";
import { DEFAULT_CONFIG, failure } from "./whisper.js";

export const hostContract = defineRpcContract({
  ...experimental_aiServicesHostContract,
  ...serverHostContract,
});

const CONFIG_FILE = "config.json";

async function readConfig(dataDir: string): Promise<WhisperConfig> {
  try {
    const parsed = whisperConfigSchema.safeParse(
      JSON.parse(await readFile(path.join(dataDir, CONFIG_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function writeConfig(dataDir: string, config: WhisperConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, CONFIG_FILE), JSON.stringify(config, null, 2));
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    configure: async (config, context) => {
      await writeConfig(context.experimental_paths.dataDir, config);
      return { ok: true as const };
    },
    "ai.inference.complete": async (input) =>
      failure(
        "request_failed",
        `Local Voice serves voice transcription only; "${input.serviceId}" offers no inference.`,
      ),
    "ai.voice.transcribe": async (input, context) => {
      if (input.serviceId !== LOCAL_VOICE_SERVICE_ID) {
        return failure("request_failed", `This plugin serves no AI service "${input.serviceId}".`);
      }
      const config = await readConfig(context.experimental_paths.dataDir);
      try {
        return await transcribeAudio(
          {
            model: input.model,
            audioBase64: input.audioBase64,
            mimeType: input.mimeType,
            prompt: input.prompt,
            timeoutMs: input.timeoutMs,
          },
          {
            config,
            homeDir: os.homedir(),
            tempRoot: context.experimental_paths.tempDir,
            run: runCommand,
            signal: context.signal,
          },
        );
      } catch (error) {
        return failure("request_failed", error instanceof Error ? error.message : String(error));
      }
    },
  },
});
