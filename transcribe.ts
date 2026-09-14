import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WhisperConfig } from "./contract.js";
import { selectEngine, transcribeWithLlama } from "./engine.js";
import {
  MODEL_DOWNLOAD_BASE,
  SILENCE_DBFS,
  audioExtensionFor,
  buildFfmpegArgs,
  buildWhisperArgs,
  cleanTranscript,
  expandHome,
  failure,
  lastLine,
  resolveModelPath,
  wavDurationMs,
  wavRmsDb,
  type AiServiceFailure,
} from "./whisper.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The executable was not on PATH. */
  missing: boolean;
}
export type Runner = (
  cmd: string,
  args: string[],
  o: { signal: AbortSignal; timeoutMs: number },
) => Promise<RunResult>;

/** Spawn with a hard timeout and abort; never rejects for a missing binary. */
export const runCommand: Runner = (cmd, args, { signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error.code === "ENOENT") {
        resolve({ code: null, stdout, stderr: `${cmd} not found on PATH`, timedOut, missing: true });
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout, stderr, timedOut, missing: false });
    });
  });

export interface TranscribeRequest {
  model: string;
  audioBase64: string;
  mimeType: string;
  prompt: string | null;
  timeoutMs: number;
}
export interface TranscribeDeps {
  config: WhisperConfig;
  homeDir: string;
  tempRoot: string;
  run: Runner;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}
export interface TranscribeDetails {
  rawText: string;
  language: string | null;
  polished: boolean;
  translated: boolean;
  durationMs: number;
  asrMs: number | null;
  polishMs: number | null;
  engine: "llama" | "whisper";
}
export type TranscribeResult =
  | { ok: true; model: string; text: string; details: TranscribeDetails }
  | AiServiceFailure;

function stepFailure(tool: string, result: RunResult): AiServiceFailure | null {
  if (result.missing) {
    return failure("service_unavailable", `${tool} is not installed on this host (not found on PATH).`);
  }
  if (result.timedOut) {
    return failure("timeout", `${tool} did not finish in time.`);
  }
  if (result.code !== 0) {
    const detail = lastLine(result.stderr) || lastLine(result.stdout) || `exit code ${result.code}`;
    return failure("request_failed", `${tool} failed: ${detail}`);
  }
  return null;
}

export async function transcribeAudio(
  req: TranscribeRequest,
  deps: TranscribeDeps,
): Promise<TranscribeResult> {
  const engine = selectEngine(req.model);
  let whisperModelPath: string | null = null;
  if (engine.kind === "whisper") {
    const modelsDir = expandHome(deps.config.modelsDir, deps.homeDir);
    const model = resolveModelPath(engine.model, modelsDir);
    if (!model.ok) return model;
    try {
      await access(model.path);
    } catch {
      return failure(
        "service_unavailable",
        `Whisper model not found at ${model.path}. Download it with: curl -L -o "${model.path}" ${MODEL_DOWNLOAD_BASE}ggml-${engine.model}.bin`,
      );
    }
    whisperModelPath = model.path;
  }

  const startedAt = Date.now();
  const remaining = () => Math.max(1, req.timeoutMs - (Date.now() - startedAt));

  await mkdir(deps.tempRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(deps.tempRoot, "bb-whisper-"));
  try {
    const input = path.join(workDir, `in.${audioExtensionFor(req.mimeType)}`);
    const wav = path.join(workDir, "pcm16k.wav");
    await writeFile(input, Buffer.from(req.audioBase64, "base64"));

    const ffmpeg = await deps.run("ffmpeg", buildFfmpegArgs(input, wav), {
      signal: deps.signal,
      timeoutMs: remaining(),
    });
    const ffmpegFailure = stepFailure("ffmpeg", ffmpeg);
    if (ffmpegFailure) return ffmpegFailure;

    // Speech models hallucinate ("you", "Thank you.") on silence; skip them outright.
    // Best-effort: an unreadable wav is left for the engine to complain about.
    const wavBytes = await readFile(wav).catch(() => Buffer.alloc(0));
    const durationMs = wavDurationMs(wavBytes) ?? 0;
    const level = wavRmsDb(wavBytes);
    if (level !== null && level < SILENCE_DBFS) {
      return {
        ok: true,
        model: req.model,
        text: "",
        details: { rawText: "", language: null, polished: false, translated: false, durationMs, asrMs: null, polishMs: null, engine: engine.kind },
      };
    }

    if (engine.kind === "llama") {
      const result = await transcribeWithLlama({
        wav: wavBytes,
        model: engine.model,
        serverUrl: deps.config.serverUrl,
        polish: deps.config.polish,
        translate: deps.config.translate,
        polishModel: deps.config.polishModel,
        remainingMs: remaining,
        signal: deps.signal,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      if (!result.ok) return result;
      return {
        ok: true,
        model: req.model,
        text: result.text,
        details: {
          rawText: result.rawText,
          language: result.language,
          polished: result.polished,
          translated: result.translated,
          durationMs,
          asrMs: result.asrMs,
          polishMs: result.polishMs,
          engine: "llama",
        },
      };
    }

    const whisperStarted = Date.now();
    const whisper = await deps.run(
      "whisper-cli",
      buildWhisperArgs({
        modelPath: whisperModelPath!,
        wavPath: wav,
        threads: deps.config.threads,
        translate: deps.config.translate,
        prompt: req.prompt,
      }),
      { signal: deps.signal, timeoutMs: remaining() },
    );
    const whisperFailure = stepFailure("whisper-cli", whisper);
    if (whisperFailure) return whisperFailure;

    const text = cleanTranscript(whisper.stdout);
    return {
      ok: true,
      model: req.model,
      text,
      details: { rawText: text, language: null, polished: false, translated: false, durationMs, asrMs: Date.now() - whisperStarted, polishMs: null, engine: "whisper" },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
