// Browser-side adapters for the dock: microphone capture and bb's endpoint.
import type { Recorder } from "./voice-dock";

export const MIME_PREFERENCE = ["audio/webm", "audio/mp4", "audio/ogg"] as const;
const ENDPOINT = "/api/v1/system/voice-transcription";

export function pickMimeType(isSupported: (mimeType: string) => boolean): string | null {
  for (const mimeType of MIME_PREFERENCE) if (isSupported(mimeType)) return mimeType;
  return null;
}

export function fileNameFor(mimeType: string): string {
  const base = mimeType.split(";")[0] ?? "";
  const ext = base.includes("ogg") ? "ogg" : base.includes("mp4") ? "mp4" : "webm";
  // `bb-dock.*` lets the host tell dock clips from bb's own composer (`recording.*`).
  return `bb-dock.${ext}`;
}

export function isVoiceSupported(win: Window = window): boolean {
  const mediaDevices = (win.navigator as Navigator | undefined)?.mediaDevices;
  return (
    win.isSecureContext === true &&
    typeof mediaDevices?.getUserMedia === "function" &&
    typeof (win as Window & { MediaRecorder?: unknown }).MediaRecorder === "function"
  );
}

export async function createMediaRecorder(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMimeType((candidate) => MediaRecorder.isTypeSupported(candidate));
  const recorder = mimeType === null ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  recorder.start();
  return {
    stop: () =>
      new Promise<File>((resolve, reject) => {
        recorder.onstop = () => {
          stopTracks();
          const type = recorder.mimeType || mimeType || "audio/webm";
          resolve(new File(chunks, fileNameFor(type), { type }));
        };
        recorder.onerror = () => {
          stopTracks();
          reject(new Error("Voice recording failed"));
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = null;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // already stopped
      }
      stopTracks();
    },
  };
}

/** Same endpoint bb's own composer mic uses, so `BB_TRANSCRIPTION` decides the backend. */
export async function transcribeViaBb(
  file: File,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new FormData();
  body.set("file", file, file.name);
  const response = await fetchImpl(ENDPOINT, { method: "POST", body, credentials: "same-origin", signal });
  if (!response.ok) {
    let message = `Voice transcription failed (${response.status})`;
    try {
      const json: unknown = await response.json();
      if (json !== null && typeof json === "object" && typeof (json as { message?: unknown }).message === "string") {
        message = (json as { message: string }).message;
      }
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  const json: unknown = await response.json();
  const text = json !== null && typeof json === "object" ? (json as { text?: unknown }).text : undefined;
  if (typeof text !== "string") throw new Error("Voice transcription returned no text");
  return text;
}
