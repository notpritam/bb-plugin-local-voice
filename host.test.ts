import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcribeAudio = vi.fn();
vi.mock("./transcribe", async (importOriginal) => {
  const original = await importOriginal<typeof import("./transcribe")>();
  return { ...original, transcribeAudio };
});

const harnessFetch = vi.fn<typeof fetch>();
vi.mock("./classify", async (importOriginal) => {
  const original = await importOriginal<typeof import("./classify")>();
  return { ...original, classifyFetch: (...args: Parameters<typeof fetch>) => harnessFetch(...args) };
});

vi.mock("./profile", async (importOriginal) => {
  const original = await importOriginal<typeof import("./profile")>();
  return { ...original, profileFetch: (...args: Parameters<typeof fetch>) => harnessFetch(...args) };
});

const fakeAsr = vi.fn(async (_wav: Buffer) => ({ language: "Hindi", text: "नमस्ते" }));
const fakePolish = vi.fn(async (_text: string, translate: boolean) => (translate ? "Hello." : "नमस्ते।"));
vi.mock("./recording", async (importOriginal) => {
  const original = await importOriginal<typeof import("./recording")>();
  const { RecordingSession } = await import("./stream");
  return {
    ...original,
    createSession: (config: { polish: boolean; translate: boolean }, o: { streaming: boolean }) =>
      new RecordingSession({ decode: async (bytes: Buffer) => bytes, asr: fakeAsr, polish: config.polish ? fakePolish : null, translate: config.translate, polishMode: o.streaming ? "groups" : "whole" }),
  };
});

const { default: hostEntry } = await import("./host");
const { hostSignals } = await import("./contract");
const { PCM_BYTES_PER_MS } = await import("./stream");

function tone(ms: number): string {
  const pcm = Buffer.alloc(ms * PCM_BYTES_PER_MS);
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), i * 2);
  return pcm.toString("base64");
}

let root: string;
let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof hostEntry.contract, typeof hostSignals>>;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bbw-host-"));
  harness = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir: path.join(root, "data"), tempDir: path.join(root, "tmp") },
  });
  transcribeAudio.mockReset();
});
afterEach(async () => {
  await harness.experimental_dispose();
  await rm(root, { recursive: true, force: true });
});

const voiceInput = {
  serviceId: "local",
  model: "qwen3-asr",
  audioBase64: "AAAA",
  mimeType: "audio/webm",
  filename: "recording.webm",
  prompt: null,
  timeoutMs: 10_000,
};

describe("configure", () => {
  it("persists the config to <dataDir>/config.json", async () => {
    const config = { modelsDir: "/models", threads: 6, translate: false, polish: true, serverUrl: "http://127.0.0.1:8091", polishModel: "gemma-4-e4b", asrModel: "qwen3-asr" };
    await expect(harness.experimental_call("configure", config)).resolves.toEqual({ ok: true });
    expect(JSON.parse(await readFile(path.join(root, "data", "config.json"), "utf8"))).toEqual(config);
  });
});

