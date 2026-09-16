// Host-side runtime for recording sessions: real ffmpeg/llama-server deps
// wired into RecordingSession, plus the registry of sessions in flight.
import { spawn } from "node:child_process";
import { ASR_CEILING_MS, POLISH_CEILING_MS, asrRequest, polishRequest } from "./engine.js";
import { RecordingSession, type SessionResult } from "./stream.js";

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
  serverUrl: string;
  asrModel: string;
  polish: boolean;
  translate: boolean;
  polishModel: string;
}

export interface SessionOptions {
  /** Slices arrive over time (polish per chunk as they land) vs. the whole clip at once. */
  streaming: boolean;
  fetchImpl?: typeof fetch;
  decode?: (bytes: Buffer, signal: AbortSignal) => Promise<Buffer>;
}

export function createSession(config: RecordingConfig, o: SessionOptions): RecordingSession {
  const fetchOpt = o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl };
  return new RecordingSession({
    decode: o.decode ?? decodeWithFfmpeg,
    asr: (wav, signal) => asrRequest({ wav, model: config.asrModel, serverUrl: config.serverUrl, signal, budgetMs: ASR_CEILING_MS, ...fetchOpt }),
    polish: config.polish
      ? (text, translate, signal) => polishRequest({ text, translate, model: config.polishModel, serverUrl: config.serverUrl, signal, budgetMs: POLISH_CEILING_MS, ...fetchOpt })
      : null,
    translate: config.translate,
    polishMode: o.streaming ? "groups" : "whole",
  });
}

export interface SessionEntry {
  id: string;
  mime: string;
  model: string;
  session: RecordingSession;
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

export type { SessionResult };
