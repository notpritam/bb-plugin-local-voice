// Host-side runtime for recording sessions: real ffmpeg, ElevenLabs Scribe and
// Claude formatter deps wired into RealtimeSession (live recordings) and
// RecordingSession (retries, and the fallback), plus the registry of
// sessions in flight.
import { spawn } from "node:child_process";
import { ASR_CEILING_MS, type FormatFn } from "./engine.js";
import { RealtimeSession, type RealtimeDeps, type Session } from "./realtime.js";
import { scribeRequest } from "./scribe.js";
import { RecordingSession, type SessionResult } from "./stream.js";
import { wavPcm } from "./whisper.js";

export const DECODE_CEILING_MS = 60_000;
/** A session nobody has touched for this long is abandoned (the browser went away). */
export const SESSION_IDLE_MS = 10 * 60_000;

/** Decode any container ffmpeg understands (even a truncated one) to 16 kHz mono s16le. */
export function decodeWithFfmpeg(bytes: Buffer, signal: AbortSignal, timeoutMs = DECODE_CEILING_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const onAbort = () => {
      kill();
      finish(() => reject(Object.assign(new Error("decode aborted"), { name: "AbortError" })));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error("ffmpeg did not finish in time")));
    }, timeoutMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(error.code === "ENOENT" ? new Error("ffmpeg is not installed on this host (not found on PATH).") : error));
    });
    child.on("close", (code) => {
      // A truncated container makes ffmpeg complain but still decode what it could.
      const pcm = Buffer.concat(out);
      if (code === 0 || pcm.length > 0) finish(() => resolve(pcm));
      else finish(() => reject(new Error(`ffmpeg failed: ${stderr.trim().split("\n").pop() ?? `exit code ${code}`}`)));
    });
    child.stdin.on("error", () => {
      // ffmpeg may close its input early; the close handler reports the outcome.
    });
    child.stdin.end(bytes);
  });
}

export interface RecordingConfig {
  /** ElevenLabs model id (scribe_v2). */
  sttModel: string;
  apiKey: string | null;
  polish: boolean;
  translate: boolean;
  /** The formatter; null = keep Scribe's text. */
  format: FormatFn | null;
}

export interface SessionOptions {
  /** Slices arrive over time vs. the whole clip at once (retries). Both format once, over the whole text. */
  streaming: boolean;
  fetchImpl?: typeof fetch;
  decode?: (bytes: Buffer, signal: AbortSignal) => Promise<Buffer>;
}

/** A live recording streams to Scribe v2 Realtime; a whole clip (and any realtime failure) takes the batch path. */
export function createSession(config: RecordingConfig, o: SessionOptions): Session {
  const format = config.format;
  const polish: RealtimeDeps["polish"] = config.polish && format !== null ? (text, translate, signal) => format(text, translate, signal) : null;
  const batch = () => batchSession(config, polish, o);
  if (!o.streaming || config.apiKey === null) return batch();
  return new RealtimeSession({ apiKey: config.apiKey, polish, translate: config.translate, fallback: batch });
}

function batchSession(config: RecordingConfig, polish: RealtimeDeps["polish"], o: SessionOptions): RecordingSession {
  const fetchOpt = o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl };
  return new RecordingSession({
    decode: o.decode ?? decodeWithFfmpeg,
    // Scribe takes no prompt, so the previous chunk's text (context) goes unused and chunks never wait on each other.
    asr: (wav, signal) => scribeRequest({ pcm: wavPcm(wav), apiKey: config.apiKey, model: config.sttModel, signal, budgetMs: ASR_CEILING_MS, ...fetchOpt }),
    polish,
    translate: config.translate,
    // Arranging a message needs all of it: one formatter pass over the joined text at finish.
    polishMode: "whole",
    contextWaitMs: 0,
  });
}

export interface SessionEntry {
  id: string;
  mime: string;
  model: string;
  session: Session;
  startedAt: number;
  /** Set once finish() has been requested; the outcome is emitted as a signal. */
  finishing: boolean;
}

export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();

  start(entry: Omit<SessionEntry, "finishing">): SessionEntry {
    this.entries.get(entry.id)?.session.cancel();
    const full = { ...entry, finishing: false };
    this.entries.set(entry.id, full);
    return full;
  }
  get(id: string): SessionEntry | null {
    return this.entries.get(id) ?? null;
  }
  delete(id: string): void {
    this.entries.delete(id);
  }
  get size(): number {
    return this.entries.size;
  }
  /** Cancel and drop sessions idle longer than `idleMs`; returns their ids. */
  sweep(now: number, idleMs = SESSION_IDLE_MS): string[] {
    const dropped: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.finishing || now - entry.session.lastActivityAt < idleMs) continue;
      entry.session.cancel();
      this.entries.delete(id);
      dropped.push(id);
    }
    return dropped;
  }
  cancelAll(): void {
    for (const entry of this.entries.values()) entry.session.cancel();
    this.entries.clear();
  }
}

export type { Session, SessionResult };