describe("ai.voice.transcribe", () => {
  it("refuses another service id", async () => {
    const result = await harness.experimental_call("ai.voice.transcribe", { ...voiceInput, serviceId: "codex" });
    expect(result).toMatchObject({ ok: false, code: "request_failed" });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("uses defaults when nothing was configured", async () => {
    transcribeAudio.mockResolvedValue({ ok: true, model: "qwen3-asr", text: "hello" });
    const result = await harness.experimental_call("ai.voice.transcribe", voiceInput);
    expect(result).toEqual({ ok: true, model: "qwen3-asr", text: "hello" });
    const [request, deps] = transcribeAudio.mock.calls[0]!;
    expect(request).toEqual({ model: "qwen3-asr", audioBase64: "AAAA", mimeType: "audio/webm", prompt: null, timeoutMs: 10_000 });
    expect(deps.config).toEqual({ modelsDir: "~/.bb/whisper-models", threads: 12, translate: true, polish: true, serverUrl: "http://127.0.0.1:8091", polishModel: "gemma-4-e4b", asrModel: "qwen3-asr" });
    expect(deps.tempRoot).toBe(path.join(root, "tmp"));
    expect(deps.homeDir).toBe(os.homedir());
  });

  it("uses the persisted config on later calls", async () => {
    await harness.experimental_call("configure", { modelsDir: "/m", threads: 2, translate: false, polish: false, serverUrl: "http://x:1", polishModel: "t" });
    transcribeAudio.mockResolvedValue({ ok: true, model: "qwen3-asr", text: "" });
    await harness.experimental_call("ai.voice.transcribe", voiceInput);
    expect(transcribeAudio.mock.calls[0]![1].config).toEqual({ modelsDir: "/m", threads: 2, translate: false, polish: false, serverUrl: "http://x:1", polishModel: "t", asrModel: "qwen3-asr" });
  });

  it("passes failures through unchanged", async () => {
    transcribeAudio.mockResolvedValue({ ok: false, code: "timeout", message: "slow" });
    expect(await harness.experimental_call("ai.voice.transcribe", voiceInput)).toEqual({ ok: false, code: "timeout", message: "slow" });
  });

  it("turns an unexpected throw into request_failed", async () => {
    transcribeAudio.mockRejectedValue(new Error("disk full"));
    expect(await harness.experimental_call("ai.voice.transcribe", voiceInput)).toEqual({
      ok: false,
      code: "request_failed",
      message: "disk full",
    });
  });
});

describe("ai.inference.complete", () => {
  it("is not offered", async () => {
    const result = await harness.experimental_call("ai.inference.complete", {
      serviceId: "local",
      model: "qwen3-asr",
      reasoningEffort: "none",
      prompt: "hi",
      outputSchema: { type: "object" },
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ ok: false, code: "request_failed" });
  });
});

describe("clip signal", () => {
  it("emits one clip after a successful non-empty transcription", async () => {
    transcribeAudio.mockResolvedValue({
      ok: true,
      model: "qwen3-asr",
      text: "Hello.",
      details: { rawText: "hello", language: "English", polished: true, translated: false, durationMs: 1500, asrMs: 900, polishMs: 400, engine: "llama" },
    });
    const result = await harness.experimental_call("ai.voice.transcribe", { ...voiceInput, filename: "bb-dock.webm" });
    expect(result).toEqual({ ok: true, model: "qwen3-asr", text: "Hello." }); // details never leak to bb
    const signals = harness.experimental_getSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal: "clip",
      payload: {
        filename: "bb-dock.webm", mimeType: "audio/webm", language: "English", durationMs: 1500, rawText: "hello", text: "Hello.",
        polished: true, translated: false, asrMs: 900, polishMs: 400, engine: "llama", model: "qwen3-asr",
      },
    });
    expect(typeof (signals[0]!.payload as { at: number }).at).toBe("number");
  });
  it("does not emit for silence or failures", async () => {
    transcribeAudio.mockResolvedValueOnce({
      ok: true, model: "qwen3-asr", text: "",
      details: { rawText: "", language: null, polished: false, translated: false, durationMs: 800, asrMs: null, polishMs: null, engine: "llama" },
    });
    await harness.experimental_call("ai.voice.transcribe", voiceInput);
    transcribeAudio.mockResolvedValueOnce({ ok: false, code: "timeout", message: "slow" });
    await harness.experimental_call("ai.voice.transcribe", voiceInput);
    expect(harness.experimental_getSignals()).toHaveLength(0);
  });
});

describe("classify", () => {
  it("asks the polisher model for one label per text and tolerates bad answers", async () => {
    harnessFetch.mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const text = body.messages.at(-1)!.content;
      const label = text.includes("commit") ? "code" : text.includes("garbage") ? "banana" : "note";
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ category: label }) } }] }));
    }) as unknown as typeof fetch);
    const result = await harness.experimental_call("classify", { texts: ["commit and push this", "buy milk", "garbage"] });
    expect(result).toEqual({ labels: ["code", "note", null] });
  });
});

