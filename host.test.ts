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

const { default: hostEntry } = await import("./host");

let root: string;
let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof hostEntry.contract, {}>>;
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
  serviceId: "whisper",
  model: "small",
  audioBase64: "AAAA",
  mimeType: "audio/webm",
  filename: "recording.webm",
  prompt: null,
  timeoutMs: 10_000,
};

describe("configure", () => {
  it("persists the config to <dataDir>/config.json", async () => {
    const config = { modelsDir: "/models", threads: 6, translate: false };
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
    transcribeAudio.mockResolvedValue({ ok: true, model: "small", text: "hello" });
    const result = await harness.experimental_call("ai.voice.transcribe", voiceInput);
    expect(result).toEqual({ ok: true, model: "small", text: "hello" });
    const [request, deps] = transcribeAudio.mock.calls[0]!;
    expect(request).toEqual({ model: "small", audioBase64: "AAAA", mimeType: "audio/webm", prompt: null, timeoutMs: 10_000 });
    expect(deps.config).toEqual({ modelsDir: "~/.bb/whisper-models", threads: 12, translate: true });
    expect(deps.tempRoot).toBe(path.join(root, "tmp"));
    expect(deps.homeDir).toBe(os.homedir());
  });

  it("uses the persisted config on later calls", async () => {
    await harness.experimental_call("configure", { modelsDir: "/m", threads: 2, translate: false });
    transcribeAudio.mockResolvedValue({ ok: true, model: "small", text: "" });
    await harness.experimental_call("ai.voice.transcribe", voiceInput);
    expect(transcribeAudio.mock.calls[0]![1].config).toEqual({ modelsDir: "/m", threads: 2, translate: false });
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
      serviceId: "whisper",
      model: "small",
      reasoningEffort: "none",
      prompt: "hi",
      outputSchema: { type: "object" },
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ ok: false, code: "request_failed" });
  });
});
