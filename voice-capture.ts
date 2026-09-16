// Browser-side adapters for the dock: microphone capture that streams its
// slices to the plugin while recording.
import { RecordingUpload, TranscriptionFailed, type RpcTransport, type Surface } from "./rec-client";
import type { Recorder } from "./voice-dock";

export const MIME_PREFERENCE = ["audio/webm", "audio/mp4", "audio/ogg"] as const;
/** MediaRecorder hands over a slice this often; each goes straight to the server. */
export const SLICE_MS = 1000;

export function pickMimeType(isSupported: (mimeType: string) => boolean): string | null {
  for (const mimeType of MIME_PREFERENCE) if (isSupported(mimeType)) return mimeType;
  return null;
}

export function isVoiceSupported(win: Window = window): boolean {
  const mediaDevices = (win.navigator as Navigator | undefined)?.mediaDevices;
  return (
    win.isSecureContext === true &&
    typeof mediaDevices?.getUserMedia === "function" &&
    typeof (win as Window & { MediaRecorder?: unknown }).MediaRecorder === "function"
  );
}

/** What a transcription failure says on the dock: the audio is safe, the retry is a click away. */
export function describeFailure(error: unknown): string {
  if (error instanceof TranscriptionFailed) {
    return error.clipId === null ? `${error.message} — saved in History, retry from the Voice panel.` : `${error.message} — click the mic (or Ctrl+Shift+Space) to retry.`;
  }
  return error instanceof Error && error.message !== "" ? error.message : "Voice transcription failed";
}

export interface CaptureDeps {
  rpc: RpcTransport;
  surface?: Surface;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorderImpl?: typeof MediaRecorder;
}

export async function createStreamingRecorder(deps: CaptureDeps): Promise<Recorder> {
  const getUserMedia = deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
  const Impl = deps.MediaRecorderImpl ?? MediaRecorder;
  const stream = await getUserMedia({ audio: true });
  const mimeType = pickMimeType((candidate) => Impl.isTypeSupported(candidate));
  const recorder = mimeType === null ? new Impl(stream) : new Impl(stream, { mimeType });
  const upload = new RecordingUpload(deps.rpc, deps.surface ?? "field", recorder.mimeType || mimeType || "audio/webm");
  recorder.ondataavailable = (event) => upload.append(event.data);
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => {
      stopTracks();
      upload.markStopped();
      resolve();
    };
    recorder.onerror = () => {
      stopTracks();
      reject(new Error("Voice recording failed"));
    };
  });
  recorder.start(SLICE_MS);
  return {
    stop: async (signal) => {
      recorder.stop();
      await stopped;
      // A TranscriptionFailed carries the clip id, which lets the dock offer a retry on the spot.
      return (await upload.finish(signal)).text;
    },
    cancel: () => {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // already stopped
      }
      stopTracks();
      upload.cancel();
    },
  };
}
