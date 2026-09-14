import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LOCAL_VOICE_SERVICE_ID, serverHostContract, type WhisperConfig } from "./contract.js";
import { DEFAULT_CONFIG, configFromSettings } from "./whisper.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "llama-server router URL (bb-local-voice.service)",
      default: DEFAULT_CONFIG.serverUrl,
    },
    translate: {
      type: "boolean",
      label: "Translate non-English speech to English (off = transcribe in the spoken language)",
      default: DEFAULT_CONFIG.translate,
    },
    translateModel: {
      type: "string",
      label: "Translation model alias on the router",
      default: DEFAULT_CONFIG.translateModel,
    },
    modelsDir: {
      type: "string",
      label: "whisper.cpp fallback: directory holding ggml-<model>.bin files",
      default: DEFAULT_CONFIG.modelsDir,
    },
    threads: {
      type: "string",
      label: "whisper.cpp fallback: CPU threads for whisper-cli",
      default: String(DEFAULT_CONFIG.threads),
    },
  });

  bb.experimental_aiServices.register({
    id: LOCAL_VOICE_SERVICE_ID,
    displayName: "Local Voice (Qwen3-ASR + Gemma on this host)",
    kinds: ["voice"],
  });

  const host = bb.hosts.experimental_client({ contract: serverHostContract });

  async function currentConfig(): Promise<WhisperConfig> {
    return configFromSettings(await settings.get());
  }

  // The AI-service call goes straight from core to the host worker, which
  // cannot read plugin settings itself, so the server pushes them over and
  // the host persists them beside its data.
  async function pushConfig(signal?: AbortSignal): Promise<void> {
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null) {
      bb.log.warn("no primary host; local-voice config not pushed");
      return;
    }
    const config = await currentConfig();
    await host.call(
      "configure",
      config,
      signal === undefined ? { hostId: primaryHostId } : { hostId: primaryHostId, signal },
    );
    bb.log.info(`local-voice config pushed to ${primaryHostId}: ${JSON.stringify(config)}`);
  }

  bb.background.service("config-sync", {
    async start(signal) {
      if (signal.aborted) return;
      try {
        await pushConfig(signal);
      } catch (error) {
        bb.log.warn(`local-voice config push failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  settings.onChange(() => {
    pushConfig().catch((error: unknown) => {
      bb.log.warn(`local-voice config push failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  bb.log.info("loaded");
}
