// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { TranscriptionFailed, type RpcTransport } from "./rec-client";
import { createStreamingRecorder, describeFailure, isVoiceSupported, pickMimeType } from "./voice-capture";

describe("pickMimeType", () => {
  it("returns the first supported type in preference order", () => {
    expect(pickMimeType((m) => m === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => true)).toBe("audio/webm");
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe("isVoiceSupported", () => {
  it("needs a secure context, mediaDevices, and MediaRecorder", () => {
    const base = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia: () => {} } }, MediaRecorder: class {} };
    expect(isVoiceSupported(base as unknown as Window)).toBe(true);
    expect(isVoiceSupported({ ...base, isSecureContext: false } as unknown as Window)).toBe(false);
    expect(isVoiceSupported({ ...base, MediaRecorder: undefined } as unknown as Window)).toBe(false);
    expect(isVoiceSupported({ ...base, navigator: {} } as unknown as Window)).toBe(false);
  });
});

describe("describeFailure", () => {
  it("points at History for a transcription failure and passes other errors through", () => {
    expect(describeFailure(new TranscriptionFailed("Router down", 4))).toBe("Router down — saved in History, retry from the Voice panel.");
    expect(describeFailure(new Error("mic broke"))).toBe("mic broke");
    expect(describeFailure("?")).toBe("Voice transcription failed");
  });
});

/** A MediaRecorder stand-in that emits one slice per `tick()` and a final one on stop. */
class FakeMediaRecorder {
  static isTypeSupported = (m: string) => m === "audio/webm";
  static instances: FakeMediaRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  timeslice: number | undefined;
  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  tick(bytes = "abc") {
    this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
  }
  stop() {
    this.state = "inactive";
    this.tick("tail");
    this.onstop?.();
  }
}

function fakeRpc(results: Record<string, unknown[]> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const rpc: RpcTransport = {
    call: vi.fn(async (method: string, input: unknown) => {
      calls.push({ method, input });
      const queue = results[method];
      if (queue !== undefined && queue.length > 0) return queue.shift() as never;
      if (method === "rec_result") return { status: "done", id: 7, text: "Hello there." } as never;
      return { ok: true } as never;
    }),
  };
  return { rpc, calls };
}

const stream = { getTracks: () => [{ stop: vi.fn() }], getAudioTracks: () => [{}], getVideoTracks: () => [] } as unknown as MediaStream;

describe("createStreamingRecorder", () => {
  it("streams slices as they land, finishes, and resolves the text", async () => {
    FakeMediaRecorder.instances = [];
    const { rpc, calls } = fakeRpc();
    const recorder = await createStreamingRecorder({ rpc, getUserMedia: async () => stream, MediaRecorderImpl: FakeMediaRecorder as unknown as typeof MediaRecorder });
    const media = FakeMediaRecorder.instances[0]!;
    expect(media.timeslice).toBe(1000);
    expect(media.mimeType).toBe("audio/webm");
    media.tick("one");
    media.tick("two");
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "rec_append")).toHaveLength(2));
    const text = await recorder.stop(new AbortController().signal);
    expect(text).toBe("Hello there.");
    expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_append", "rec_append", "rec_append", "rec_finish", "rec_result"]);
    expect(calls[0]!.input).toMatchObject({ surface: "field", mime: "audio/webm" });
    expect((calls[1]!.input as { seq: number; data: string })).toMatchObject({ seq: 0, data: btoa("one") });
    expect((calls[3]!.input as { data: string }).data).toBe(btoa("tail"));
  });

  it("falls back to sending the whole clip when the start call failed", async () => {
    FakeMediaRecorder.instances = [];
    const { rpc, calls } = fakeRpc({ rec_start: [Promise.reject(new Error("offline"))] });
    const recorder = await createStreamingRecorder({ rpc, getUserMedia: async () => stream, MediaRecorderImpl: FakeMediaRecorder as unknown as typeof MediaRecorder });
    const media = FakeMediaRecorder.instances[0]!;
    media.tick("one");
    media.tick("two");
    await expect(recorder.stop(new AbortController().signal)).resolves.toBe("Hello there.");
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["rec_start", "rec_transcribe", "rec_result"]);
    expect((calls[1]!.input as { data: string }).data).toBe(btoa("onetwotail"));
  });

  it("explains a failed transcription and where the audio went", async () => {
    FakeMediaRecorder.instances = [];
    const { rpc } = fakeRpc({ rec_result: [{ status: "failed", id: 3, message: "Speech recognition failed: router down" }] });
    const recorder = await createStreamingRecorder({ rpc, getUserMedia: async () => stream, MediaRecorderImpl: FakeMediaRecorder as unknown as typeof MediaRecorder });
    await expect(recorder.stop(new AbortController().signal)).rejects.toThrow("Speech recognition failed: router down — saved in History, retry from the Voice panel.");
  });

  it("cancel stops the tracks and discards the server row", async () => {
    FakeMediaRecorder.instances = [];
    const tracks = [{ stop: vi.fn() }];
    const { rpc, calls } = fakeRpc();
    const recorder = await createStreamingRecorder({ rpc, getUserMedia: async () => ({ ...stream, getTracks: () => tracks }) as unknown as MediaStream, MediaRecorderImpl: FakeMediaRecorder as unknown as typeof MediaRecorder });
    recorder.cancel();
    expect(tracks[0]!.stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_cancel"]));
  });
});
