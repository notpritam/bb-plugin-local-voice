import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { createMediaRecorder, isVoiceSupported, transcribeViaBb } from "./voice-capture";
import { VoicePage } from "./insights/ui/VoicePage";
import { mountVoiceDock } from "./voice-dock";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "voice", title: "Voice", icon: "Mic", path: "voice", component: VoicePage });
  app.contentScripts.register({
    id: "voice-dock",
    mount: ({ signal }) => {
      // No mic without HTTPS + MediaRecorder; bb's own composer hides its mic the same way.
      if (!isVoiceSupported()) return;
      return mountVoiceDock({ signal, createRecorder: createMediaRecorder, transcribe: transcribeViaBb });
    },
  });
});
