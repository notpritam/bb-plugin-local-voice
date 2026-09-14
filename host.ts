import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { classifyFetch, classifyText } from "./classify.js";
import { generatePersona, profileFetch } from "./profile.js";
import { LOCAL_VOICE_SERVICE_ID, hostSignals, serverHostContract, whisperConfigSchema, type Category, type WhisperConfig } from "./contract.js";
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
  experimental_signals: hostSignals,
  handlers: {
    configure: async (config, context) => {
      await writeConfig(context.experimental_paths.dataDir, config);
      return { ok: true as const };
    },
    classify: async ({ texts }, context) => {
      const config = await readConfig(context.experimental_paths.dataDir);
      const labels: (Category | null)[] = [];
      for (const text of texts) {
        labels.push(await classifyText({ text, serverUrl: config.serverUrl, model: config.polishModel, signal: context.signal, fetchImpl: classifyFetch }));
      }
      return { labels };
    },
    profile: async ({ sample, stats }, context) => {
      const config = await readConfig(context.experimental_paths.dataDir);
      const persona = await generatePersona({ sample, stats, serverUrl: config.serverUrl, model: config.polishModel, signal: context.signal, fetchImpl: profileFetch });
      return persona === null ? { ok: false as const } : { ok: true as const, ...persona };
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
        const result = await transcribeAudio(
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
        if (!result.ok) return result;
        if (result.text !== "") {
          const { details } = result;
          try {
            await context.experimental_emitSignal("clip", {
              at: Date.now(),
              filename: input.filename,
              mimeType: input.mimeType,
              language: details.language,
              durationMs: details.durationMs,
              rawText: details.rawText,
              text: result.text,
              polished: details.polished,
              translated: details.translated,
              asrMs: details.asrMs,
              polishMs: details.polishMs,
              engine: details.engine,
              model: input.model,
            });
          } catch {
            // Insights are best-effort; never fail the transcription over them.
          }
        }
        return { ok: true as const, model: result.model, text: result.text };
      } catch (error) {
        return failure("request_failed", error instanceof Error ? error.message : String(error));
      }
    },
  },
});
