// Browser-side client for the plugin's recording RPCs: slices go up as they
// are recorded, the outcome is long-polled. No bb transcription timeout is
// involved and the audio is kept on the server from the first slice.
import type { RecResultDto } from "./insights/rpc";

export type Surface = "composer" | "field" | "cli" | "other";

export interface RpcTransport {
  call<T>(method: string, input: unknown, signal?: AbortSignal): Promise<T>;
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** `POST /api/v1/plugins/<id>/rpc/<method>` with the input as the JSON body. */
export function createRpcTransport(pluginId: string, fetchImpl: typeof fetch = fetch, base = ""): RpcTransport {
  return {
    async call<T>(method: string, input: unknown, signal?: AbortSignal): Promise<T> {
      const response = await fetchImpl(`${base}/api/v1/plugins/${pluginId}/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? null),
        credentials: "same-origin",
        ...(signal === undefined ? {} : { signal }),
      });
      type Envelope = { ok?: boolean; result?: T; error?: { code?: string; message?: string } | string };
      let json: Envelope | null = null;
      try {
        json = (await response.json()) as Envelope;
      } catch {
        json = null;
      }
      if (json === null || json.ok !== true) {
        const error = json?.error;
        const message = typeof error === "string" ? error : (error?.message ?? `bb answered ${response.status}`);
        const code = typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : `http_${response.status}`;
        throw new RpcError(code, message);
      }
      return json.result as T;
    },
  };
}

export function newClipUid(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `clip-${[...random(16)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

export interface RecordingOutcome {
  id: number;
  text: string;
}

export class TranscriptionFailed extends Error {
  constructor(
    message: string,
    readonly clipId: number | null,
  ) {
    super(message);
    this.name = "TranscriptionFailed";
  }
}

const RESULT_POLL_CEILING_MS = 15 * 60_000;

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * One recording: `append` slices as MediaRecorder hands them over, then
 * `finish` to wait for the text. If the server could not be reached at the
 * start, slices are buffered and sent whole at the end instead.
 */
export class RecordingUpload {
  readonly uid: string;
  /** Slices waiting to go up. */
  private readonly queue: Blob[] = [];
  /** Every slice ever handed over, for the whole-file fallback. */
  private readonly all: Blob[] = [];
  private uploading: Promise<void> = Promise.resolve();
  private seq = 0;
  private started: Promise<boolean>;
  private ended = false;
  private cancelled = false;
  readonly startedAt: number;
  private stoppedAt: number | null = null;

  constructor(
    private readonly rpc: RpcTransport,
    readonly surface: Surface,
    readonly mime: string,
    o: { uid?: string; now?: () => number } = {},
  ) {
    this.uid = o.uid ?? newClipUid();
    this.startedAt = (o.now ?? Date.now)();
    this.started = this.rpc
      .call<{ ok: boolean }>("rec_start", { uid: this.uid, surface, mime })
      .then((r) => r.ok)
      .catch(() => false);
  }

  get stopped(): boolean {
    return this.stoppedAt !== null;
  }
  get stoppedAtMs(): number | null {
    return this.stoppedAt;
  }

  /** Hand over a slice; uploads run one at a time, in order. */
  append(slice: Blob): void {
    if (slice.size === 0 || this.cancelled) return;
    this.all.push(slice);
    this.queue.push(slice);
    this.uploading = this.uploading.then(async () => {
      if (!(await this.started)) return; // kept locally; sent whole at finish
      const next = this.queue.shift();
      if (next === undefined) return;
      const seq = this.seq;
      this.seq += 1;
      try {
        const r = await this.rpc.call<{ ok: boolean }>("rec_append", { uid: this.uid, seq, data: await blobToBase64(next) });
        if (!r.ok) this.queue.unshift(next);
      } catch {
        this.queue.unshift(next); // resent whole at finish
      }
    });
  }

  /** The recorder stopped; slices may still be in flight. */
  markStopped(now: number = Date.now()): void {
    if (this.stoppedAt === null) this.stoppedAt = now;
  }

  /** Wait for the text. Throws TranscriptionFailed (the audio stays on the server for a retry). */
  async finish(signal?: AbortSignal): Promise<RecordingOutcome> {
    if (this.ended) throw new TranscriptionFailed("This recording was already finished.", null);
    this.ended = true;
    this.markStopped();
    await this.uploading;
    const streamed = await this.started;
    if (!streamed || this.queue.length > 0) {
      // Whole-file fallback: everything we have, in one request.
      this.queue.length = 0;
      const blob = new Blob(this.all, { type: this.mime });
      if (streamed) {
        // Some slices never made it; the server-side row is incomplete, so send the lot under a fresh id.
        await this.rpc.call("rec_cancel", { uid: this.uid }).catch(() => undefined);
      }
      const uid = newClipUid();
      const r = await this.rpc.call<{ ok: boolean; id?: number; message?: string }>("rec_transcribe", { uid, surface: this.surface, mime: this.mime, data: await blobToBase64(blob) }).catch((error: unknown) => {
        throw new TranscriptionFailed(error instanceof Error ? error.message : String(error), null);
      });
      if (!r.ok) throw new TranscriptionFailed(r.message ?? "Could not start the transcription.", null);
      return this.poll(uid, signal);
    }
    const r = await this.rpc.call<{ ok: boolean; message?: string }>("rec_finish", { uid: this.uid }).catch((error: unknown) => {
      throw new TranscriptionFailed(error instanceof Error ? error.message : String(error), null);
    });
    if (!r.ok) throw new TranscriptionFailed(r.message ?? "Could not finish the recording.", null);
    return this.poll(this.uid, signal);
  }

  private async poll(uid: string, signal?: AbortSignal): Promise<RecordingOutcome> {
    const deadline = Date.now() + RESULT_POLL_CEILING_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError();
      // The server keeps transcribing after an abort; only the wait ends (the clip lands in History).
      const result = await raceAbort(this.rpc.call<RecResultDto>("rec_result", { uid }, signal), signal);
      if (result.status === "done") return { id: result.id, text: result.text };
      if (result.status === "failed") throw new TranscriptionFailed(result.message, result.id || null);
    }
    throw new TranscriptionFailed("Gave up waiting for the transcription; it stays in History.", null);
  }

  /** Throw the recording away (server row included). */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.ended = true;
    void this.started.then((ok) => (ok ? this.rpc.call("rec_cancel", { uid: this.uid }).catch(() => undefined) : undefined));
  }
}

/** Transcribe a kept clip again and wait for the text (the dock's retry). */
export async function retryClip(rpc: RpcTransport, clipId: number, signal?: AbortSignal): Promise<string> {
  const started = await rpc.call<{ ok: boolean; message?: string }>("clip_retry", { id: clipId }).catch((error: unknown) => {
    throw new TranscriptionFailed(error instanceof Error ? error.message : String(error), clipId);
  });
  if (!started.ok) throw new TranscriptionFailed(started.message ?? "Could not retry.", clipId);
  const deadline = Date.now() + RESULT_POLL_CEILING_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const result = await raceAbort(rpc.call<RecResultDto>("clip_wait", { id: clipId }, signal), signal);
    if (result.status === "done") return result.text;
    if (result.status === "failed") throw new TranscriptionFailed(result.message, clipId);
  }
  throw new TranscriptionFailed("Gave up waiting for the transcription; it stays in History.", clipId);
}
