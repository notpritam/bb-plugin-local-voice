import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LOCAL_VOICE_SERVICE_ID, hostSignals, serverHostContract, type WhisperConfig } from "./contract.js";
import { deriveClip } from "./insights/clip.js";
import { FIRST_PROFILE_WORDS, SAMPLE_CLIPS, isProfileDue, sampleTexts, statsSummary, wordsUntilNext } from "./insights/profile-plan.js";
import { insightsRpcContract } from "./insights/rpc.js";
import { migrate } from "./insights/schema.js";
import { InsightsStore } from "./insights/store.js";
import { mostCorrectedWord, topWords } from "./insights/text.js";
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

  // ---- Voice profile: an LLM-written persona refreshed every REFRESH_WORDS words.
  let generating = false;
  async function generateProfile(force: boolean): Promise<{ ok: boolean; message?: string }> {
    if (generating) return { ok: false, message: "already generating" };
    const wordsTotal = store.totalWords();
    const existing = store.getProfile();
    if (!force && !isProfileDue(wordsTotal, existing?.wordsAt ?? null)) return { ok: false, message: "not due" };
    if (wordsTotal === 0) return { ok: false, message: "nothing dictated yet" };
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null) return { ok: false, message: "no primary host" };
    generating = true;
    try {
      const report = buildUsageReport(store.usageRows(), new Date());
      const texts = store.recentTexts(SAMPLE_CLIPS);
      const top = topWords(texts, 10);
      const persona = await host.call("profile", { sample: sampleTexts(texts), stats: statsSummary(report, top) }, { hostId: primaryHostId });
      if (!persona.ok) return { ok: false, message: "the model returned no profile" };
      store.setProfile({
        generatedAt: Date.now(),
        wordsAt: wordsTotal,
        title: persona.title,
        description: persona.description,
        catchphrase: persona.catchphrase,
        peakTitle: report.peak?.label ?? "No peak time yet",
        peakDescription: persona.peakDescription,
        mostUsedWord: top[0]?.word ?? null,
        mostCorrectedWord: mostCorrectedWord(store.recentPairs(300)),
      });
      bb.realtime.publish("voice-profile", { generatedAt: Date.now() });
      return { ok: true };
    } finally {
      generating = false;
    }
  }

  bb.rpc.register(insightsRpcContract, {
    insights_usage: () => buildUsageReport(store.usageRows(), new Date()),
    insights_clear: () => {
      store.clear();
      bb.realtime.publish("voice-clip", { words: 0, day: "" });
      bb.realtime.publish("voice-profile", { generatedAt: 0 });
      return { ok: true as const };
    },
    insights_voice: () => {
      const wordsTotal = store.totalWords();
      const profile = store.getProfile();
      return {
        profile: profile === null ? null : { ...profile },
        wordsTotal,
        wordsUntilNext: profile === null && wordsTotal < FIRST_PROFILE_WORDS ? wordsUntilNext(wordsTotal, null) : wordsUntilNext(wordsTotal, profile?.wordsAt ?? null),
        generating,
      };
    },
    insights_regenerate: async () => {
      const result = await generateProfile(true);
      return result.message === undefined ? { ok: result.ok } : { ok: result.ok, message: result.message };
    },
  });

  bb.background.schedule("profile", "*/10 * * * *", async () => {
    const result = await generateProfile(false);
    if (!result.ok && result.message !== "not due") bb.log.warn(`voice profile: ${result.message ?? "failed"}`);
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
