import path from "node:path";
import type { WhisperConfig } from "./contract.js";

export const DEFAULT_CONFIG: WhisperConfig = {
  modelsDir: "~/.bb/whisper-models",
  threads: 12,
  translate: true,
  polish: true,
  serverUrl: "http://127.0.0.1:8091",
  polishModel: "gemma-4-e4b",
};
export const MODEL_DOWNLOAD_BASE =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

export type AiServiceErrorCode =
  | "timeout"
  | "rate_limited"
  | "service_unavailable"
  | "auth_required"
  | "request_failed"
  | "invalid_response";
export interface AiServiceFailure {
  ok: false;
  code: AiServiceErrorCode;
  message: string;
}
export function failure(code: AiServiceErrorCode, message: string): AiServiceFailure {
  return { ok: false, code, message };
}

const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MIN_THREADS = 1;
const MAX_THREADS = 64;

/** Settings arrive as loose strings/booleans; normalize once here. */
export function configFromSettings(values: {
  modelsDir?: unknown;
  threads?: unknown;
  translate?: unknown;
  polish?: unknown;
  serverUrl?: unknown;
  polishModel?: unknown;
}): WhisperConfig {
  const str = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  const modelsDir = str(values.modelsDir, DEFAULT_CONFIG.modelsDir);
  const serverUrl = str(values.serverUrl, DEFAULT_CONFIG.serverUrl).replace(/\/+$/u, "");
  const polishModel = str(values.polishModel, DEFAULT_CONFIG.polishModel);
  const parsedThreads =
    typeof values.threads === "string" ? Number.parseInt(values.threads, 10) : Number.NaN;
  const threads = Number.isFinite(parsedThreads)
    ? Math.min(MAX_THREADS, Math.max(MIN_THREADS, parsedThreads))
    : DEFAULT_CONFIG.threads;
  const translate =
    typeof values.translate === "boolean" ? values.translate : DEFAULT_CONFIG.translate;
  const polish = typeof values.polish === "boolean" ? values.polish : DEFAULT_CONFIG.polish;
  return { modelsDir, threads, translate, polish, serverUrl, polishModel };
}

export function expandHome(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2));
  return p;
}

export function resolveModelPath(
  model: string,
  modelsDir: string,
): { ok: true; path: string } | AiServiceFailure {
  if (!MODEL_NAME.test(model)) {
    return failure(
      "request_failed",
      `Invalid whisper model name "${model}". Use the file suffix of ggml-<model>.bin, e.g. "small" or "medium".`,
    );
  }
  return { ok: true, path: path.join(modelsDir, `ggml-${model}.bin`) };
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/mp4": "mp4",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
};
export function audioExtensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSIONS[base] ?? "bin";
}

export function buildFfmpegArgs(input: string, output: string): string[] {
  return ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output];
}

export function buildWhisperArgs(o: {
  modelPath: string;
  wavPath: string;
  threads: number;
  translate: boolean;
  prompt: string | null;
}): string[] {
  const args = ["-m", o.modelPath, "-f", o.wavPath, "-l", "auto", "-nt", "-np", "-t", String(o.threads)];
  if (o.translate) args.push("-tr");
  if (o.prompt !== null && o.prompt.trim() !== "") args.push("--prompt", o.prompt);
  return args;
}

/** whisper.cpp prints `[BLANK_AUDIO]`, `[_BEG_]`, `(silence)` style tags for non-speech. */
const TAG = /\[[^\]]*\]|\((?:silence|music|applause|laughter|noise)[^)]*\)/gi;
export function cleanTranscript(stdout: string): string {
  return stdout.replace(TAG, " ").replace(/\s+/g, " ").trim();
}

export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines[lines.length - 1] ?? "";
}

/** Below this RMS level the clip is treated as silence and whisper-cli is skipped. */
export const SILENCE_DBFS = -50;

/**
 * RMS level of a 16-bit PCM RIFF wav in dBFS (0 = full scale, -Infinity =
 * digital silence). Walks the RIFF chunks so ffmpeg's LIST/INFO metadata does
 * not get read as samples. Returns null when the buffer is not such a wav.
 */
export function wavRmsDb(buffer: Buffer): number | null {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "data") {
      const end = Math.min(buffer.length, start + size);
      const samples = Math.floor((end - start) / 2);
      if (samples === 0) return Number.NEGATIVE_INFINITY;
      let sum = 0;
      for (let i = 0; i < samples; i += 1) {
        const s = buffer.readInt16LE(start + i * 2) / 32768;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / samples);
      return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
    }
    offset = start + size + (size % 2);
  }
  return null;
}
