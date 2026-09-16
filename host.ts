import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { classifyFetch, classifyText } from "./classify.js";
import { SESSION_IDLE_MS, SessionRegistry, createSession, type SessionEntry } from "./recording.js";
import { selectEngine } from "./engine.js";
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

/** Recording sessions live for the worker's lifetime; the outcome of each is one `rec` signal. */
const sessions = new SessionRegistry();
let sweeper: ReturnType<typeof setInterval> | null = null;

type EmitRec = (payload: import("./contract.js").RecSignal) => Promise<void>;

async function finishAndEmit(entry: SessionEntry, emit: EmitRec, lease: { dispose(): Promise<void> } | null): Promise<void> {
  entry.finishing = true;
  const at = Date.now();
  try {
    const result = await entry.session.finish();
    if (result.ok) {
      await emit({
        ok: true,
        id: entry.id,
        at,
        mime: entry.mime,
        model: entry.model,
        language: result.language,
        durationMs: result.durationMs,
        rawText: result.rawText,
        text: result.text,
        polished: result.polished,
        translated: result.translated,
        asrMs: result.asrMs,
        polishMs: result.polishMs,
        chunks: result.chunks,
      });
    } else {
      await emit({ ok: false, id: entry.id, at, code: result.code, message: result.message });
    }
  } catch (error) {
    await emit({ ok: false, id: entry.id, at, code: "request_failed", message: error instanceof Error ? error.message : String(error) }).catch(() => {});
  } finally {
    sessions.delete(entry.id);
    await lease?.dispose().catch(() => {});
  }
}

function recordingConfig(config: WhisperConfig, model: string | null) {
  const asrModel = model ?? config.asrModel;
  return { serverUrl: config.serverUrl, asrModel, polish: config.polish, translate: config.translate, polishModel: config.polishModel };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    recStart: async ({ id, mime, model }, context) => {
      const config = await readConfig(context.experimental_paths.dataDir);
      const engine = selectEngine(model ?? config.asrModel);
      if (engine.kind !== "llama") return { ok: false as const, message: "Streaming recordings need the llama-server engine; whisper.cpp models go through bb's own path." };
      const entry = sessions.start({ id, mime, model: engine.model, session: createSession(recordingConfig(config, engine.model), { streaming: true }), startedAt: Date.now() });
      // Retained so the daemon does not idle-stop the worker mid-recording.
      const lease = context.experimental_retainWorker();
      (entry as SessionEntry & { lease?: typeof lease }).lease = lease;
      if (sweeper === null) {
        sweeper = setInterval(() => {
          for (const dropped of sessions.sweep(Date.now(), SESSION_IDLE_MS)) {
            void context.experimental_emitSignal("rec", { ok: false, id: dropped, at: Date.now(), code: "abandoned", message: "The recording never finished (the browser went away)." }).catch(() => {});
          }
          if (sessions.size === 0 && sweeper !== null) {
            clearInterval(sweeper);
            sweeper = null;
          }
        }, 30_000);
        sweeper.unref();
        context.lifecycle.signal.addEventListener("abort", () => sessions.cancelAll(), { once: true });
      }
      return { ok: true as const };
    },
    recAppend: async ({ id, data }) => {
      const entry = sessions.get(id);
      if (entry === null) return { ok: false as const, message: `No recording "${id}" in progress.` };
      entry.session.append(Buffer.from(data, "base64"));
      return { ok: true as const };
    },
    recFinish: async ({ id }, context) => {
      const entry = sessions.get(id);
      if (entry === null) return { ok: false as const, message: `No recording "${id}" in progress.` };
      if (entry.finishing) return { ok: true as const };
      void finishAndEmit(entry, (payload) => context.experimental_emitSignal("rec", payload), (entry as SessionEntry & { lease?: { dispose(): Promise<void> } }).lease ?? null);
      return { ok: true as const };
    },
    recCancel: async ({ id }) => {
      const entry = sessions.get(id);
      if (entry === null) return { ok: true as const };
      entry.session.cancel();
      sessions.delete(id);
      await (entry as SessionEntry & { lease?: { dispose(): Promise<void> } }).lease?.dispose().catch(() => {});
      return { ok: true as const };
    },
    recTranscribe: async ({ id, mime, model, data }, context) => {
      const config = await readConfig(context.experimental_paths.dataDir);
      const engine = selectEngine(model ?? config.asrModel);
      if (engine.kind !== "llama") return { ok: false as const, message: "Retries need the llama-server engine." };
      const entry = sessions.start({ id, mime, model: engine.model, session: createSession(recordingConfig(config, engine.model), { streaming: false }), startedAt: Date.now() });
      entry.session.append(Buffer.from(data, "base64"));
      void finishAndEmit(entry, (payload) => context.experimental_emitSignal("rec", payload), context.experimental_retainWorker());
      return { ok: true as const };
    },
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
