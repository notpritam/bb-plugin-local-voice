// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { BB_VOICE_PATH, installComposerBridge } from "./composer-bridge";
import type { RpcTransport } from "./rec-client";

/** Minimal MediaRecorder: addEventListener-based, like the real one bb drives. */
class FakeNativeRecorder extends EventTarget {
  static isTypeSupported = (_m: string) => true;
  state = "inactive";
  mimeType: string;
  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
  }
  start() {
    this.state = "recording";
    this.dispatchEvent(new Event("start"));
  }
  emit(bytes: string) {
    const event = new Event("dataavailable") as Event & { data: Blob };
    event.data = new Blob([bytes], { type: this.mimeType });
    this.dispatchEvent(event);
  }
  stop() {
    this.state = "inactive";
    this.emit("tail");
    this.dispatchEvent(new Event("stop"));
  }
}

const audioStream = { getAudioTracks: () => [{}], getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;

function fakeRpc(results: Record<string, unknown[]> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const rpc: RpcTransport = {
    call: vi.fn(async (method: string, input: unknown) => {
      calls.push({ method, input });
      const queue = results[method];
      if (queue !== undefined && queue.length > 0) return queue.shift() as never;
      if (method === "rec_result") return { status: "done", id: 9, text: "From the composer." } as never;
      return { ok: true } as never;
    }),
  };
  return { rpc, calls };
}

function makeWindow(nativeFetch: typeof fetch) {
  return { MediaRecorder: FakeNativeRecorder, fetch: nativeFetch, location: { origin: "https://bb.local" } } as unknown as Window & typeof globalThis;
}

describe("installComposerBridge", () => {
  it("streams bb's own recorder through the plugin and answers bb's fetch with the text", async () => {
    const nativeFetch = vi.fn(async () => new Response("native"));
    const win = makeWindow(nativeFetch as unknown as typeof fetch);
    const { rpc, calls } = fakeRpc();
    const uninstall = installComposerBridge({ win, rpc });

    // bb creates its recorder exactly like before…
    const Recorder = win.MediaRecorder as unknown as typeof FakeNativeRecorder;
    expect(Recorder.isTypeSupported("audio/webm")).toBe(true);
    const recorder = new Recorder(audioStream, { mimeType: "audio/webm" });
    recorder.start();
    recorder.emit("one");
    recorder.stop();
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "rec_append")).toHaveLength(2));
    expect(calls[0]).toMatchObject({ method: "rec_start", input: { surface: "composer", mime: "audio/webm" } });

    // …and posts the clip to bb's endpoint, which now resolves through our session.
    const form = new FormData();
    form.set("file", new File(["one", "tail"], "recording.webm", { type: "audio/webm" }));
    const response = await win.fetch(`https://bb.local${BB_VOICE_PATH}`, { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "From the composer." });
    expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_append", "rec_append", "rec_finish", "rec_result"]);
    expect(nativeFetch).not.toHaveBeenCalled();

    // Everything else still goes to the real fetch.
    await win.fetch("https://bb.local/api/v1/threads", { method: "GET" });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    uninstall();
    expect(win.MediaRecorder).toBe(FakeNativeRecorder);
  });

  it("sends the whole file when no bridged recorder matches, and shapes failures like bb's errors", async () => {
    const nativeFetch = vi.fn(async () => new Response("native"));
    const win = makeWindow(nativeFetch as unknown as typeof fetch);
    const { rpc, calls } = fakeRpc({ rec_result: [{ status: "failed", id: 3, message: "Speech recognition failed: router down" }] });
    installComposerBridge({ win, rpc });
    const form = new FormData();
    form.set("file", new File(["whole"], "recording.webm", { type: "audio/webm" }));
    const response = await win.fetch(BB_VOICE_PATH, { method: "POST", body: form });
    expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_append", "rec_finish", "rec_result"]);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "transcription_failed", message: "Speech recognition failed: router down — saved in History, retry from the Voice panel." } });
  });

  it("leaves video recorders and non-voice requests alone", async () => {
    const nativeFetch = vi.fn(async () => new Response("native"));
    const win = makeWindow(nativeFetch as unknown as typeof fetch);
    const { rpc, calls } = fakeRpc();
    installComposerBridge({ win, rpc });
    const Recorder = win.MediaRecorder as unknown as typeof FakeNativeRecorder;
    const screen = new Recorder({ getAudioTracks: () => [{}], getVideoTracks: () => [{}], getTracks: () => [] } as unknown as MediaStream);
    screen.start();
    screen.emit("frame");
    screen.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0);
    await win.fetch(BB_VOICE_PATH, { method: "GET" });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("rethrows an abort so bb goes idle while the server keeps transcribing", async () => {
    const win = makeWindow(vi.fn() as unknown as typeof fetch);
    const controller = new AbortController();
    const { rpc } = fakeRpc({ rec_result: [new Promise(() => {})] });
    installComposerBridge({ win, rpc });
    const form = new FormData();
    form.set("file", new File(["x"], "recording.webm", { type: "audio/webm" }));
    const pending = win.fetch(BB_VOICE_PATH, { method: "POST", body: form, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
