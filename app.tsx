import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { installComposerBridge } from "./composer-bridge";
import { createRpcTransport } from "./rec-client";
import { createStreamingRecorder, isVoiceSupported } from "./voice-capture";
import { VoicePage } from "./insights/ui/VoicePage";
import { mountVoiceDock } from "./voice-dock";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "voice", title: "Voice", icon: "Mic", path: "voice", component: VoicePage });
  app.contentScripts.register({
    id: "voice-dock",
    mount: ({ signal, pluginId }) => {
      // No mic without HTTPS + MediaRecorder; bb's own composer hides its mic the same way.
      if (!isVoiceSupported()) return;
      // The bridge wraps fetch; build our transport on the native one so our own calls never loop through it.
      const rpc = createRpcTransport(pluginId, window.fetch.bind(window));
      const uninstall = installComposerBridge({ win: window, rpc });
      const unmount = mountVoiceDock({ signal, createRecorder: () => createStreamingRecorder({ rpc, surface: "field" }) });
      return () => {
        unmount();
        uninstall();
      };
    },
  });
});
