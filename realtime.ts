// ElevenLabs Scribe v2 Realtime: a recording is decoded as its slices arrive
// and streamed to ElevenLabs while the user talks, so at Stop only the last
// fraction of a second is left to recognise (~0.2 s, where the batch path
// waited ~1 s on its last chunk). Anything going wrong on the way hands every
// byte received to the batch path (RecordingSession); the audio is never lost.
import { spawn } from "node:child_process";
import { hasDevanagari } from "./formatter.js";
import { KEYTERMS } from "./scribe.js";
import type { SessionResult } from "./stream.js";

export const REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
export const REALTIME_MODEL = "scribe_v2_realtime";
/** Most PCM in one message: 250 ms of 16 kHz mono s16le. */
export const MAX_CHUNK_BYTES = 8000;
/** How long Stop waits for the session to open and the last transcript to come back before the batch path takes over. */
export const FINAL_WAIT_MS = 5000;
const PCM_BYTES_PER_MS = 32;
/** A commit has to ride on an audio message; this much silence when nothing is left to send. */
const COMMIT_PAD = Buffer.alloc(20 * PCM_BYTES_PER_MS);

/** What host.ts drives: this session and the batch RecordingSession alike. */
export interface Session {
  append(slice: Buffer): void;
  finish(): Promise<SessionResult>;
  cancel(): void;
  readonly lastActivityAt: number;
}

/** The part of a WebSocket the session uses. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}
export type OpenSocket = (url: string, apiKey: string) => RealtimeSocket;

/** Node's WebSocket (undici) takes headers, which keeps the key out of the URL. */
export const openElevenLabsSocket: OpenSocket = (url, apiKey) => {
  const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => RealtimeSocket;
  return new Socket(url, { headers: { "xi-api-key": apiKey } });
};

/**
 * English with Hindi as the second language (Scribe stops guessing Russian for a Hinglish
 * opening), commits at pauses, fillers dropped, product names as keyterms.
 */
export function realtimeUrl(keyterms: readonly string[] = KEYTERMS): string {
  const query = new URLSearchParams({ model_id: REALTIME_MODEL, audio_format: "pcm_16000", commit_strategy: "vad", language_code: "en", no_verbatim: "true" });
  query.append("secondary_languages", "hi");
  for (const term of keyterms) query.append("keyterms", term);
  return `${REALTIME_URL}?${query}`;
}

export interface PcmDecoder {
  write(bytes: Buffer): void;
  /** No more input: resolves once every decoded byte has been handed over. */
  end(): Promise<void>;
  kill(): void;
}
export type StartDecoder = (onPcm: (pcm: Buffer) => void, onError: (error: Error) => void) => PcmDecoder;

