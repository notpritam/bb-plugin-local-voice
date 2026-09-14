import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";

function makeHost(overrides: { primaryHostId?: string | null } = {}) {
  const callHostRpc = vi.fn(async (_call: { method: string }) => ({ ok: true }) as unknown);
  const { bb, harness } = createFakePluginHost({
    pluginId: "local-voice",
    experimental_hostEntry: true,
    sdk: {
      system: {
        config: async () => ({
          primaryHostId: overrides.primaryHostId === undefined ? "host-1" : overrides.primaryHostId,
        }),
      },
    },
    experimental_callHostRpc: callHostRpc,
  });
  return { bb, harness, callHostRpc };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("server", () => {
  it("registers the whisper voice service", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    expect(harness.inspection.registrations.aiServiceRegistrations).toEqual([
      { id: "local", displayName: "Local Voice (Qwen3-ASR + Gemma on this host)", kinds: ["voice"] },
    ]);
  });

  it("pushes the default config to the primary host when the sync service starts", async () => {
    const { bb, harness, callHostRpc } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    const service = harness.behavior.runService("config-sync");
    await vi.waitFor(() => expect(callHostRpc).toHaveBeenCalledTimes(1));
    expect(harness.inspection.experimental_hostRpcCalls[0]).toMatchObject({
      method: "configure",
      hostId: "host-1",
      input: { modelsDir: "~/.bb/whisper-models", threads: 12, translate: true, polish: true, serverUrl: "http://127.0.0.1:8091", polishModel: "gemma-4-e4b" },
    });
    service.controller.abort();
    await service.done;
  });

  it("re-pushes when a setting changes, parsing threads and modelsDir", async () => {
    const { bb, harness, callHostRpc } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.setSettings({ threads: "6", modelsDir: " /opt/models ", translate: false, polish: false, serverUrl: "http://10.0.0.2:9000/", polishModel: " gemma-4-e2b " });
    await vi.waitFor(() => expect(callHostRpc).toHaveBeenCalled());
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "configure",
      input: { modelsDir: "/opt/models", threads: 6, translate: false, polish: false, serverUrl: "http://10.0.0.2:9000", polishModel: "gemma-4-e2b" },
    });
  });

  it("logs and skips the push when there is no primary host", async () => {
    const { bb, harness, callHostRpc } = makeHost({ primaryHostId: null });
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    const service = harness.behavior.runService("config-sync");
    await vi.waitFor(() =>
      expect(harness.inspection.logEntries.some((e) => e.message.includes("no primary host"))).toBe(true),
    );
    service.controller.abort();
    await service.done;
    expect(callHostRpc).not.toHaveBeenCalled();
  });
});

const clipPayload = {
  at: Date.now(), filename: "bb-dock.webm", mimeType: "audio/webm", language: "English", durationMs: 4000,
  rawText: "um commit and push this", text: "Commit and push this.", polished: true, translated: false, asrMs: 800, polishMs: 300,
  engine: "llama" as const, model: "qwen3-asr",
};

describe("insights", () => {
  it("records a clip from the host signal and publishes voice-clip", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", clipPayload);
    const report = await harness.behavior.callRpc("insights_usage", null);
    expect(report).toMatchObject({
      totals: { words: 4, clips: 1 },
      fixes: { edits: 1, fillers: 1 },
      surfaces: expect.arrayContaining([expect.objectContaining({ key: "field", clips: 1 })]),
    });
    expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({ channel: "voice-clip", payload: { words: 4 } });
  });

  it("ignores empty clips", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", { ...clipPayload, text: " " });
    expect(await harness.behavior.callRpc("insights_usage", null)).toMatchObject({ totals: { clips: 0 } });
  });

  it("classify schedule labels pending clips through the host", async () => {
    const { bb, harness, callHostRpc } = makeHost();
    callHostRpc.mockImplementation(async ({ method }) => (method === "classify" ? { labels: ["code"] } : { ok: true }));
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", clipPayload);
    await harness.behavior.runSchedule("classify");
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "classify", input: { texts: ["Commit and push this."] } });
    const report = await harness.behavior.callRpc("insights_usage", null);
    expect(report).toMatchObject({ categories: expect.arrayContaining([expect.objectContaining({ key: "code", clips: 1 })]) });
  });

  it("insights_clear wipes clips", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", clipPayload);
    expect(await harness.behavior.callRpc("insights_clear", null)).toEqual({ ok: true });
    expect(await harness.behavior.callRpc("insights_usage", null)).toMatchObject({ totals: { clips: 0 } });
  });
});

describe("voice profile", () => {
  const persona = { ok: true, title: "Context Clarifier", description: "You dictate plans.", catchphrase: "commit and push this", peakDescription: "Late nights." };
  async function seeded(words: number) {
    const { bb, harness, callHostRpc } = makeHost();
    callHostRpc.mockImplementation(async ({ method }) => (method === "profile" ? persona : method === "classify" ? { labels: [] } : { ok: true }));
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    const text = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", { ...clipPayload, rawText: `um ${text}`, text });
    return { harness, callHostRpc };
  }

  it("reports no profile and the words still needed", async () => {
    const { harness } = await seeded(50);
    expect(await harness.behavior.callRpc("insights_voice", null)).toMatchObject({ profile: null, wordsTotal: 50, wordsUntilNext: 150 });
  });

  it("generates the first profile once 200 words exist and computes local words", async () => {
    const { harness, callHostRpc } = await seeded(220);
    await harness.behavior.runSchedule("profile");
    expect(callHostRpc.mock.calls.some(([call]) => call.method === "profile")).toBe(true);
    const voice = await harness.behavior.callRpc("insights_voice", null);
    expect(voice).toMatchObject({ profile: { title: "Context Clarifier", catchphrase: "commit and push this", mostCorrectedWord: "um" }, wordsTotal: 220, wordsUntilNext: 2000 });
    expect(harness.inspection.realtimeSignals.some((s) => s.channel === "voice-profile")).toBe(true);
  });

  it("regenerate forces a new profile", async () => {
    const { harness, callHostRpc } = await seeded(10);
    expect(await harness.behavior.callRpc("insights_regenerate", null)).toMatchObject({ ok: true });
    expect(callHostRpc.mock.calls.filter(([call]) => call.method === "profile")).toHaveLength(1);
  });
});
