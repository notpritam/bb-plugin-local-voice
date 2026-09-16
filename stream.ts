// A recording session: audio arrives in slices while the user is still
// talking, the wav is decoded progressively, and every ~5 s of speech is cut
// at a pause and sent to the recogniser right away (four in flight). By the
// time the user stops, only the tail chunk and one polish pass remain — the
// wait no longer grows with the length of the clip. The same session, fed
// all at once, is the non-streamed path (retries, the CLI).

export const PCM_BYTES_PER_MS = 32; // 16 kHz mono s16le
export const SILENCE_DBFS = -50;

export interface ChunkText {
  language: string | null;
  text: string;
}

export interface SessionDeps {
  /** Container bytes (webm/ogg/mp4, possibly truncated) → 16 kHz mono s16le PCM. */
  decode: (bytes: Buffer, signal: AbortSignal) => Promise<Buffer>;
  /** One chunk of speech, as a wav, → its transcript in its own language. */
  asr: (wav: Buffer, signal: AbortSignal) => Promise<ChunkText>;
  /** The transcriptionist pass over the joined text; null = polishing off. Returns null to keep the raw text. */
  polish: ((text: string, translate: boolean, signal: AbortSignal) => Promise<string | null>) | null;
  translate: boolean;
  /**
   * "groups": while the user is still talking, polish each run of chunks that
   * ends at a long pause (a finished thought), so the wait after stop is the
   * tail chunk plus one short polish. "whole": one polish of the joined text
   * at the end (maximum context; the wait grows with the clip).
   */
  polishMode?: "groups" | "whole";
  /** A quiet stretch at least this long closes a polish group. */
  groupPauseMs?: number;
  /** Chunk jobs allowed in flight at once (llama-server slots). */
  maxInFlight?: number;
  /** Cut when at least this much undispatched speech has been decoded. */
  targetMs?: number;
  /** Search window for the silence to cut at: [cut + minMs, cut + maxMs]. */
  minMs?: number;
  maxMs?: number;
  /** Re-decode the growing container at most this often while recording. */
  decodeEveryMs?: number;
  /** Ignore this much of a partial decode's tail (the last container frame may be incomplete). */
  tailGuardMs?: number;
  now?: () => number;
}

export type SessionResult =
  | {
      ok: true;
      text: string;
      rawText: string;
      language: string | null;
      durationMs: number;
      asrMs: number;
      polishMs: number | null;
      polished: boolean;
      translated: boolean;
      chunks: number;
    }
  | { ok: false; code: "cancelled" | "asr_failed" | "decode_failed"; message: string; cause?: unknown };

