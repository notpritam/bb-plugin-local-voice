import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { classifyTexts } from "./classify.js";
import { SESSION_IDLE_MS, SessionRegistry, createSession, type SessionEntry } from "./recording.js";
import { formatFn, selectEngine } from "./engine.js";
import { ClaudeFormatter, poolEnv, type ClaudeRuntime } from "./formatter.js";
import { generatePersona } from "./profile.js";
import { LOCAL_VOICE_SERVICE_ID, hostSignals, serverHostContract, whisperConfigSchema, type WhisperConfig } from "./contract.js";
import { API_KEY_FILE, readApiKey } from "./scribe.js";
import { runCommand, transcribeAudio } from "./transcribe.js";
import { DEFAULT_CONFIG, failure } from "./whisper.js";

export const hostContract = defineRpcContract({
  ...experimental_aiServicesHostContract,
  ...serverHostContract,
});

const CONFIG_FILE = "config.json";

async function readConfig(dataDir: string): Promise<WhisperConfig> {
  let config = DEFAULT_CONFIG;
  try {
    const parsed = whisperConfigSchema.safeParse(
      JSON.parse(await readFile(path.join(dataDir, CONFIG_FILE), "utf8")),
    );
    if (parsed.success) config = parsed.data;
  } catch {
    // defaults
  }
  claudeProxy = config.claudeProxy;
  return config;
}

async function writeConfig(dataDir: string, config: WhisperConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, CONFIG_FILE), JSON.stringify(config, null, 2));
}

/** The Claude CLI runs in a private, empty directory beside the host's data (no project settings, no CLAUDE.md). */
function claudeCwd(dataDir: string): string {
  return path.join(dataDir, "claude-cwd");
}

/** The latest config's Claude route; every CLI start reads it (and the pooler's token file) afresh. */
let claudeProxy: WhisperConfig["claudeProxy"] = null;
function claudeRuntime(dataDir: string): ClaudeRuntime {
  return { cwd: claudeCwd(dataDir), env: () => poolEnv(claudeProxy) };
}

/** One formatter per worker: it keeps a warm spare CLI process while dictation is happening. */
let formatter: ClaudeFormatter | null = null;
function formatterFor(dataDir: string): ClaudeFormatter {
  formatter ??= new ClaudeFormatter(claudeRuntime(dataDir));
  return formatter;
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

function recordingConfig(config: WhisperConfig, sttModel: string, apiKey: string | null, dataDir: string) {
  return {
    sttModel,
    apiKey,
    polish: config.polish,
    translate: config.translate,
    format: config.polish ? formatFn(formatterFor(dataDir), config.formatModel) : null,
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    recStart: async ({ id, mime, model }, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const config = await readConfig(dataDir);
      const engine = selectEngine(model ?? config.sttModel, config.sttModel);
      if (engine.kind !== "scribe") return { ok: false as const, message: "Streaming recordings need ElevenLabs Scribe; whisper.cpp models go through bb's own path." };
      // Start the formatter's CLI now, while the user is still talking.
      if (config.polish) formatterFor(dataDir).warm(config.formatModel, config.translate);
      const apiKey = await readApiKey(dataDir);
      const entry = sessions.start({ id, mime, model: engine.model, session: createSession(recordingConfig(config, engine.model, apiKey, dataDir), { streaming: true }), startedAt: Date.now() });
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
      const dataDir = context.experimental_paths.dataDir;
      const config = await readConfig(dataDir);
      const engine = selectEngine(model ?? config.sttModel, config.sttModel);
      if (engine.kind !== "scribe") return { ok: false as const, message: "Retries need ElevenLabs Scribe." };
      if (config.polish) formatterFor(dataDir).warm(config.formatModel, config.translate);
      const apiKey = await readApiKey(dataDir);
      const entry = sessions.start({ id, mime, model: engine.model, session: createSession(recordingConfig(config, engine.model, apiKey, dataDir), { streaming: false }), startedAt: Date.now() });
      entry.session.append(Buffer.from(data, "base64"));
      void finishAndEmit(entry, (payload) => context.experimental_emitSignal("rec", payload), context.experimental_retainWorker());
      return { ok: true as const };
    },
    configure: async (config, context) => {
      await writeConfig(context.experimental_paths.dataDir, config);
      claudeProxy = config.claudeProxy;
      return { ok: true as const };
    },
    setApiKey: async ({ key }, context) => {
      const dataDir = context.experimental_paths.dataDir;
      await mkdir(dataDir, { recursive: true });
      const file = path.join(dataDir, API_KEY_FILE);
      await writeFile(file, `${key.trim()}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
      return { ok: true as const };
    },
    classify: async ({ texts }, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const config = await readConfig(dataDir);
      return { labels: await classifyTexts(claudeRuntime(dataDir), { texts, model: config.formatModel, signal: context.signal }) };
    },
    profile: async ({ sample, stats }, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const config = await readConfig(dataDir);
      const persona = await generatePersona(claudeRuntime(dataDir), { sample, stats, model: config.formatModel, signal: context.signal });
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
      const dataDir = context.experimental_paths.dataDir;
      const config = await readConfig(dataDir);
      // Boot the formatter's CLI while Scribe works.
      const formatModel = config.formatModel;
      if (config.polish && selectEngine(input.model, config.sttModel).kind === "scribe") formatterFor(dataDir).warm(formatModel, config.translate);
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
            apiKey: await readApiKey(dataDir),
            format: config.polish ? formatFn(formatterFor(dataDir), formatModel) : null,
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
  dispose: async () => {
    sessions.cancelAll();
    formatter?.dispose();
    formatter = null;
  },
});
