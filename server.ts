import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LOCAL_VOICE_SERVICE_ID, hostSignals, serverHostContract, type WhisperConfig } from "./contract.js";
import { deriveClip } from "./insights/clip.js";
import { insightsRpcContract } from "./insights/rpc.js";
import { migrate } from "./insights/schema.js";
import { InsightsStore } from "./insights/store.js";
import { buildUsageReport } from "./insights/usage.js";
import { DEFAULT_CONFIG, configFromSettings } from "./whisper.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "llama-server router URL (bb-local-voice.service)",
      default: DEFAULT_CONFIG.serverUrl,
    },
    polish: {
      type: "boolean",
      label: "Polish dictation (fillers out, punctuation, lists, identifiers)",
      default: DEFAULT_CONFIG.polish,
    },
    translate: {
      type: "boolean",
      label: "Output English (off = keep the spoken language)",
      default: DEFAULT_CONFIG.translate,
    },
    polishModel: {
      type: "string",
      label: "Polisher model alias on the router",
      default: DEFAULT_CONFIG.polishModel,
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

  const host = bb.hosts.experimental_client({ contract: serverHostContract, experimental_signals: hostSignals });

  // ---- Insights: every finished dictation lands here as a host signal.
  const db = bb.storage.database();
  migrate(db);
  const store = new InsightsStore(db);

  host.experimental_onSignal("clip", ({ payload }) => {
    const clip = deriveClip(payload);
    if (clip === null) return;
    store.insertClip(clip);
    bb.realtime.publish("voice-clip", { words: clip.words, day: clip.day });
  });

  bb.rpc.register(insightsRpcContract, {
    insights_usage: () => buildUsageReport(store.usageRows(), new Date()),
    insights_clear: () => {
      store.clear();
      bb.realtime.publish("voice-clip", { words: 0, day: "" });
      return { ok: true as const };
    },
  });

  // Content categories are filled in lazily so the transcription path stays fast.
  bb.background.schedule("classify", "* * * * *", async () => {
    const pending = store.uncategorized(20);
    if (pending.length === 0) return;
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null) return;
    const { labels } = await host.call("classify", { texts: pending.map((p) => p.text) }, { hostId: primaryHostId });
    pending.forEach((p, i) => {
      const label = labels[i];
      if (label) store.setCategory(p.id, label);
    });
  });

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
