// bb's own composer mic records with MediaRecorder and POSTs the clip to
// `/api/v1/system/voice-transcription`, which bb bounds at 10 s per attempt
// and drops on failure. This bridge, installed by the content script, wraps
// both so the composer's clips take the plugin's path instead: slices stream
// to the server while the user speaks, nothing times out, and every clip is
// kept for retry. bb's UI is untouched; only the transport changes.
import { RecordingUpload, TranscriptionFailed, type RpcTransport } from "./rec-client";

export const BB_VOICE_PATH = "/api/v1/system/voice-transcription";
/** A recorder that stopped longer ago than this is not the one bb is asking about. */
const CLAIM_WINDOW_MS = 60_000;

export interface BridgeDeps {
  win: Window & typeof globalThis;
  rpc: RpcTransport;
  now?: () => number;
}

function isAudioOnly(stream: MediaStream): boolean {
  return stream.getAudioTracks().length > 0 && stream.getVideoTracks().length === 0;
}

function isBbVoiceRequest(input: RequestInfo | URL, init: RequestInit | undefined, origin: string): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return false;
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, origin).pathname === BB_VOICE_PATH;
  } catch {
    return false;
  }
}

function formFile(init: RequestInit | undefined): File | null {
  const body = init?.body;
  if (!(body instanceof FormData)) return null;
  const file = body.get("file");
  return file instanceof File ? file : null;
}

export function installComposerBridge(deps: BridgeDeps): () => void {
  const { win, rpc } = deps;
  const now = deps.now ?? (() => Date.now());
  const NativeRecorder = win.MediaRecorder;
  const nativeFetch = win.fetch;
  /** Uploads in flight for bb's recorders, newest last; claimed by the matching fetch. */
  const uploads: RecordingUpload[] = [];

  class BridgedMediaRecorder extends NativeRecorder {
    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      super(stream, options);
      if (!isAudioOnly(stream)) return;
      let upload: RecordingUpload | null = null;
      this.addEventListener("start", () => {
        upload = new RecordingUpload(rpc, "composer", this.mimeType || options?.mimeType || "audio/webm", { now });
        uploads.push(upload);
        if (uploads.length > 4) uploads.shift()?.cancel();
      });
      this.addEventListener("dataavailable", (event) => upload?.append((event as BlobEvent).data));
      this.addEventListener("stop", () => upload?.markStopped(now()));
    }
  }

  const claim = (): RecordingUpload | null => {
    for (let i = uploads.length - 1; i >= 0; i -= 1) {
      const candidate = uploads[i]!;
      const stoppedAt = candidate.stoppedAtMs;
      if (stoppedAt !== null && now() - stoppedAt < CLAIM_WINDOW_MS) {
        uploads.splice(i, 1);
        return candidate;
      }
    }
    return null;
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const bridgedFetch: typeof fetch = async (input, init) => {
    if (!isBbVoiceRequest(input, init, win.location.origin)) return nativeFetch.call(win, input, init);
    const signal = init?.signal ?? undefined;
    try {
      let upload = claim();
      if (upload === null) {
        // The recorder was not ours (or the wrap missed); send the whole file down our path instead.
        const file = formFile(init);
        if (file === null) return nativeFetch.call(win, input, init);
        upload = new RecordingUpload(rpc, "composer", file.type || "audio/webm", { now });
        upload.append(file);
        upload.markStopped(now());
      }
      const outcome = await upload.finish(signal);
      return json(200, { text: outcome.text });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const message = error instanceof TranscriptionFailed ? `${error.message} — saved in History, retry from the Voice panel.` : error instanceof Error ? error.message : String(error);
      return json(502, { error: { code: "transcription_failed", message } });
    }
  };

  try {
    win.MediaRecorder = BridgedMediaRecorder as typeof MediaRecorder;
    win.fetch = bridgedFetch;
  } catch {
    // A locked-down window: the dock still works, bb's composer keeps bb's path.
    return () => undefined;
  }
  return () => {
    if (win.MediaRecorder === BridgedMediaRecorder) win.MediaRecorder = NativeRecorder;
    if (win.fetch === bridgedFetch) win.fetch = nativeFetch;
    for (const upload of uploads.splice(0)) if (!upload.stopped) upload.cancel();
  };
}
