import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LOCAL_VOICE_SERVICE_ID, hostSignals, serverHostContract, type WhisperConfig } from "./contract.js";
import { deriveClip } from "./insights/clip.js";
import { FIRST_PROFILE_WORDS, SAMPLE_CLIPS, isProfileDue, sampleTexts, statsSummary, wordsUntilNext } from "./insights/profile-plan.js";
import { insightsRpcContract, leaderboardRpcContract } from "./insights/rpc.js";
import { RateLimiter, hashToken, isoWeekRange, newInviteCode, newMemberId, newToken, previousIsoWeekRange, rankMembers, sanitizeName, validateReportDays } from "./insights/leaderboard.js";
import { boardRemote, joinRemote, lbFetch, leaveRemote, reportRemote } from "./insights/lb-client.js";
import { registerRecordings } from "./insights/recordings.js";
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
    asrModel: {
      type: "string",
      label: "Recogniser model alias on the router (mic dock, composer, retries)",
      default: DEFAULT_CONFIG.asrModel,
    },
    audioRetentionDays: {
      type: "string",
      label: "Keep the audio of finished clips for this many days (0 = forever)",
      default: "30",
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
    leaderboardInvite: {
      type: "string",
      label: "Leaderboard invite code (ask the host for one)",
      default: "",
    },
    leaderboardHost: {
      type: "boolean",
      label: "This install hosts the public leaderboard (shows the admin panel)",
      default: false,
    },
    leaderboardMaxMembers: {
      type: "string",
      label: "Host: maximum number of members",
      default: "100",
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

  // ---- Recordings: the plugin's own path (mic dock, bb's composer via the bridge, retries).
  async function primaryHost(): Promise<string> {
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null) throw new Error("no primary host is connected");
    return primaryHostId;
  }
  const recordings = registerRecordings({
    bb,
    store,
    host: {
      call: async (method, input) => host.call(method, input as never, { hostId: await primaryHost() }) as Promise<{ ok: boolean; message?: string }>,
    },
    asrModel: async () => (await currentConfig()).asrModel,
    retentionDays: async () => {
      const raw = (await settings.get()).audioRetentionDays;
      const days = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(days) && days >= 0 ? days : 30;
    },
  });
  host.experimental_onSignal("rec", ({ payload }) => recordings.onRecSignal(payload));

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

  async function hostMaxMembers(): Promise<number> {
    const raw = (await settings.get()).leaderboardMaxMembers;
    const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  }

  bb.http.route("GET", "/leaderboard/health", async (c) => c.json({ ok: true, members: store.lbMemberCount(), inviteOnly: true }), { auth: "none" });

  bb.http.route(
    "POST",
    "/leaderboard/join",
    async (c) => {
      if (!joinLimiter.take(clientIp(c))) return jsonError(c, 429, "rate_limited", "Too many joins from this address; try later.");
      const body = await readJson(c);
      const ipHash = hashToken(clientIp(c)).slice(0, 16);
      const reject = (code: string, message: string, status: 400 | 403) => {
        store.lbLogEvent({ at: Date.now(), kind: "rejected", memberId: null, ipHash, detail: `join: ${code}` });
        return jsonError(c, status, code, message);
      };
      const displayName = sanitizeName(body?.displayName);
      if (displayName === null) return reject("invalid_name", "displayName must be 2-32 characters.", 400);
      const invite = typeof body?.invite === "string" ? body.invite.trim().toLowerCase() : "";
      if (invite === "") return reject("invite_required", "This leaderboard is invite-only. Ask the host for an invite code.", 403);
      const maxMembers = await hostMaxMembers();
      if (store.lbMemberCount() >= maxMembers) return reject("full", "The leaderboard is full right now.", 403);
      const claim = store.lbClaimInvite(invite, Date.now());
      if (!claim.ok) return reject(`invite_${claim.reason}`, `That invite code is ${claim.reason === "unknown" ? "not valid" : claim.reason}.`, 403);
      const memberId = newMemberId();
      const token = newToken();
      store.lbJoin({ id: memberId, displayName, tokenHash: hashToken(token), now: Date.now(), ipHash, inviteCode: invite });
      store.lbLogEvent({ at: Date.now(), kind: "join", memberId, ipHash, detail: `${displayName} via ${invite}` });
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
      store.lbLogEvent({ at: Date.now(), kind: "report", memberId, ipHash: hashToken(clientIp(c)).slice(0, 16), detail: `${days.days.length} day${days.days.length === 1 ? "" : "s"}` });
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
      store.lbLogEvent({ at: Date.now(), kind: "leave", memberId, ipHash: hashToken(clientIp(c)).slice(0, 16), detail: null });
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
    return {
      enabled: values.leaderboard === true,
      displayName: typeof values.displayName === "string" ? values.displayName.trim() : "",
      invite: typeof values.leaderboardInvite === "string" ? values.leaderboardInvite.trim().toLowerCase() : "",
      hosting: values.leaderboardHost === true,
      url,
    };
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
        if (lb.invite === "") return { ok: false, message: "Enter your invite code in the plugin settings first (the host hands them out)." };
        try {
          const joined = await joinRemote(lb.url, { displayName, invite: lb.invite }, lbFetch);
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
      leaderboard_admin_overview: async () => adminOverview(),
      leaderboard_admin_invite_create: async ({ label, maxUses }) => {
        const code = newInviteCode();
        store.lbCreateInvite({ code, label: label.trim(), maxUses, now: Date.now() });
        bb.log.info(`leaderboard invite created: ${code} (${label}, ${maxUses} uses)`);
        return { code };
      },
      leaderboard_admin_invite_revoke: async ({ code }) => ({ ok: store.lbRevokeInvite(code.trim().toLowerCase(), Date.now()) }),
      leaderboard_admin_member_remove: async ({ memberId }) => {
        store.lbLeave(memberId);
        store.lbLogEvent({ at: Date.now(), kind: "leave", memberId, ipHash: null, detail: "removed by host" });
        return { ok: true };
      },
  });

  async function adminOverview() {
    const lb = await leaderboardSettings();
    const week = Date.now() - 7 * 86_400_000;
    const counts = store.lbEventCounts(week);
    return {
      hosting: lb.hosting,
      maxMembers: await hostMaxMembers(),
      counts: { members: store.lbMemberCount(), ...counts },
      members: store.lbMembersOverview(),
      invites: store.lbListInvites(),
      events: store.lbRecentEvents(50),
    };
  }

  // ---- CLI: the same admin surface from a terminal (or an agent).
  const cliUsage = [
    "Usage:",
    "  bb local-voice status                       # engines, members, this week's activity",
    "  bb local-voice invites [--json]             # list invite codes",
    "  bb local-voice invite <label> [--uses N]     # create an invite (default 5 uses)",
    "  bb local-voice revoke <code>",
    "  bb local-voice members [--json]",
    "  bb local-voice remove <member-id>",
    "  bb local-voice events [--limit N] [--json]",
  ].join("\n");
  bb.cli.register({
    name: "local-voice",
    summary: "Local Voice: leaderboard invites, members and activity",
    commands: [
      { name: "status", summary: "Engines, members and this week's activity", usage: "bb local-voice status" },
      { name: "invites", summary: "List invite codes", usage: "bb local-voice invites [--json]" },
      { name: "invite", summary: "Create an invite code", usage: "bb local-voice invite <label> [--uses N]" },
      { name: "revoke", summary: "Revoke an invite code", usage: "bb local-voice revoke <code>" },
      { name: "members", summary: "List leaderboard members", usage: "bb local-voice members [--json]" },
      { name: "remove", summary: "Remove a member", usage: "bb local-voice remove <member-id>" },
      { name: "events", summary: "Recent leaderboard activity", usage: "bb local-voice events [--limit N] [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const flag = (name: string, fallback: number) => {
        const i = args.indexOf(name);
        const v = i >= 0 ? Number.parseInt(args[i + 1] ?? "", 10) : Number.NaN;
        return Number.isFinite(v) && v > 0 ? v : fallback;
      };
      const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]?.startsWith("--")));
      const [command, ...rest] = positional;
      const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: cliUsage };
        case "status": {
          const o = await adminOverview();
          const lb = await leaderboardSettings();
          const lines = [
            `hosting: ${o.hosting ? "yes" : "no"}   members: ${o.counts.members}/${o.maxMembers}   invites: ${o.invites.filter((i) => i.revokedAt === null && i.uses < i.maxUses).length} open`,
            `last 7 days: ${o.counts.join} joins, ${o.counts.report} reports, ${o.counts.leave} leaves, ${o.counts.rejected} rejected`,
            `client: ${lb.enabled ? "opted in" : "opted out"} as "${lb.displayName || "-"}" → ${lb.url}`,
            `clips recorded locally: ${store.count()} (${store.totalWords()} words)`,
          ];
          return { exitCode: 0, stdout: json ? JSON.stringify(o) : lines.join("\n") };
        }
        case "invites": {
          const invites = store.lbListInvites();
          if (json) return { exitCode: 0, stdout: JSON.stringify(invites) };
          return { exitCode: 0, stdout: invites.length === 0 ? "No invites yet. Create one: bb local-voice invite <label>" : invites.map((i) => `${i.code}  ${i.uses}/${i.maxUses} used  ${i.revokedAt === null ? "open" : "revoked"}  ${i.label}  (${when(i.createdAt)})`).join("\n") };
        }
        case "invite": {
          const label = rest.join(" ").trim();
          if (label === "") return { exitCode: 1, stderr: cliUsage };
          const maxUses = Math.min(1000, flag("--uses", 5));
          const code = newInviteCode();
          store.lbCreateInvite({ code, label, maxUses, now: Date.now() });
          return { exitCode: 0, stdout: json ? JSON.stringify({ code, label, maxUses }) : `${code}  (${label}, ${maxUses} uses)\nShare it; the member enters it as leaderboardInvite in their plugin settings.` };
        }
        case "revoke": {
          const code = rest[0]?.trim().toLowerCase() ?? "";
          if (code === "") return { exitCode: 1, stderr: cliUsage };
          return store.lbRevokeInvite(code, Date.now()) ? { exitCode: 0, stdout: `Revoked ${code}` } : { exitCode: 1, stderr: `No open invite ${code}` };
        }
        case "members": {
          const members = store.lbMembersOverview();
          if (json) return { exitCode: 0, stdout: JSON.stringify(members) };
          return { exitCode: 0, stdout: members.length === 0 ? "No members." : members.map((m) => `${m.memberId}  ${m.displayName}  ${m.words} words over ${m.days} days  last seen ${when(m.lastSeen)}  invite ${m.inviteCode ?? "-"}`).join("\n") };
        }
        case "remove": {
          const id = rest[0] ?? "";
          if (id === "") return { exitCode: 1, stderr: cliUsage };
          store.lbLeave(id);
          store.lbLogEvent({ at: Date.now(), kind: "leave", memberId: id, ipHash: null, detail: "removed by host (cli)" });
          return { exitCode: 0, stdout: `Removed ${id}` };
        }
        case "events": {
          const events = store.lbRecentEvents(Math.min(500, flag("--limit", 30)));
          if (json) return { exitCode: 0, stdout: JSON.stringify(events) };
          return { exitCode: 0, stdout: events.length === 0 ? "No activity yet." : events.map((e) => `${when(e.at)}  ${e.kind.padEnd(8)} ${e.memberId ?? "-"}  ${e.detail ?? ""}`).join("\n") };
        }
      }
      return { exitCode: 1, stderr: cliUsage };
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