/** RMS level in dBFS of a PCM byte range; -Infinity for digital silence. */
export function pcmRmsDb(pcm: Buffer, fromByte = 0, toByte = pcm.length): number {
  const start = Math.max(0, fromByte - (fromByte % 2));
  const end = Math.min(pcm.length - (pcm.length % 2), toByte - (toByte % 2));
  const samples = (end - start) / 2;
  if (samples <= 0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = start; i < end; i += 2) {
    const s = pcm.readInt16LE(i) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}

/**
 * The quietest `windowMs` window whose start lies in [fromMs, toMs]: its midpoint
 * and level. Scans from the end so near-equal candidates resolve to the latest
 * one (longer chunks, fewer boundaries).
 */
export function quietestWindow(pcm: Buffer, fromMs: number, toMs: number, windowMs = 150, stepMs = 25): { at: number; level: number } {
  let bestAt = toMs;
  let best = Number.POSITIVE_INFINITY;
  for (let at = toMs; at >= fromMs; at -= stepMs) {
    const level = pcmRmsDb(pcm, at * PCM_BYTES_PER_MS, (at + windowMs) * PCM_BYTES_PER_MS);
    if (level < best - 0.5) {
      best = level;
      bestAt = at;
    }
  }
  // Cut in the middle of the quiet window, not at its edge.
  return { at: bestAt + Math.floor(windowMs / 2), level: best };
}

/** A window counts as a pause when it is near-silent or well below the surrounding speech. */
export function isPause(windowLevel: number, surroundingLevel: number): boolean {
  return windowLevel < SILENCE_DBFS + 10 || windowLevel < surroundingLevel - 15;
}

/** How long the quiet stretch around `atMs` is (bounded by `limitMs` each way). */
export function pauseSpanMs(pcm: Buffer, atMs: number, surroundingLevel: number, limitMs = 1500, windowMs = 150, stepMs = 25): number {
  const totalMs = Math.floor(pcm.length / PCM_BYTES_PER_MS);
  const quietAt = (start: number) => start >= 0 && start + windowMs <= totalMs && isPause(pcmRmsDb(pcm, start * PCM_BYTES_PER_MS, (start + windowMs) * PCM_BYTES_PER_MS), surroundingLevel);
  let left = atMs - Math.floor(windowMs / 2);
  let right = left;
  if (!quietAt(left)) return 0;
  while (atMs - left < limitMs && quietAt(left - stepMs)) left -= stepMs;
  while (right - atMs < limitMs && quietAt(right + stepMs)) right += stepMs;
  return right - left + windowMs;
}

/** Wrap raw 16 kHz mono s16le PCM in a RIFF header. */
export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Most frequent non-null language across chunks (as first spelled); ties go to the earliest. */
export function majorityLanguage(chunks: readonly ChunkText[]): string | null {
  const counts = new Map<string, { spelled: string; count: number }>();
  for (const c of chunks) {
    if (c.language === null || c.text === "") continue;
    const key = c.language.toLowerCase();
    const entry = counts.get(key);
    if (entry === undefined) counts.set(key, { spelled: c.language, count: 1 });
    else entry.count += 1;
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const { spelled, count } of counts.values()) {
    if (count > bestCount) {
      best = spelled;
      bestCount = count;
    }
  }
  return best;
}

export function joinChunkTexts(chunks: readonly ChunkText[]): string {
  return chunks
    .map((c) => c.text.trim())
    .filter((t) => t !== "")
    .join(" ");
}

class Semaphore {
  private readonly waiters: (() => void)[] = [];
  private active = 0;
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await job();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

interface ChunkOutcome extends ChunkText {
  asrMs: number;
}
interface ChunkJob {
  fromMs: number;
  toMs: number;
  /** The cut after this chunk sat in a pause at least `groupPauseMs` long (or the clip ended). */
  closesGroup: boolean;
  result: Promise<ChunkOutcome>;
  outcome: ChunkOutcome | null;
}
interface PolishGroup {
  /** Indexes into `jobs`, contiguous. */
  first: number;
  last: number;
  rawText: string;
  result: Promise<{ text: string | null; polishMs: number }>;
}

export class RecordingSession {
  private readonly parts: Buffer[] = [];
  private bytes = 0;
  private bytesDecoded = 0;
  private lastPcm: Buffer | null = null;
  private lastDecodeAt = Number.NEGATIVE_INFINITY;
  private cutMs = 0;
  private decodedMs = 0;
  private readonly jobs: ChunkJob[] = [];
  private readonly groups: PolishGroup[] = [];
  private pump: Promise<void> = Promise.resolve();
  private finished = false;
  private readonly controller = new AbortController();
  private readonly gate: Semaphore;
  private readonly o: Required<Omit<SessionDeps, "polish">> & { polish: SessionDeps["polish"] };
  private lastActivity: number;
  /** The last error seen while decoding or recognising; finish() reports it. */
  private failure: { code: "asr_failed" | "decode_failed"; message: string; cause: unknown } | null = null;

  constructor(deps: SessionDeps) {
    this.o = {
      polishMode: "whole",
      groupPauseMs: 450,
      maxInFlight: 4,
      targetMs: 5000,
      minMs: 3000,
      maxMs: 12000,
      decodeEveryMs: 2000,
      tailGuardMs: 300,
      now: () => Date.now(),
      ...deps,
    };
    this.gate = new Semaphore(this.o.maxInFlight);
    this.lastActivity = this.o.now();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get bytesReceived(): number {
    return this.bytes;
  }
  get chunksDispatched(): number {
    return this.jobs.length;
  }
  get groupsPolished(): number {
    return this.groups.length;
  }
  get lastActivityAt(): number {
    return this.lastActivity;
  }

  /** Buffer a slice; decode and dispatch in the background when enough time has passed. */
  append(slice: Buffer): void {
    if (this.finished || this.controller.signal.aborted) return;
    this.parts.push(slice);
    this.bytes += slice.length;
    this.lastActivity = this.o.now();
    if (this.o.now() - this.lastDecodeAt >= this.o.decodeEveryMs) {
      this.lastDecodeAt = this.o.now();
      this.schedule(false);
    }
  }

  private schedule(final: boolean): void {
    this.pump = this.pump.then(() => this.decodeAndDispatch(final)).catch((error: unknown) => {
      if (this.failure === null) this.failure = { code: "decode_failed", message: error instanceof Error ? error.message : String(error), cause: error };
    });
  }

  private async decodeAndDispatch(final: boolean): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (this.bytesDecoded === this.bytes && !final) return;
    let pcm = this.lastPcm;
    if (pcm === null || this.bytesDecoded !== this.bytes) {
      pcm = await this.o.decode(Buffer.concat(this.parts), this.controller.signal);
      this.bytesDecoded = this.bytes;
      this.lastPcm = pcm;
    }
    const totalMs = Math.floor(pcm.length / PCM_BYTES_PER_MS);
    this.decodedMs = totalMs;
    const usableMs = final ? totalMs : Math.max(0, totalMs - this.o.tailGuardMs);
    // Prefer a real pause once `targetMs` of speech is waiting; never let a chunk grow past `maxMs`.
    while (usableMs - this.cutMs >= this.o.targetMs) {
      const from = this.cutMs;
      const searchFrom = from + this.o.minMs;
      const forced = usableMs - from >= this.o.maxMs;
      const searchTo = (forced ? from + this.o.maxMs : usableMs) - 150;
      if (searchTo <= searchFrom) break;
      const quiet = quietestWindow(pcm, searchFrom, searchTo);
      const surrounding = pcmRmsDb(pcm, searchFrom * PCM_BYTES_PER_MS, searchTo * PCM_BYTES_PER_MS);
      const pause = isPause(quiet.level, surrounding);
      if (!forced && !pause) break;
      const span = pause ? pauseSpanMs(pcm, quiet.at, surrounding) : 0;
      this.dispatch(pcm, from, quiet.at, span >= this.o.groupPauseMs);
    }
    if (final && totalMs > this.cutMs) this.dispatch(pcm, this.cutMs, totalMs, true);
  }

  private dispatch(pcm: Buffer, fromMs: number, toMs: number, closesGroup: boolean): void {
    this.cutMs = toMs;
    const slice = pcm.subarray(fromMs * PCM_BYTES_PER_MS, toMs * PCM_BYTES_PER_MS);
    const job: ChunkJob = { fromMs, toMs, closesGroup, outcome: null, result: Promise.resolve({ language: null, text: "", asrMs: 0 }) };
    job.result = this.gate.run(async (): Promise<ChunkOutcome> => {
      const started = this.o.now();
      const empty = { language: null, text: "", asrMs: 0 };
      if (pcmRmsDb(slice) < SILENCE_DBFS) return empty;
      try {
        const out = await this.o.asr(pcmToWav(slice), this.controller.signal);
        return { ...out, asrMs: this.o.now() - started };
      } catch (error) {
        if (this.failure === null) this.failure = { code: "asr_failed", message: error instanceof Error ? error.message : String(error), cause: error };
        return { ...empty, asrMs: this.o.now() - started };
      }
    });
    void job.result.then((outcome) => {
      job.outcome = outcome;
      if (this.o.polishMode === "groups") this.polishReadyGroups();
    });
    this.jobs.push(job);
  }

  /** Launch a polish for every complete group (all chunks recognised, closed by a long pause) not yet polished. */
  private polishReadyGroups(): void {
    if (this.o.polish === null) return;
    let first = this.groups.length === 0 ? 0 : this.groups[this.groups.length - 1]!.last + 1;
    for (let i = first; i < this.jobs.length; i += 1) {
      const job = this.jobs[i]!;
      if (job.outcome === null) return; // still recognising: nothing later can close yet, groups are in order
      if (!job.closesGroup) continue;
      this.launchGroup(first, i);
      first = i + 1;
    }
  }

  private launchGroup(first: number, last: number): void {
    const rawText = joinChunkTexts(this.jobs.slice(first, last + 1).map((j) => j.outcome ?? { language: null, text: "" }));
    const polish = this.o.polish;
    const started = this.o.now();
    const result =
      rawText === "" || polish === null
        ? Promise.resolve({ text: null, polishMs: 0 })
        : polish(rawText, this.o.translate, this.controller.signal)
            .then((text) => ({ text: text === null || text.trim() === "" ? null : text.trim(), polishMs: this.o.now() - started }))
            .catch(() => ({ text: null, polishMs: this.o.now() - started }));
    this.groups.push({ first, last, rawText, result });
  }

  /** Stop and throw everything away. */
  cancel(): void {
    this.finished = true;
    this.controller.abort();
  }

  /** Decode the rest, wait for every chunk, join, polish. */
  async finish(): Promise<SessionResult> {
    if (this.finished) return { ok: false, code: "cancelled", message: "The recording was cancelled." };
    this.finished = true;
    this.schedule(true);
    await this.pump;
    if (this.controller.signal.aborted) return { ok: false, code: "cancelled", message: "The recording was cancelled." };
    const chunks = await Promise.all(this.jobs.map((j) => j.result));
    if (this.failure !== null) return { ok: false, ...this.failure };
    const durationMs = this.decodedMs;
    const rawText = joinChunkTexts(chunks);
    const asrMs = chunks.reduce((sum, c) => Math.max(sum, c.asrMs), 0);
    if (rawText === "") {
      return { ok: true, text: "", rawText: "", language: null, durationMs, asrMs, polishMs: null, polished: false, translated: false, chunks: chunks.length };
    }
    const language = majorityLanguage(chunks);
    const translated = this.o.translate && language !== null && language.toLowerCase() !== "english";
    const raw = { ok: true as const, text: rawText, rawText, language, durationMs, asrMs, polishMs: null, polished: false, translated: false, chunks: chunks.length };
    if (this.o.polish === null) return raw;
    if (this.o.polishMode === "groups") {
      // The tail always closes a group, so after this every chunk belongs to one.
      this.polishReadyGroups();
      const results = await Promise.all(this.groups.map((g) => g.result));
      const spoken = this.groups.map((g, i) => ({ raw: g.rawText, polished: results[i]!.text })).filter((g) => g.raw !== "");
      const allPolished = spoken.every((g) => g.polished !== null);
      const text = spoken.map((g) => g.polished ?? g.raw).join(" ");
      const polishMs = results.reduce((sum, r) => Math.max(sum, r.polishMs), 0);
      return allPolished ? { ...raw, text, polishMs, polished: true, translated } : { ...raw, text, polishMs: null, polished: false };
    }
    const polishStarted = this.o.now();
    try {
      const polished = await this.o.polish(rawText, this.o.translate, this.controller.signal);
      if (polished === null || polished.trim() === "") return raw;
      return { ...raw, text: polished.trim(), polishMs: this.o.now() - polishStarted, polished: true, translated };
    } catch {
      return raw;
    }
  }
}
