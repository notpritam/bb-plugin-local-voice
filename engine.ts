// The engine: ElevenLabs Scribe for recognition, then Claude (on the host's
// own Claude Code login) formats the dictation the way a transcriptionist
// would — fillers out, punctuation, lists, identifiers, Hindi in Latin
// letters or, when asked, English.
import type { ClaudeFormatter } from "./formatter.js";
import { DEFAULT_STT_MODEL, EngineError, scribeRequest } from "./scribe.js";
import { RecordingSession, pcmToWav } from "./stream.js";
import { failure, wavPcm, type AiServiceFailure } from "./whisper.js";

export type Engine = { kind: "whisper"; model: string } | { kind: "scribe"; model: string };

/**
 * `whisper-<name>` → whisper.cpp `ggml-<name>.bin`; `scribe…` → that ElevenLabs model;
 * anything else (old names such as `qwen3-asr`) → the configured ElevenLabs model.
 */
export function selectEngine(model: string, sttModel: string = DEFAULT_STT_MODEL): Engine {
  if (model.startsWith("whisper-")) return { kind: "whisper", model: model.slice("whisper-".length) };
  if (/^scribe/u.test(model)) return { kind: "scribe", model };
  return { kind: "scribe", model: sttModel };
}

/** Below this much remaining budget, ship Scribe's text rather than risk bb's timeout. */
export const MIN_POLISH_BUDGET_MS = 1500;
const BUDGET_MARGIN_MS = 250;
/** Ceiling for one Scribe request on the untimed path (our own recordings). */
export const ASR_CEILING_MS = 60_000;

export { EngineError };

/** The formatter step as the session sees it: text in, formatted text or null (keep Scribe's) out. */
export type FormatFn = (text: string, translate: boolean, signal: AbortSignal, budgetMs?: number) => Promise<string | null>;

export function formatFn(formatter: ClaudeFormatter, model: string): FormatFn {
  return (text, translate, signal, budgetMs) => formatter.format(text, { translate, model, signal, ...(budgetMs === undefined ? {} : { timeoutMs: budgetMs }) });
}

export interface ScribeTranscribeArgs {
  wav: Buffer;
  model: string;
  apiKey: string | null;
  polish: boolean;
  translate: boolean;
  format: FormatFn | null;
  /** Milliseconds left of bb's per-attempt budget. */
  remainingMs: () => number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}
export type ScribeTranscribeResult =
  | {
      ok: true;
      text: string;
      rawText: string;
      language: string | null;
      polished: boolean;
      translated: boolean;
      asrMs: number;
      polishMs: number | null;
    }
  | AiServiceFailure;

/**
 * The budgeted path (bb's AI-service call): the wav is cut into chunks that are
 * recognised in parallel, then formatted once if enough of the budget is left.
 */
export async function transcribeWithScribe(args: ScribeTranscribeArgs): Promise<ScribeTranscribeResult> {
  const pcm = wavPcm(args.wav);
  const format = args.format;
  const session = new RecordingSession({
    decode: async () => pcm,
    asr: (wav, signal) =>
      scribeRequest({ pcm: wavPcm(wav), apiKey: args.apiKey, model: args.model, signal, budgetMs: args.remainingMs() - BUDGET_MARGIN_MS, ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }) }),
    polish:
      args.polish && format !== null
        ? async (text, translate, signal) => {
            const budget = args.remainingMs() - BUDGET_MARGIN_MS;
            if (budget < MIN_POLISH_BUDGET_MS) return null;
            return format(text, translate, signal, budget);
          }
        : null,
    translate: args.translate,
    polishMode: "whole",
  });
  session.append(args.wav);
  const result = await session.finish();
  if (!result.ok) {
    const cause = result.cause;
    if (cause instanceof EngineError) return failure(cause.code, cause.message);
    return failure("request_failed", result.message);
  }
  return {
    ok: true,
    text: result.text,
    rawText: result.rawText,
    language: result.language,
    polished: result.polished,
    translated: result.translated,
    asrMs: result.asrMs,
    polishMs: result.polishMs,
  };
}

export { pcmToWav };
