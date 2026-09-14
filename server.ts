import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { WHISPER_SERVICE_ID, serverHostContract, type WhisperConfig } from "./contract.js";
import { DEFAULT_CONFIG, configFromSettings } from "./whisper.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    modelsDir: {
      type: "string",
      label: "Models directory (holds ggml-<model>.bin files)",
      default: DEFAULT_CONFIG.modelsDir,
    },
    threads: {
      type: "string",
      label: "CPU threads for whisper-cli",
      default: String(DEFAULT_CONFIG.threads),
    },
    translate: {
      type: "boolean",
      label: "Translate speech to English (off = transcribe in the spoken language)",
      default: DEFAULT_CONFIG.translate,
    },
  });

  bb.experimental_aiServices.register({
    id: WHISPER_SERVICE_ID,
    displayName: "Whisper (local whisper.cpp on this host)",
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
      bb.log.warn("no primary host; whisper config not pushed");
      return;
    }
    const config = await currentConfig();
    await host.call(
      "configure",
      config,
      signal === undefined ? { hostId: primaryHostId } : { hostId: primaryHostId, signal },
    );
    bb.log.info(`whisper config pushed to ${primaryHostId}: ${JSON.stringify(config)}`);
  }

  bb.background.service("config-sync", {
    async start(signal) {
      if (signal.aborted) return;
      try {
        await pushConfig(signal);
      } catch (error) {
        bb.log.warn(`whisper config push failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  settings.onChange(() => {
    pushConfig().catch((error: unknown) => {
      bb.log.warn(`whisper config push failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  bb.log.info("loaded");
}
