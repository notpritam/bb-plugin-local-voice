// @vitest-environment jsdom
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_ATTR } from "./voice-dock";

function enableVoiceGlobals() {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window, "MediaRecorder", { value: class {}, configurable: true, writable: true });
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

const report = {
  totals: { words: 12345, clips: 40, durationMs: 3_600_000, books: 0.1 },
  month: { words: 5000, previousWords: 4000, deltaPct: 25 },
  wpm: { value: 152, topPercent: 10 },
  fixes: { edits: 321, fillers: 88, translated: 7 },
  surfaces: [
    { key: "composer", label: "Agent prompts (composer)", clips: 30, share: 75 },
    { key: "field", label: "Other fields", clips: 10, share: 25 },
    { key: "cli", label: "CLI", clips: 0, share: 0 },
    { key: "other", label: "Other", clips: 0, share: 0 },
  ],
  categories: [
    { key: "prompt", label: "AI prompts", clips: 30, share: 75 },
    { key: "note", label: "Notes & plans", clips: 10, share: 25 },
    { key: "message", label: "Messages", clips: 0, share: 0 },
    { key: "code", label: "Code instructions", clips: 0, share: 0 },
    { key: "other", label: "Other", clips: 0, share: 0 },
  ],
  languages: [{ language: "English", clips: 33, share: 82 }, { language: "Hindi", clips: 7, share: 18 }],
  streak: { current: 3, longest: 9 },
  heatmap: { start: "2026-04-05", weeks: 24, days: Array.from({ length: 168 }, (_, i) => ({ day: `d${i}`, words: i % 5, level: i % 5 })) },
  peak: { weekday: 4, hour: 0, label: "Thursday at 12 a.m." },
  generatedAt: 0,
};

describe("Voice page", () => {
  it("registers the nav panel and renders the usage report", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((p) => ({ id: p.id, path: p.path }))).toEqual([{ id: "voice", path: "voice" }]);
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { insights_usage: () => report, insights_clear: () => ({ ok: true }), history_list: () => ({ clips: [], hasMore: false }) } });
    (await slot.findByText("Your usage")).click();
    await slot.findByText("12,345");
    await slot.findByText("152");
    expect(slot.getByText(/Top 10%/)).toBeTruthy();
    expect(slot.getByText(/321/)).toBeTruthy();
    expect(slot.getByText(/3 day streak/)).toBeTruthy();
    expect(slot.getByText(/Thursday at 12 a.m./)).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("Your voice tab", () => {
  it("renders the persona and the words-until-next bar", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const voice = {
      profile: { generatedAt: 1, title: "Context Clarifier", description: "You dictate plans.", catchphrase: "commit and push this", peakTitle: "Thursday at 12 a.m.", peakDescription: "Late nights.", mostUsedWord: "deploy", mostCorrectedWord: "like" },
      wordsTotal: 3200, wordsUntilNext: 800, generating: false,
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { insights_usage: () => report, insights_clear: () => ({ ok: true }), insights_voice: () => voice, insights_regenerate: () => ({ ok: true }), history_list: () => ({ clips: [], hasMore: false }) } });
    (await slot.findByText("Your voice")).click();
    await slot.findByText("Context Clarifier");
    expect(slot.getByText(/commit and push this/)).toBeTruthy();
    expect(slot.getByText(/deploy/)).toBeTruthy();
    expect(slot.getByText(/800 more words/)).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("Leaderboard tab", () => {
  it("renders the podium, table, and join state", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const members = [
      { rank: 1, memberId: "m1", displayName: "Ishan Kumar", words: 9000, delta: 0 },
      { rank: 2, memberId: "m2", displayName: "Ankur Sinha", words: 8000, delta: 3 },
      { rank: 3, memberId: "m3", displayName: "Debayan P", words: 700, delta: null },
      { rank: 4, memberId: "me", displayName: "Pritam Sharma", words: 703, delta: 9 },
    ];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        insights_usage: () => report, insights_clear: () => ({ ok: true }), history_list: () => ({ clips: [], hasMore: false }),
        leaderboard_status: () => ({ enabled: true, joined: true, memberId: "me", displayName: "Pritam Sharma", url: "https://x", lastReportAt: null, lastError: null }),
        leaderboard_board: () => ({ period: "week", total: 4, offset: 0, members, me: members[3] }),
        leaderboard_join: () => ({ ok: true }), leaderboard_leave: () => ({ ok: true }),
        leaderboard_admin_overview: () => ({ hosting: true, maxMembers: 100, counts: { members: 4, join: 2, report: 9, leave: 0, rejected: 1 }, members: [{ memberId: "m1", displayName: "Ishan Kumar", createdAt: 1, lastSeen: 2, inviteCode: "abcd2345", days: 3, words: 9000 }], invites: [{ code: "abcd2345", label: "friends", maxUses: 5, uses: 1, createdAt: 1, revokedAt: null }], events: [{ at: 2, kind: "join", memberId: "m1", ipHash: null, detail: "Ishan Kumar via abcd2345" }] }),
        leaderboard_admin_invite_create: () => ({ code: "zzzz2345" }), leaderboard_admin_invite_revoke: () => ({ ok: true }), leaderboard_admin_member_remove: () => ({ ok: true }),
      },
    });
    (await slot.findByText("Leaderboard")).click();
    expect(await slot.findAllByText("Ishan Kumar")).toHaveLength(3); // podium + table + admin members
    await slot.findByText(/You host this board/);
    expect(slot.getAllByText("abcd2345").length).toBeGreaterThanOrEqual(1);
    expect(slot.getByText(/Pritam Sharma \(you\)/)).toBeTruthy();
    expect(slot.getByText("↑9")).toBeTruthy();
    expect(slot.getByText(/1-4 of 4/)).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("History tab", () => {
  const today = new Date();
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  const base = { uid: "clip-x", surface: "field", language: "Hindi", durationMs: 4000, rawText: "raw", words: 3, fixes: 0, translated: true, polished: true, asrMs: 1, polishMs: 1, model: "qwen3-asr", mime: "audio/webm", attempts: 1, audioBytes: 100 } as const;
  const clips = [
    { ...base, id: 3, at: today.getTime(), day: day(today), text: "", status: "transcribing", error: null },
    { ...base, id: 2, at: today.getTime() - 60_000, day: day(today), text: "", status: "failed", error: "Speech recognition failed: router down", attempts: 2 },
    { ...base, id: 1, at: yesterday.getTime(), day: day(yesterday), text: "The deploy failed yesterday.", status: "done", error: null },
  ];

  it("groups clips by day and offers retry on failures", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const retry = vi.fn(() => ({ ok: true }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { insights_usage: () => report, insights_clear: () => ({ ok: true }), history_list: () => ({ clips, hasMore: true }), clip_retry: retry, clip_delete: () => ({ ok: true }) },
    });
    await slot.findByText("Today");
    expect(slot.getByText("Yesterday")).toBeTruthy();
    expect(slot.getByText("The deploy failed yesterday.")).toBeTruthy();
    expect(slot.getByText(/Transcribing…/)).toBeTruthy();
    expect(slot.getByText(/router down/)).toBeTruthy();
    expect(slot.getByText(/attempt 2/)).toBeTruthy();
    expect(slot.getByText("Load more")).toBeTruthy();
    slot.getByText("Retry").click();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledWith({ id: 2 }));
    slot.lifecycle.unmount();
  });

  it("shows the empty state", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { insights_usage: () => report, insights_clear: () => ({ ok: true }), history_list: () => ({ clips: [], hasMore: false }) } });
    await slot.findByText("Nothing recorded yet");
    slot.lifecycle.unmount();
  });
});