/** ffmpeg reading the growing container on stdin and writing 16 kHz mono PCM as it goes (~30 ms behind). */
export const startFfmpegDecoder: StartDecoder = (onPcm, onError) => {
  const child = spawn(
    "ffmpeg",
    ["-loglevel", "error", "-fflags", "nobuffer", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0", "-flush_packets", "1", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let produced = 0;
  let stderr = "";
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  child.stdout.on("data", (chunk: Buffer) => {
    produced += chunk.length;
    onPcm(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    onError(error.code === "ENOENT" ? new Error("ffmpeg is not installed on this host (not found on PATH).") : error);
  });
  child.on("close", (code, signal) => {
    // A container that ends abruptly makes ffmpeg complain after decoding it all; only no audio at all is a failure.
    if (code !== 0 && signal === null && produced === 0) onError(new Error(`ffmpeg failed: ${stderr.trim().split("\n").pop() ?? `exit code ${code}`}`));
  });
  child.stdin.on("error", () => {
    // ffmpeg may close its input early; the close handler reports the outcome.
  });
  return {
    write: (bytes) => {
      if (child.stdin.writable) child.stdin.write(bytes);
    },
    end: async () => {
      child.stdin.end();
      await closed;
    },
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
};

export interface RealtimeDeps {
  apiKey: string;
  /** The batch path, handed every byte received, when realtime cannot answer. */
  fallback: () => Session;
  /** The formatter over the whole text at finish; null = keep Scribe's text. */
  polish: ((text: string, translate: boolean, signal: AbortSignal) => Promise<string | null>) | null;
  translate: boolean;
  openSocket?: OpenSocket;
  startDecoder?: StartDecoder;
  keyterms?: readonly string[];
  finalWaitMs?: number;
  now?: () => number;
}

const TIMED_OUT = Symbol("timed out");
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

export class RealtimeSession implements Session {
  /** Every container byte received, for the batch fallback. */
  private readonly parts: Buffer[] = [];
  /** Decoded audio waiting for the session to open. */
  private readonly unsent: Buffer[] = [];
  /** An odd trailing byte, held until its sample is complete. */
  private carry: Buffer = Buffer.alloc(0);
  private pcmBytes = 0;
  private opened = false;
  private failure: Error | null = null;
  /** Transcripts ElevenLabs committed at pauses, in order. */
  private readonly segments: string[] = [];
  private onOpen: (() => void) | null = null;
  /** Set while the final commit is out; the transcript that answers it (null = failed). */
  private onFinal: ((text: string | null) => void) | null = null;
  private finished = false;
  private readonly controller = new AbortController();
  private lastActivity: number;
  private readonly socket: RealtimeSocket | null;
  private readonly decoder: PcmDecoder;
  private readonly now: () => number;
  private readonly finalWaitMs: number;

  constructor(private readonly o: RealtimeDeps) {
    this.now = o.now ?? (() => Date.now());
    this.finalWaitMs = o.finalWaitMs ?? FINAL_WAIT_MS;
    this.lastActivity = this.now();
    this.decoder = (o.startDecoder ?? startFfmpegDecoder)(
      (pcm) => this.onPcm(pcm),
      (error) => this.fail(error),
    );
    let socket: RealtimeSocket | null = null;
    try {
      socket = (o.openSocket ?? openElevenLabsSocket)(realtimeUrl(o.keyterms), o.apiKey);
      socket.onmessage = (event) => this.onMessage(event.data);
      socket.onerror = () => this.fail(new Error("The ElevenLabs realtime connection failed."));
      socket.onclose = (event) => this.fail(new Error(`ElevenLabs closed the realtime session (${event.code}${event.reason === "" ? "" : `: ${event.reason}`}).`));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    this.socket = socket;
  }

  get lastActivityAt(): number {
    return this.lastActivity;
  }

  append(slice: Buffer): void {
    if (this.finished || slice.length === 0) return;
    this.parts.push(slice);
    this.lastActivity = this.now();
    if (this.failure === null) this.decoder.write(slice);
  }

  private onPcm(chunk: Buffer): void {
    this.pcmBytes += chunk.length;
    if (this.failure !== null) return;
    const joined = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    const even = joined.length - (joined.length % 2);
    this.carry = joined.subarray(even);
    if (even === 0) return;
    const pcm = joined.subarray(0, even);
    if (this.opened) this.send(pcm, false);
    else this.unsent.push(pcm);
  }

  private send(pcm: Buffer, commit: boolean): void {
    const audio = commit && pcm.length === 0 ? COMMIT_PAD : pcm;
    try {
      for (let at = 0; at < audio.length; at += MAX_CHUNK_BYTES) {
        const piece = audio.subarray(at, at + MAX_CHUNK_BYTES);
        const last = at + MAX_CHUNK_BYTES >= audio.length;
        this.socket?.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: piece.toString("base64"), commit: commit && last, sample_rate: 16000 }));
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onMessage(data: unknown): void {
    let message: { message_type?: unknown; text?: unknown; error?: unknown };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    switch (message.message_type) {
      case "session_started": {
        this.opened = true;
        const pending = Buffer.concat(this.unsent.splice(0));
        if (pending.length > 0) this.send(pending, false);
        this.onOpen?.();
        return;
      }
      case "committed_transcript": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        // After the final commit, the next transcript answers it; one already on its way from a pause only carried audio before it.
        if (this.onFinal !== null) {
          const answer = this.onFinal;
          this.onFinal = null;
          answer(text);
        } else if (text !== "") {
          this.segments.push(text);
        }
        return;
      }
      default:
        if (typeof message.error === "string") this.fail(new Error(`ElevenLabs: ${message.error}`));
    }
  }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.close();
  }

  private close(): void {
    this.decoder.kill();
    const socket = this.socket;
    if (socket !== null) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    this.onOpen?.();
    this.onFinal?.(null);
    this.onOpen = null;
    this.onFinal = null;
  }

  /** Stop and throw everything away. */
  cancel(): void {
    this.finished = true;
    this.controller.abort();
    this.close();
  }

  /** Flush the decoder, commit what is left and wait for its transcript; null when realtime cannot answer in time. */
  private async finalTranscript(): Promise<string | null> {
    const deadline = this.now() + this.finalWaitMs;
    if (this.failure !== null) return null;
    if ((await within(this.decoder.end(), deadline - this.now())) === TIMED_OUT) return null;
    if (!this.opened && this.failure === null) {
      await within(new Promise<void>((resolve) => (this.onOpen = resolve)), deadline - this.now());
      this.onOpen = null;
    }
    if (!this.opened || this.failure !== null) return null;
    const answer = new Promise<string | null>((resolve) => (this.onFinal = resolve));
    this.send(Buffer.alloc(0), true);
    const text = await within(answer, deadline - this.now());
    this.onFinal = null;
    return text === TIMED_OUT ? null : text;
  }

  /** Commit the rest, join the transcripts, format once over the whole text. */
  async finish(): Promise<SessionResult> {
    if (this.finished) return { ok: false, code: "cancelled", message: "The recording was cancelled." };
    this.finished = true;
    const stoppedAt = this.now();
    const last = await this.finalTranscript();
    this.close();
    if (this.controller.signal.aborted) return { ok: false, code: "cancelled", message: "The recording was cancelled." };
    const received = this.parts.reduce((sum, p) => sum + p.length, 0);
    if (last === null || (this.pcmBytes === 0 && received > 0)) {
      const batch = this.o.fallback();
      for (const part of this.parts) batch.append(part);
      return batch.finish();
    }
    if (last !== "") this.segments.push(last);
    const rawText = this.segments.join(" ").trim();
    const durationMs = Math.round(this.pcmBytes / PCM_BYTES_PER_MS);
    const asrMs = this.now() - stoppedAt;
    const chunks = this.segments.length;
    if (rawText === "") {
      return { ok: true, text: "", rawText: "", language: null, durationMs, asrMs, polishMs: null, polished: false, translated: false, chunks, model: REALTIME_MODEL };
    }
    const language = hasDevanagari(rawText) ? "Hindi" : "English";
    const translated = this.o.translate && language !== "English";
    const raw = { ok: true as const, text: rawText, rawText, language, durationMs, asrMs, polishMs: null, polished: false, translated: false, chunks, model: REALTIME_MODEL };
    if (this.o.polish === null) return raw;
    const polishStarted = this.now();
    try {
      const polished = await this.o.polish(rawText, this.o.translate, this.controller.signal);
      if (polished === null || polished.trim() === "") return raw;
      return { ...raw, text: polished.trim(), polishMs: this.now() - polishStarted, polished: true, translated };
    } catch {
      return raw;
    }
  }
}
