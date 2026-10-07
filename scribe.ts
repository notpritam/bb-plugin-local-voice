// ElevenLabs Scribe (batch speech-to-text): one chunk of 16 kHz mono s16le PCM
// in, its transcript and language out. Called from the host worker on the
// primary host (the key is IP-restricted to it).
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AiServiceErrorCode } from "./whisper.js";

export const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const DEFAULT_STT_MODEL = "scribe_v2";
/** The key file in the host's data dir (mode 600, written by the server from the secret setting, or by hand). */
export const API_KEY_FILE = "elevenlabs-api-key";
export const API_KEY_ENV = "ELEVENLABS_API_KEY";

/**
 * Words Scribe should expect (one form field each: under 50 characters, at most 5 words).
 * Keep the list well under 100: past that ElevenLabs bills a 20 s minimum per request.
 */
export const KEYTERMS = [
  "HQ", "Brief", "MCAVA", "Kawa", "shadcn", "Zeus", "TRD", "PRD", "Bug Dossier", "FoundKeep",
  "Riya", "omni", "bb", "Claude", "Codex", "Storybook", "Hinglish", "Supabase", "Vercel", "Pritam",
] as const;

export class EngineError extends Error {
  constructor(
    readonly code: AiServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** The key: the host's key file first, then $ELEVENLABS_API_KEY. Null when neither is set. */
export async function readApiKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const key = (await readFile(path.join(dataDir, API_KEY_FILE), "utf8")).trim();
    if (key !== "") return key;
  } catch {
    // no file
  }
  const fromEnv = env[API_KEY_ENV]?.trim() ?? "";
  return fromEnv === "" ? null : fromEnv;
}

const LANGUAGE_NAMES: Record<string, string> = {
  eng: "English", en: "English",
  hin: "Hindi", hi: "Hindi",
  ben: "Bengali", tam: "Tamil", tel: "Telugu", mar: "Marathi", guj: "Gujarati", kan: "Kannada", mal: "Malayalam", pan: "Punjabi", urd: "Urdu",
  spa: "Spanish", fra: "French", deu: "German", ita: "Italian", por: "Portuguese", nld: "Dutch", rus: "Russian",
  jpn: "Japanese", kor: "Korean", cmn: "Chinese", zho: "Chinese", ara: "Arabic",
};

/** Scribe's ISO 639-3 code → a language name for History and Insights ("eng" → "English"); unknown codes stay as they are. */
export function languageName(code: unknown): string | null {
  if (typeof code !== "string" || code.trim() === "") return null;
  const key = code.trim().toLowerCase();
  return LANGUAGE_NAMES[key] ?? key;
}

/** A fetch bounded by both an abort signal and a time ceiling. */
export async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  budgetMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, Math.max(1, budgetMs));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { detail?: { message?: unknown; status?: unknown } | string; message?: unknown; error?: unknown };
    if (typeof json.detail === "string") return json.detail;
    if (typeof json.detail?.message === "string") return json.detail.message;
    if (typeof json.message === "string") return json.message;
    if (typeof json.error === "string") return json.error;
  } catch {
    // not JSON
  }
  return text.trim() !== "" ? text.trim().slice(0, 200) : `HTTP ${response.status}`;
}

/** An HTTP failure from ElevenLabs → the plugin's error codes, with a plain message. */
export function scribeHttpError(status: number, detail: string): EngineError {
  if (status === 401 || status === 403) {
    return new EngineError("service_unavailable", `ElevenLabs rejected the API key (HTTP ${status}): ${detail}. Check the ElevenLabs API key in the Local Voice settings.`);
  }
  if (status === 429) return new EngineError("rate_limited", `ElevenLabs is rate-limiting speech-to-text right now: ${detail}`);
  if (status >= 500) return new EngineError("service_unavailable", `ElevenLabs speech-to-text is unavailable (HTTP ${status}): ${detail}`);
  return new EngineError("request_failed", `Speech recognition failed (HTTP ${status}): ${detail}`);
}

function networkError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (error instanceof Error && error.name === "AbortError") return new EngineError("timeout", "Speech recognition did not finish in time.");
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
  return new EngineError("service_unavailable", `ElevenLabs could not be reached (${detail}).`);
}

export interface ScribeRequest {
  /** 16 kHz mono s16le PCM, no header. */
  pcm: Buffer;
  apiKey: string | null;
  model: string;
  signal: AbortSignal;
  /** Time ceiling for this one request. */
  budgetMs: number;
  keyterms?: readonly string[];
  fetchImpl?: typeof fetch;
}

/** Scribe refuses audio shorter than about 0.1 s ("audio_too_short"); such a sliver carries no words. */
export const MIN_AUDIO_BYTES = 100 * 32;

/** One chunk of speech → its transcript (Hindi comes back in Devanagari). Throws EngineError. */
export async function scribeRequest(o: ScribeRequest): Promise<{ language: string | null; text: string }> {
  if (o.pcm.length < MIN_AUDIO_BYTES) return { language: null, text: "" };
  if (o.apiKey === null || o.apiKey === "") {
    throw new EngineError("service_unavailable", "No ElevenLabs API key: set it in the Local Voice settings (ElevenLabs API key) or as ELEVENLABS_API_KEY on the host.");
  }
  const fetchImpl = o.fetchImpl ?? fetch;
  const form = new FormData();
  form.set("model_id", o.model);
  form.set("file", new Blob([new Uint8Array(o.pcm)], { type: "application/octet-stream" }), "audio.pcm");
  form.set("file_format", "pcm_s16le_16");
  form.set("no_verbatim", "true");
  form.set("tag_audio_events", "false");
  form.set("timestamps_granularity", "none");
  for (const term of o.keyterms ?? KEYTERMS) form.append("keyterms", term);
  let response: Response;
  try {
    response = await boundedFetch(fetchImpl, SCRIBE_URL, { method: "POST", headers: { "xi-api-key": o.apiKey }, body: form }, o.signal, o.budgetMs);
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) {
    const detail = await readErrorMessage(response);
    if (response.status === 400 && /too short/iu.test(detail)) return { language: null, text: "" };
    throw scribeHttpError(response.status, detail);
  }
  const json = (await response.json().catch(() => null)) as { text?: unknown; language_code?: unknown } | null;
  if (json === null || typeof json.text !== "string") throw new EngineError("invalid_response", "ElevenLabs returned no transcript.");
  return { language: languageName(json.language_code), text: json.text.trim() };
}
