import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LOCAL_VOICE_SERVICE_ID, hostSignals, serverHostContract, type WhisperConfig } from "./contract.js";
import { deriveClip } from "./insights/clip.js";
import { FIRST_PROFILE_WORDS, SAMPLE_CLIPS, isProfileDue, sampleTexts, statsSummary, wordsUntilNext } from "./insights/profile-plan.js";
import { insightsRpcContract, leaderboardRpcContract } from "./insights/rpc.js";
import { RateLimiter, hashToken, isoWeekRange, newMemberId, newToken, previousIsoWeekRange, rankMembers, sanitizeName, validateReportDays } from "./insights/leaderboard.js";
import { boardRemote, joinRemote, lbFetch, leaveRemote, reportRemote } from "./insights/lb-client.js";
import { migrate } from "./insights/schema.js";
import { InsightsStore } from "./insights/store.js";
import { mostCorrectedWord, topWords } from "./insights/text.js";
import { buildUsageReport } from "./insights/usage.js";
import { dayOf } from "./insights/clip.js";
import { DEFAULT_CONFIG, configFromSettings } from "./whisper.js";

export const DEFAULT_LEADERBOARD_URL = "https://voice.notpritam.in/api/v1/plugins/local-voice/http/leaderboard";
const LB_MEMBER_KEY = "leaderboard.member";
const LB_PAGE_SIZE = 20;

