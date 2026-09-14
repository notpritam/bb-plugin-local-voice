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

const { default: hostEntry } = await import("./host");
const { hostSignals } = await import("./contract");

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
    const config = { modelsDir: "/models", threads: 6, translate: false, polish: true, serverUrl: "http://127.0.0.1:8091", polishModel: "gemma-4-e4b" };
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
    expect(deps.config).toEqual({ modelsDir: "~/.bb/whisper-models", threads: 12, translate: true, polish: true, serverUrl: "http://127.0.0.1:8091", polishModel: "gemma-4-e4b" });
    expect(deps.tempRoot).toBe(path.join(root, "tmp"));
    expect(deps.homeDir).toBe(os.homedir());
  });

  it("uses the persisted config on later calls", async () => {
    await harness.experimental_call("configure", { modelsDir: "/m", threads: 2, translate: false, polish: false, serverUrl: "http://x:1", polishModel: "t" });
    transcribeAudio.mockResolvedValue({ ok: true, model: "qwen3-asr", text: "" });
    await harness.experimental_call("ai.voice.transcribe", voiceInput);
    expect(transcribeAudio.mock.calls[0]![1].config).toEqual({ modelsDir: "/m", threads: 2, translate: false, polish: false, serverUrl: "http://x:1", polishModel: "t" });
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
