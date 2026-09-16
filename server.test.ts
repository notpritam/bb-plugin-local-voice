import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
const lbFetchMock = vi.fn<typeof fetch>();
vi.mock("./insights/lb-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./insights/lb-client")>();
  return { ...original, lbFetch: (...args: Parameters<typeof fetch>) => lbFetchMock(...args) };
});
import plugin from "./server";

function makeHost(overrides: { primaryHostId?: string | null } = {}) {
  const callHostRpc = vi.fn(async (_call: { method: string }) => ({ ok: true }) as unknown);
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
      input: { modelsDir: "~/.bb/whisper-models", threads: 12, translate: true, polish: true, serverUrl: "http://127.0.0.1:8091", polishModel: "gemma-4-e4b", asrModel: "qwen3-asr" },
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

const clipPayload = {
  at: Date.now(), filename: "bb-dock.webm", mimeType: "audio/webm", language: "English", durationMs: 4000,
  rawText: "um commit and push this", text: "Commit and push this.", polished: true, translated: false, asrMs: 800, polishMs: 300,
  engine: "llama" as const, model: "qwen3-asr",
};

describe("insights", () => {
  it("records a clip from the host signal and publishes voice-clip", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", clipPayload);
    const report = await harness.behavior.callRpc("insights_usage", null);
    expect(report).toMatchObject({
      totals: { words: 4, clips: 1 },
      fixes: { edits: 1, fillers: 1 },
      surfaces: expect.arrayContaining([expect.objectContaining({ key: "field", clips: 1 })]),
    });
    expect(harness.inspection.realtimeSignals.at(-1)).toMatchObject({ channel: "voice-clip", payload: { words: 4 } });
  });

  it("ignores empty clips", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", { ...clipPayload, text: " " });
    expect(await harness.behavior.callRpc("insights_usage", null)).toMatchObject({ totals: { clips: 0 } });
  });

  it("classify schedule labels pending clips through the host", async () => {
    const { bb, harness, callHostRpc } = makeHost();
    callHostRpc.mockImplementation(async ({ method }) => (method === "classify" ? { labels: ["code"] } : { ok: true }));
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", clipPayload);
    await harness.behavior.runSchedule("classify");
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "classify", input: { texts: ["Commit and push this."] } });
    const report = await harness.behavior.callRpc("insights_usage", null);
    expect(report).toMatchObject({ categories: expect.arrayContaining([expect.objectContaining({ key: "code", clips: 1 })]) });
  });

  it("insights_clear wipes clips", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", clipPayload);
    expect(await harness.behavior.callRpc("insights_clear", null)).toEqual({ ok: true });
    expect(await harness.behavior.callRpc("insights_usage", null)).toMatchObject({ totals: { clips: 0 } });
  });
});

describe("voice profile", () => {
  const persona = { ok: true, title: "Context Clarifier", description: "You dictate plans.", catchphrase: "commit and push this", peakDescription: "Late nights." };
  async function seeded(words: number) {
    const { bb, harness, callHostRpc } = makeHost();
    callHostRpc.mockImplementation(async ({ method }) => (method === "profile" ? persona : method === "classify" ? { labels: [] } : { ok: true }));
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    const text = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", { ...clipPayload, rawText: `um ${text}`, text });
    return { harness, callHostRpc };
  }

  it("reports no profile and the words still needed", async () => {
    const { harness } = await seeded(50);
    expect(await harness.behavior.callRpc("insights_voice", null)).toMatchObject({ profile: null, wordsTotal: 50, wordsUntilNext: 150 });
  });

  it("generates the first profile once 200 words exist and computes local words", async () => {
    const { harness, callHostRpc } = await seeded(220);
    await harness.behavior.runSchedule("profile");
    expect(callHostRpc.mock.calls.some(([call]) => call.method === "profile")).toBe(true);
    const voice = await harness.behavior.callRpc("insights_voice", null);
    expect(voice).toMatchObject({ profile: { title: "Context Clarifier", catchphrase: "commit and push this", mostCorrectedWord: "um" }, wordsTotal: 220, wordsUntilNext: 2000 });
    expect(harness.inspection.realtimeSignals.some((s) => s.channel === "voice-profile")).toBe(true);
  });

  it("regenerate forces a new profile", async () => {
    const { harness, callHostRpc } = await seeded(10);
    expect(await harness.behavior.callRpc("insights_regenerate", null)).toMatchObject({ ok: true });
    expect(callHostRpc.mock.calls.filter(([call]) => call.method === "profile")).toHaveLength(1);
  });
});