interface LeaderboardMember {
  memberId: string;
  token: string;
  url: string;
}

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
    leaderboard: {
      type: "boolean",
      label: "Join the public leaderboard (shares only daily word counts and your display name)",
      default: false,
    },
    displayName: {
      type: "string",
      label: "Leaderboard display name",
      default: "",
    },
    leaderboardUrl: {
      type: "string",
      label: "Leaderboard host",
      default: DEFAULT_LEADERBOARD_URL,
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

  // ---- Leaderboard: public host routes (auth "none" — Caddy publishes exactly this path).
  const joinLimiter = new RateLimiter({ capacity: 10, refillPerMs: 10 / 3_600_000 });
  const reportLimiter = new RateLimiter({ capacity: 60, refillPerMs: 1 / 1000 });
  const clientIp = (c: { req: { header(name: string): string | undefined } }) =>
    (c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
  const jsonError = (c: { json(body: unknown, status?: number): Response }, status: number, code: string, message: string) =>
    c.json({ code, message }, status as 400);
  const readJson = async (c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> => {
    try {
      const body = (await c.req.json()) as unknown;
      return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const authed = (body: Record<string, unknown>): string | null => {
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const token = typeof body.token === "string" ? body.token : "";
    return memberId !== "" && token !== "" && store.lbVerify(memberId, hashToken(token)) ? memberId : null;
  };

  bb.http.route("GET", "/leaderboard/health", async (c) => c.json({ ok: true, members: store.lbMemberCount() }), { auth: "none" });

  bb.http.route(
    "POST",
    "/leaderboard/join",
    async (c) => {
      if (!joinLimiter.take(clientIp(c))) return jsonError(c, 429, "rate_limited", "Too many joins from this address; try later.");
      const body = await readJson(c);
      const displayName = sanitizeName(body?.displayName);
      if (displayName === null) return jsonError(c, 400, "invalid_name", "displayName must be 2-32 characters.");
      const memberId = newMemberId();
      const token = newToken();
      store.lbJoin({ id: memberId, displayName, tokenHash: hashToken(token), now: Date.now(), ipHash: hashToken(clientIp(c)).slice(0, 16) });
      return c.json({ memberId, token });
    },
    { auth: "none" },
  );

  bb.http.route(
    "POST",
    "/leaderboard/report",
    async (c) => {
      if (!reportLimiter.take(clientIp(c))) return jsonError(c, 429, "rate_limited", "Too many reports; slow down.");
      const body = await readJson(c);
      if (body === null) return jsonError(c, 400, "invalid_body", "JSON body required.");
      const memberId = authed(body);
      if (memberId === null) return jsonError(c, 401, "unauthorized", "Unknown member or bad token.");
      const days = validateReportDays(body.days);
      if (!days.ok) return jsonError(c, 400, "invalid_days", days.message);
      const rename = sanitizeName(body.displayName);
      if (rename !== null) store.lbRename(memberId, rename);
      store.lbUpsertDays(memberId, days.days, Date.now());
      return c.json({ ok: true });
    },
    { auth: "none" },
  );

  bb.http.route(
    "POST",
    "/leaderboard/leave",
    async (c) => {
      const body = await readJson(c);
      const memberId = body === null ? null : authed(body);
      if (memberId === null) return jsonError(c, 401, "unauthorized", "Unknown member or bad token.");
      store.lbLeave(memberId);
      return c.json({ ok: true });
    },
    { auth: "none" },
  );

  bb.http.route(
    "GET",
    "/leaderboard/board",
    async (c) => {
      if (!reportLimiter.take(clientIp(c))) return jsonError(c, 429, "rate_limited", "Too many requests; slow down.");
      const period = c.req.query("period") === "all" ? "all" : "week";
      const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
      const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query("limit") ?? String(LB_PAGE_SIZE), 10) || LB_PAGE_SIZE));
      const me = c.req.query("me") ?? null;
      const today = dayOf(Date.now());
      const ranked =
        period === "all"
          ? rankMembers(store.lbTotals(null), null)
          : rankMembers(store.lbTotals(isoWeekRange(today)), store.lbTotals(previousIsoWeekRange(today)));
      return c.json({
        period,
        total: ranked.length,
        offset,
        members: ranked.slice(offset, offset + limit),
        me: me === null ? null : (ranked.find((m) => m.memberId === me) ?? null),
      });
    },
    { auth: "none" },
  );

  // ---- Leaderboard: client side (this install reporting its own totals).
  let lastReportAt: number | null = null;
  let lastError: string | null = null;
  async function leaderboardSettings() {
    const values = await settings.get();
    const url = (typeof values.leaderboardUrl === "string" && values.leaderboardUrl.trim() !== "" ? values.leaderboardUrl.trim() : DEFAULT_LEADERBOARD_URL).replace(/\/+$/u, "");
    return { enabled: values.leaderboard === true, displayName: typeof values.displayName === "string" ? values.displayName.trim() : "", url };
  }
  async function member(): Promise<LeaderboardMember | null> {
    return (await bb.storage.kv.get<LeaderboardMember>(LB_MEMBER_KEY)) ?? null;
  }
  async function reportNow(): Promise<void> {
    const lb = await leaderboardSettings();
    if (!lb.enabled) return;
    const m = await member();
    if (m === null) return;
    const since = dayOf(Date.now() - 7 * 86_400_000);
    const days = store.dailyTotalsSince(since);
    if (days.length === 0) return;
    try {
      await reportRemote(m.url, { memberId: m.memberId, token: m.token, displayName: lb.displayName || undefined }, days.slice(-8), lbFetch);
      lastReportAt = Date.now();
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      bb.log.warn(`leaderboard report failed: ${lastError}`);
    }
  }

  bb.background.schedule("leaderboard-report", "*/15 * * * *", reportNow);

  bb.rpc.register(leaderboardRpcContract, {
      leaderboard_status: async () => {
        const lb = await leaderboardSettings();
        const m = await member();
        return { enabled: lb.enabled, joined: m !== null, memberId: m?.memberId ?? null, displayName: lb.displayName, url: lb.url, lastReportAt, lastError };
      },
      leaderboard_join: async () => {
        const lb = await leaderboardSettings();
        const displayName = sanitizeName(lb.displayName);
        if (displayName === null) return { ok: false, message: "Set a display name (2-32 characters) in the plugin settings first." };
        if (!lb.enabled) return { ok: false, message: "Turn on the leaderboard in the plugin settings first." };
        try {
          const joined = await joinRemote(lb.url, displayName, lbFetch);
          await bb.storage.kv.set(LB_MEMBER_KEY, { memberId: joined.memberId, token: joined.token, url: lb.url } satisfies LeaderboardMember);
          await reportNow();
          return { ok: true, memberId: joined.memberId };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
      leaderboard_leave: async () => {
        const m = await member();
        if (m === null) return { ok: true };
        try {
          await leaveRemote(m.url, { memberId: m.memberId, token: m.token }, lbFetch);
        } catch (error) {
          bb.log.warn(`leaderboard leave failed remotely: ${error instanceof Error ? error.message : String(error)}`);
        }
        await bb.storage.kv.delete(LB_MEMBER_KEY);
        return { ok: true };
      },
      leaderboard_board: async ({ period, offset }) => {
        const lb = await leaderboardSettings();
        const m = await member();
        return boardRemote(m?.url ?? lb.url, { period, offset, limit: LB_PAGE_SIZE, me: m?.memberId ?? null }, lbFetch);
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
