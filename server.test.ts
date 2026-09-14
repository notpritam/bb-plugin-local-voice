import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";

function makeHost(overrides: { primaryHostId?: string | null } = {}) {
  const callHostRpc = vi.fn(async () => ({ ok: true }));
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
