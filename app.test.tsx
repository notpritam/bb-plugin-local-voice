// @vitest-environment jsdom
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { DOCK_ATTR } from "./voice-dock";

function enableVoiceGlobals() {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window, "MediaRecorder", { value: class {}, configurable: true });
  Object.defineProperty(window.navigator, "mediaDevices", { value: { getUserMedia: async () => ({}) }, configurable: true });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("app", () => {
  it("registers the voice-dock content script and mounts one dock", async () => {
    enableVoiceGlobals();
    const app = await loadPluginApp(() => import("./app"));
    expect(app.contentScripts.map((s) => s.id)).toEqual(["voice-dock"]);
    const scripts = await mountPluginContentScripts(app, { pluginId: "whisper", generation: 1 });
    expect(document.querySelectorAll(`[${DOCK_ATTR}]`)).toHaveLength(1);
    await scripts.lifecycle.dispose();
    expect(document.querySelector(`[${DOCK_ATTR}]`)).toBeNull();
  });
});