describe("leaderboard public routes", () => {
  async function up() {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.setSettings({ leaderboardHost: true });
    const { code: invite } = (await harness.behavior.callRpc("leaderboard_admin_invite_create", { label: "test", maxUses: 20 })) as { code: string };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      harness.behavior.fetchHttp("POST", path, { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
    return { harness, post, invite };
  }

  it("join → report → board → leave", async () => {
    const { harness, post, invite } = await up();
    const joined = (await (await post("/leaderboard/join", { displayName: "  Ann  ", invite })).json()) as { memberId: string; token: string };
    expect(joined.memberId).toMatch(/^[a-z0-9]{12}$/u);
    const bob = (await (await post("/leaderboard/join", { displayName: "Bob", invite })).json()) as { memberId: string; token: string };

    const today = new Date().toISOString().slice(0, 10);
    expect((await post("/leaderboard/report", { ...joined, days: [{ day: today, words: 400, clips: 4 }] })).status).toBe(200);
    expect((await post("/leaderboard/report", { ...bob, days: [{ day: today, words: 900, clips: 9 }] })).status).toBe(200);

    const board = (await (await harness.behavior.fetchHttp("GET", `/leaderboard/board?period=week&me=${joined.memberId}`)).json()) as { total: number; members: { displayName: string; rank: number; words: number }[]; me: { rank: number } };
    expect(board.total).toBe(2);
    expect(board.members.map((m) => [m.rank, m.displayName, m.words])).toEqual([[1, "Bob", 900], [2, "Ann", 400]]);
    expect(board.me).toMatchObject({ rank: 2 });

    const health = (await (await harness.behavior.fetchHttp("GET", "/leaderboard/health")).json()) as { ok: boolean; members: number; inviteOnly: boolean };
    expect(health).toEqual({ ok: true, members: 2, inviteOnly: true });

    expect((await post("/leaderboard/leave", { memberId: joined.memberId, token: joined.token })).status).toBe(200);
    const after = (await (await harness.behavior.fetchHttp("GET", "/leaderboard/board?period=all")).json()) as { total: number };
    expect(after.total).toBe(1);
  });

  it("rejects bad names, bad tokens, bad days", async () => {
    const { post, invite } = await up();
    expect((await post("/leaderboard/join", { displayName: "x", invite })).status).toBe(400);
    const joined = (await (await post("/leaderboard/join", { displayName: "Ann", invite })).json()) as { memberId: string; token: string };
    expect((await post("/leaderboard/report", { memberId: joined.memberId, token: "wrong", days: [{ day: "2026-09-15", words: 1, clips: 1 }] })).status).toBe(401);
    expect((await post("/leaderboard/report", { ...joined, days: [{ day: "2026-09-15", words: 999_999, clips: 1 }] })).status).toBe(400);
    expect((await post("/leaderboard/report", { ...joined, days: "nope" })).status).toBe(400);
  });

  it("requires a valid, unrevoked, unexhausted invite and honours the member cap", async () => {
    const { harness, post, invite } = await up();
    expect((await post("/leaderboard/join", { displayName: "NoInvite" })).status).toBe(403);
    expect((await post("/leaderboard/join", { displayName: "Wrong", invite: "nope1234" })).status).toBe(403);
    const { code: single } = (await harness.behavior.callRpc("leaderboard_admin_invite_create", { label: "one", maxUses: 1 })) as { code: string };
    expect((await post("/leaderboard/join", { displayName: "First", invite: single })).status).toBe(200);
    expect((await post("/leaderboard/join", { displayName: "Second", invite: single })).status).toBe(403);
    await harness.behavior.callRpc("leaderboard_admin_invite_revoke", { code: invite });
    expect((await post("/leaderboard/join", { displayName: "Late", invite })).status).toBe(403);
    await harness.behavior.setSettings({ leaderboardMaxMembers: "1" });
    const { code: fresh } = (await harness.behavior.callRpc("leaderboard_admin_invite_create", { label: "fresh", maxUses: 5 })) as { code: string };
    expect((await post("/leaderboard/join", { displayName: "Overflow", invite: fresh })).status).toBe(403);
    const overview = (await harness.behavior.callRpc("leaderboard_admin_overview", null)) as { hosting: boolean; members: { displayName: string }[]; invites: unknown[]; events: { kind: string }[]; counts: { rejected: number } };
    expect(overview.hosting).toBe(true);
    expect(overview.members.map((m) => m.displayName)).toEqual(["First"]);
    expect(overview.invites).toHaveLength(3);
    expect(overview.counts.rejected).toBeGreaterThanOrEqual(4);
  });

  it("admin can remove a member; CLI mirrors the admin surface", async () => {
    const { harness, post, invite } = await up();
    const joined = (await (await post("/leaderboard/join", { displayName: "Ann", invite })).json()) as { memberId: string };
    expect(await harness.behavior.callRpc("leaderboard_admin_member_remove", { memberId: joined.memberId })).toEqual({ ok: true });
    expect(((await harness.behavior.callRpc("leaderboard_admin_overview", null)) as { members: unknown[] }).members).toHaveLength(0);
    const list = await harness.behavior.runCli(["invites"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(invite);
    const created = await harness.behavior.runCli(["invite", "Beta testers", "--uses", "3"]);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toMatch(/[a-z0-9]{8}/u);
    const members = await harness.behavior.runCli(["members", "--json"]);
    expect(JSON.parse(members.stdout)).toEqual([]);
  });

  it("rate limits joins per ip", async () => {
    const { post, invite } = await up();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await post("/leaderboard/join", { displayName: `User ${i}`, invite }, { "x-forwarded-for": "203.0.113.9" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("leaderboard client", () => {
  const today = new Date().toISOString().slice(0, 10);
  function fakeRemote() {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (u.endsWith("/join")) return new Response(JSON.stringify({ memberId: "abcdefghijkl", token: "t0k" }));
      if (u.endsWith("/report")) return new Response(JSON.stringify({ ok: true }));
      if (u.endsWith("/leave")) return new Response(JSON.stringify({ ok: true }));
      if (u.includes("/board")) return new Response(JSON.stringify({ period: "week", total: 1, offset: 0, members: [{ rank: 1, memberId: "abcdefghijkl", displayName: "Pritam", words: 4, delta: null }], me: null }));
      return new Response("nope", { status: 404 });
    });
    lbFetchMock.mockImplementation(fetchImpl as unknown as typeof fetch);
    return calls;
  }

  it("joins with the display name, reports daily totals on the schedule, reads the board", async () => {
    const calls = fakeRemote();
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.setSettings({ leaderboard: true, displayName: "Pritam", leaderboardInvite: "inv1te00", leaderboardUrl: "https://voice.example.test/api/v1/plugins/local-voice/http/leaderboard" });
    await harness.behavior.experimental_emitHostSignal("host-1", "clip", clipPayload);

    expect(await harness.behavior.callRpc("leaderboard_join", null)).toMatchObject({ ok: true, memberId: "abcdefghijkl" });
    expect(calls[0]).toMatchObject({ url: "https://voice.example.test/api/v1/plugins/local-voice/http/leaderboard/join", body: { displayName: "Pritam", invite: "inv1te00" } });

    await harness.behavior.runSchedule("leaderboard-report");
    const report = calls.find((c) => c.url.endsWith("/report"));
    expect(report?.body).toMatchObject({ memberId: "abcdefghijkl", token: "t0k", days: [{ day: today, words: 4, clips: 1 }] });

    const status = await harness.behavior.callRpc("leaderboard_status", null);
    expect(status).toMatchObject({ enabled: true, joined: true, memberId: "abcdefghijkl", displayName: "Pritam" });

    const board = await harness.behavior.callRpc("leaderboard_board", { period: "week", offset: 0 });
    expect(board).toMatchObject({ total: 1, members: [{ rank: 1, displayName: "Pritam" }] });

    expect(await harness.behavior.callRpc("leaderboard_leave", null)).toEqual({ ok: true });
    expect(await harness.behavior.callRpc("leaderboard_status", null)).toMatchObject({ joined: false });
  });

  it("does nothing on the schedule when opted out", async () => {
    const calls = fakeRemote();
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.runSchedule("leaderboard-report");
    expect(calls).toHaveLength(0);
  });
});

describe("recordings", () => {
  const uid = "clip-abcdefgh";
  const recOk = (o: Partial<Record<string, unknown>> = {}) => ({
    ok: true as const, id: uid, at: 1_700_000_000_000, mime: "audio/webm", model: "qwen3-asr", language: "Hindi", durationMs: 4000,
    rawText: "यार deploy fail", text: "The deploy failed.", polished: true, translated: true, asrMs: 900, polishMs: 400, chunks: 1, ...o,
  });

  it("streams slices into SQLite, finishes through the host and answers the long-poll from the `rec` signal", async () => {
    const { bb, harness, callHostRpc } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    expect(await harness.behavior.callRpc("rec_start", { uid, surface: "field", mime: "audio/webm" })).toEqual({ ok: true, id: 1 });
    expect(await harness.behavior.callRpc("rec_append", { uid, seq: 0, data: Buffer.from("abc").toString("base64") })).toEqual({ ok: true });
    expect(await harness.behavior.callRpc("rec_append", { uid, seq: 1, data: Buffer.from("def").toString("base64") })).toEqual({ ok: true });
    expect(await harness.behavior.callRpc("rec_finish", { uid })).toEqual({ ok: true });
    expect(harness.inspection.experimental_hostRpcCalls.map((c) => c.method)).toEqual(["recStart", "recAppend", "recAppend", "recFinish"]);
    expect(callHostRpc).toHaveBeenCalledTimes(4);

    // The audio is already kept, even before any outcome.
    const audio = await harness.behavior.fetchHttp("GET", "/clip-audio?id=1");
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/webm");
    expect(Buffer.from(await audio.arrayBuffer()).toString()).toBe("abcdef");

    const pending = harness.behavior.callRpc("rec_result", { uid });
    await harness.behavior.experimental_emitHostSignal("host-1", "rec", recOk());
    expect(await pending).toEqual({ status: "done", id: 1, text: "The deploy failed." });
    const history = (await harness.behavior.callRpc("history_list", { before: null, limit: 10, query: null })) as { clips: { status: string; words: number; attempts: number; audioBytes: number; translated: boolean }[] };
    expect(history.clips[0]).toMatchObject({ status: "done", words: 3, attempts: 1, audioBytes: 6, translated: true });
    expect(await harness.behavior.callRpc("insights_usage", null)).toMatchObject({ totals: { words: 3, clips: 1 } });
    expect(harness.inspection.realtimeSignals.some((s) => s.channel === "voice-history")).toBe(true);
  });

  it("keeps the audio and marks the clip failed when the host is unreachable, then retries from the kept audio", async () => {
    const { bb, harness, callHostRpc } = makeHost();
    callHostRpc.mockImplementation(async ({ method }) => {
      if (method === "recStart") throw new Error("daemon offline");
      return { ok: true };
    });
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.callRpc("rec_start", { uid, surface: "composer", mime: "audio/webm" });
    await harness.behavior.callRpc("rec_append", { uid, seq: 0, data: Buffer.from("xyz").toString("base64") });
    await harness.behavior.callRpc("rec_finish", { uid });
    expect(await harness.behavior.callRpc("rec_result", { uid })).toEqual({ status: "failed", id: 1, message: "Host unreachable: daemon offline" });
    // No slices were forwarded after the failed start.
    expect(harness.inspection.experimental_hostRpcCalls.map((c) => c.method)).toEqual(["recStart"]);

    expect(await harness.behavior.callRpc("clip_retry", { id: 1 })).toEqual({ ok: true });
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "recTranscribe", input: { id: uid, mime: "audio/webm", data: Buffer.from("xyz").toString("base64") } });
    await harness.behavior.experimental_emitHostSignal("host-1", "rec", recOk({ text: "Second time lucky." }));
    const history = (await harness.behavior.callRpc("history_list", { before: null, limit: 10, query: null })) as { clips: { status: string; text: string; attempts: number }[] };
    expect(history.clips[0]).toMatchObject({ status: "done", text: "Second time lucky.", attempts: 2 });
  });

  it("records a failed outcome from the host and lets the clip be deleted", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.callRpc("rec_transcribe", { uid, surface: "field", mime: "audio/ogg", data: Buffer.from("whole").toString("base64") });
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "recTranscribe", input: { id: uid, mime: "audio/ogg" } });
    await harness.behavior.experimental_emitHostSignal("host-1", "rec", { ok: false, id: uid, at: 1, code: "asr_failed", message: "ECONNREFUSED" });
    expect(await harness.behavior.callRpc("rec_result", { uid })).toEqual({ status: "failed", id: 1, message: "ECONNREFUSED" });
    expect(await harness.behavior.callRpc("clip_delete", { id: 1 })).toEqual({ ok: true });
    expect((await harness.behavior.fetchHttp("GET", "/clip-audio?id=1")).status).toBe(404);
    expect(await harness.behavior.callRpc("history_list", { before: null, limit: 10, query: null })).toEqual({ clips: [], hasMore: false });
  });

  it("cancel discards the row and its audio", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.callRpc("rec_start", { uid, surface: "field", mime: "audio/webm" });
    await harness.behavior.callRpc("rec_append", { uid, seq: 0, data: Buffer.from("abc").toString("base64") });
    expect(await harness.behavior.callRpc("rec_cancel", { uid })).toEqual({ ok: true });
    expect(await harness.behavior.callRpc("history_list", { before: null, limit: 10, query: null })).toEqual({ clips: [], hasMore: false });
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "recCancel" });
  });

  it("the stuck sweep fails recordings nobody finished and the retention schedule drops old audio", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    cleanup = () => harness.lifecycle.dispose();
    await harness.behavior.callRpc("rec_start", { uid, surface: "field", mime: "audio/webm" });
    await harness.behavior.callRpc("rec_append", { uid, seq: 0, data: Buffer.from("abc").toString("base64") });
    await harness.behavior.runSchedule("stuck-recordings");
    // Too fresh to be stuck.
    expect(await harness.behavior.callRpc("history_list", { before: null, limit: 10, query: null })).toMatchObject({ clips: [{ status: "recording" }] });
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ["Date"] });
    try {
      await harness.behavior.runSchedule("stuck-recordings");
      expect(await harness.behavior.callRpc("history_list", { before: null, limit: 10, query: null })).toMatchObject({ clips: [{ status: "failed", audioBytes: 3 }] });
      vi.setSystemTime(Date.now() + 40 * 86_400_000);
      // Only finished clips lose their audio; a failed one keeps it for the retry.
      await harness.behavior.runSchedule("audio-retention");
      expect(await harness.behavior.callRpc("history_list", { before: null, limit: 10, query: null })).toMatchObject({ clips: [{ status: "failed", audioBytes: 3 }] });
      await harness.behavior.experimental_emitHostSignal("host-1", "rec", recOk());
      await harness.behavior.runSchedule("audio-retention");
      expect(await harness.behavior.callRpc("history_list", { before: null, limit: 10, query: null })).toMatchObject({ clips: [{ status: "done", audioBytes: 0 }] });
    } finally {
      vi.useRealTimers();
    }
  });
});