describe("profile", () => {
  it("returns the model's JSON persona", async () => {
    harnessFetch.mockImplementation((async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Context Clarifier", description: "You dictate plans.", catchphrase: "commit and push this", peakDescription: "Late nights." }) } }] }))) as unknown as typeof fetch);
    const result = await harness.experimental_call("profile", { sample: ["commit and push this", "refactor the user service"], stats: "Peak: Monday at 9 p.m." });
    expect(result).toEqual({ ok: true, title: "Context Clarifier", description: "You dictate plans.", catchphrase: "commit and push this", peakDescription: "Late nights." });
  });
  it("reports failure instead of throwing", async () => {
    harnessFetch.mockImplementation((async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    expect(await harness.experimental_call("profile", { sample: ["x"], stats: "" })).toEqual({ ok: false });
  });
});

describe("recording sessions", () => {
  const id = "clip-0123456789";

  it("streams slices in and reports the outcome as a `rec` signal", async () => {
    fakeAsr.mockClear();
    await expect(harness.experimental_call("recStart", { id, mime: "audio/webm", model: null })).resolves.toEqual({ ok: true });
    await expect(harness.experimental_call("recAppend", { id, seq: 0, data: tone(1000) })).resolves.toEqual({ ok: true });
    await expect(harness.experimental_call("recAppend", { id, seq: 1, data: tone(1000) })).resolves.toEqual({ ok: true });
    await expect(harness.experimental_call("recFinish", { id })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(harness.experimental_getSignals().filter((s) => s.signal === "rec")).toHaveLength(1));
    const [signal] = harness.experimental_getSignals().filter((s) => s.signal === "rec");
    expect(signal!.payload).toMatchObject({
      ok: true,
      id,
      mime: "audio/webm",
      model: "qwen3-asr",
      language: "Hindi",
      durationMs: 2000,
      rawText: "नमस्ते",
      text: "Hello.",
      polished: true,
      translated: true,
      chunks: 1,
    });
    expect(fakeAsr).toHaveBeenCalledTimes(1);
  });

  it("rejects slices for an unknown recording and tolerates a cancel of one", async () => {
    await expect(harness.experimental_call("recAppend", { id: "nope-000000000", seq: 0, data: "AAAA" })).resolves.toEqual({ ok: false, message: 'No recording "nope-000000000" in progress.' });
    await expect(harness.experimental_call("recFinish", { id: "nope-000000000" })).resolves.toMatchObject({ ok: false });
    await expect(harness.experimental_call("recCancel", { id: "nope-000000000" })).resolves.toEqual({ ok: true });
    await harness.experimental_call("recStart", { id, mime: "audio/webm", model: null });
    await expect(harness.experimental_call("recCancel", { id })).resolves.toEqual({ ok: true });
    await expect(harness.experimental_call("recAppend", { id, seq: 0, data: "AAAA" })).resolves.toMatchObject({ ok: false });
  });

  it("transcribes a whole clip at once (retry path) and honours a model override", async () => {
    fakeAsr.mockClear();
    await expect(harness.experimental_call("recTranscribe", { id, mime: "audio/webm", model: "qwen3-asr-0.6b", data: tone(1500) })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(harness.experimental_getSignals().filter((s) => s.signal === "rec")).toHaveLength(1));
    expect(harness.experimental_getSignals().filter((s) => s.signal === "rec")[0]!.payload).toMatchObject({ ok: true, id, model: "qwen3-asr-0.6b", durationMs: 1500, text: "Hello." });
  });

  it("refuses whisper.cpp models on the streaming path", async () => {
    await expect(harness.experimental_call("recStart", { id, mime: "audio/webm", model: "whisper-small" })).resolves.toMatchObject({ ok: false });
  });

  it("reports a recogniser failure as a failed `rec` signal", async () => {
    fakeAsr.mockRejectedValueOnce(new Error("router down"));
    await harness.experimental_call("recStart", { id, mime: "audio/webm", model: null });
    await harness.experimental_call("recAppend", { id, seq: 0, data: tone(1000) });
    await harness.experimental_call("recFinish", { id });
    await vi.waitFor(() => expect(harness.experimental_getSignals().filter((s) => s.signal === "rec")).toHaveLength(1));
    expect(harness.experimental_getSignals().filter((s) => s.signal === "rec")[0]!.payload).toEqual({ ok: false, id, at: expect.any(Number), code: "asr_failed", message: "router down" });
  });
});
