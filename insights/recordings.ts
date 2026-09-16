// The server half of a recording: rows and audio go into SQLite as slices
// arrive, the host does the recognising, and the outcome comes back as the
// `rec` signal. Nothing here waits on a model, so no bb timeout applies.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RecSignal } from "../contract.js";
import { dayOf, type Surface } from "./clip.js";
import type { InsightsStore } from "./store.js";
import { countWords, fillerCount, wordEdits } from "./text.js";
import { recordingRpcContract, type RecResultDto } from "./rpc.js";

/** Longest a `rec_result` call waits before answering `pending`. */
export const RESULT_WAIT_MS = 25_000;
/** A row still in progress after this long is a recording that never came back. */
export const STUCK_AFTER_MS = 10 * 60_000;
/** bb caps a host call at 8 MiB; base64 of this many audio bytes stays under it. */
export const MAX_RETRY_AUDIO_BYTES = 5_500_000;
const HISTORY_PAGE = 50;

export interface RecordingHostClient {
  call(method: "recStart", input: { id: string; mime: string; model: string | null }): Promise<{ ok: boolean; message?: string }>;
  call(method: "recAppend", input: { id: string; seq: number; data: string }): Promise<{ ok: boolean; message?: string }>;
  call(method: "recFinish", input: { id: string }): Promise<{ ok: boolean; message?: string }>;
  call(method: "recCancel", input: { id: string }): Promise<{ ok: boolean; message?: string }>;
  call(method: "recTranscribe", input: { id: string; mime: string; model: string | null; data: string }): Promise<{ ok: boolean; message?: string }>;
}

export interface RecordingDeps {
  bb: Pick<BbPluginApi, "rpc" | "http" | "realtime" | "log" | "background">;
  store: InsightsStore;
  host: RecordingHostClient;
  asrModel: () => Promise<string>;
  retentionDays: () => Promise<number>;
  now?: () => number;
}

type Outcome = Exclude<RecResultDto, { status: "pending" }>;

export function registerRecordings(deps: RecordingDeps): { onRecSignal: (payload: RecSignal) => void; sweepStuck: () => void; purgeAudio: () => Promise<void> } {
  const { bb, store, host } = deps;
  const now = deps.now ?? (() => Date.now());
  const waiters = new Map<string, Set<(o: Outcome) => void>>();
  /** Sessions whose host calls failed: audio keeps landing in SQLite, the finish fails with the reason. */
  const hostBroken = new Map<string, string>();

  function settle(uid: string, outcome: Outcome): void {
    const set = waiters.get(uid);
    waiters.delete(uid);
    for (const resolve of set ?? []) resolve(outcome);
  }
  function publish(id: number, status: string, words: number, day: string): void {
    bb.realtime.publish("voice-clip", { words, day });
    bb.realtime.publish("voice-history", { id, status });
  }
  function fail(uid: string, id: number, day: string, message: string): void {
    store.failClip(id, message);
    hostBroken.delete(uid);
    publish(id, "failed", 0, day);
    settle(uid, { status: "failed", id, message });
  }
  function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  async function hostCall<T extends { ok: boolean; message?: string }>(uid: string, call: () => Promise<T>): Promise<boolean> {
    try {
      const result = await call();
      if (!result.ok) hostBroken.set(uid, result.message ?? "The host declined the recording.");
      return result.ok;
    } catch (error) {
      hostBroken.set(uid, `Host unreachable: ${describe(error)}`);
      return false;
    }
  }

  function onRecSignal(payload: RecSignal): void {
    const clip = store.clipByUid(payload.id);
    if (clip === null) {
      bb.log.warn(`rec signal for unknown recording ${payload.id}`);
      return;
    }
    if (!payload.ok) {
      fail(payload.id, clip.id, clip.day, payload.message);
      return;
    }
    const text = payload.text.trim();
    store.completeClip(clip.id, {
      language: payload.language,
      durationMs: payload.durationMs,
      rawText: payload.rawText,
      text,
      rawWords: countWords(payload.rawText),
      words: countWords(text),
      fixes: payload.translated ? 0 : wordEdits(payload.rawText, text),
      fillers: fillerCount(payload.rawText),
      translated: payload.translated,
      polished: payload.polished,
      asrMs: payload.asrMs,
      polishMs: payload.polishMs,
      engine: "llama",
      model: payload.model,
    });
    hostBroken.delete(payload.id);
    publish(clip.id, "done", countWords(text), clip.day);
    settle(payload.id, { status: "done", id: clip.id, text });
  }

  bb.rpc.register(recordingRpcContract, {
    rec_start: async ({ uid, surface, mime }) => {
      if (store.clipByUid(uid) !== null) return { ok: false as const, message: "That recording id is already in use." };
      const at = now();
      const id = store.startRecording({ uid, at, day: dayOf(at), surface: surface as Surface, mime, model: await deps.asrModel() });
      publish(id, "recording", 0, dayOf(at));
      await hostCall(uid, () => host.call("recStart", { id: uid, mime, model: null }));
      return { ok: true as const, id };
    },
    rec_append: async ({ uid, seq, data }) => {
      const clip = store.clipByUid(uid);
      if (clip === null || clip.status !== "recording") return { ok: false as const, message: "No recording in progress with that id." };
      store.appendAudio(clip.id, Buffer.from(data, "base64"), now());
      if (!hostBroken.has(uid)) await hostCall(uid, () => host.call("recAppend", { id: uid, seq, data }));
      return { ok: true as const };
    },
    rec_finish: async ({ uid }) => {
      const clip = store.clipByUid(uid);
      if (clip === null) return { ok: false as const, message: "No recording with that id." };
      if (clip.status !== "recording") return { ok: true as const };
      store.setStatus(clip.id, "transcribing");
      publish(clip.id, "transcribing", 0, clip.day);
      const broken = hostBroken.get(uid);
      if (broken !== undefined) {
        fail(uid, clip.id, clip.day, broken);
        return { ok: true as const };
      }
      if (!(await hostCall(uid, () => host.call("recFinish", { id: uid })))) fail(uid, clip.id, clip.day, hostBroken.get(uid) ?? "The host could not finish the recording.");
      return { ok: true as const };
    },
    rec_cancel: async ({ uid }) => {
      const clip = store.clipByUid(uid);
      if (clip !== null) {
        store.deleteClip(clip.id);
        publish(clip.id, "deleted", 0, clip.day);
      }
      hostBroken.delete(uid);
      settle(uid, { status: "failed", id: clip?.id ?? 0, message: "cancelled" });
      await host.call("recCancel", { id: uid }).catch(() => undefined);
      return { ok: true as const };
    },
    rec_result: async ({ uid }): Promise<RecResultDto> => {
      const clip = store.clipByUid(uid);
      if (clip === null) return { status: "failed", id: 0, message: "No recording with that id." };
      if (clip.status === "done") return { status: "done", id: clip.id, text: clip.text };
      if (clip.status === "failed") return { status: "failed", id: clip.id, message: clip.error ?? "Transcription failed." };
      return new Promise<RecResultDto>((resolve) => {
        const set = waiters.get(uid) ?? new Set();
        waiters.set(uid, set);
        const timer = setTimeout(() => {
          set.delete(done);
          resolve({ status: "pending" });
        }, RESULT_WAIT_MS);
        const done = (outcome: Outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        };
        set.add(done);
      });
    },
    rec_transcribe: async ({ uid, surface, mime, data }) => {
      if (store.clipByUid(uid) !== null) return { ok: false as const, message: "That recording id is already in use." };
      const at = now();
      const id = store.startRecording({ uid, at, day: dayOf(at), surface: surface as Surface, mime, model: await deps.asrModel() });
      store.appendAudio(id, Buffer.from(data, "base64"), at);
      store.setStatus(id, "transcribing");
      publish(id, "transcribing", 0, dayOf(at));
      if (!(await hostCall(uid, () => host.call("recTranscribe", { id: uid, mime, model: null, data })))) fail(uid, id, dayOf(at), hostBroken.get(uid) ?? "The host could not start the transcription.");
      return { ok: true as const, id };
    },
    clip_retry: async ({ id }) => {
      const clip = store.clip(id);
      if (clip === null) return { ok: false as const, message: "No such clip." };
      if (clip.status === "recording" || clip.status === "transcribing") return { ok: false as const, message: "That clip is still being transcribed." };
      const audio = store.audioFor(id);
      if (audio === null) return { ok: false as const, message: "No audio was kept for this clip." };
      if (audio.bytes > MAX_RETRY_AUDIO_BYTES) return { ok: false as const, message: "This clip is too large to send for a retry." };
      const uid = clip.uid ?? `retry-${id}-${at36(now())}`;
      if (clip.uid === null) store.setUid(id, uid);
      store.setStatus(id, "transcribing");
      publish(id, "transcribing", 0, clip.day);
      if (!(await hostCall(uid, () => host.call("recTranscribe", { id: uid, mime: audio.mime, model: null, data: audio.data.toString("base64") })))) {
        fail(uid, id, clip.day, hostBroken.get(uid) ?? "The host could not start the transcription.");
      }
      return { ok: true as const };
    },
    clip_delete: async ({ id }) => {
      const clip = store.clip(id);
      if (clip !== null) {
        store.deleteClip(id);
        publish(id, "deleted", 0, clip.day);
      }
      return { ok: true as const };
    },
    history_list: async ({ before, limit, query }) => {
      const rows = store.history({ before, limit: Math.min(limit, HISTORY_PAGE * 4) + 1, query });
      const hasMore = rows.length > limit;
      return { clips: (hasMore ? rows.slice(0, limit) : rows).map((c) => ({ ...c })), hasMore };
    },
  });

  // Playback for the History tab: GET /api/v1/plugins/local-voice/http/clip-audio?id=<clip id>
  bb.http.route("GET", "/clip-audio", async (c) => {
    const id = Number.parseInt(c.req.query("id") ?? "", 10);
    const audio = Number.isFinite(id) ? store.audioFor(id) : null;
    if (audio === null) return c.json({ ok: false, error: "no audio for that clip" }, 404);
    return new Response(new Uint8Array(audio.data), { status: 200, headers: { "content-type": audio.mime, "content-length": String(audio.bytes), "cache-control": "private, max-age=3600" } });
  });

  function sweepStuck(): void {
    for (const id of store.staleRecordings(now() - STUCK_AFTER_MS)) {
      const clip = store.clip(id);
      if (clip === null) continue;
      fail(clip.uid ?? "", id, clip.day, "The transcription never came back (restart or crash). Retry keeps the audio.");
    }
  }
  async function purgeAudio(): Promise<void> {
    const days = await deps.retentionDays();
    if (days <= 0) return;
    const dropped = store.purgeAudioBefore(now() - days * 86_400_000);
    if (dropped > 0) bb.log.info(`dropped audio of ${dropped} clips older than ${days} days`);
  }
  bb.background.schedule("stuck-recordings", "* * * * *", async () => sweepStuck());
  bb.background.schedule("audio-retention", "17 3 * * *", purgeAudio);

  return { onRecSignal, sweepStuck, purgeAudio };
}

function at36(ms: number): string {
  return ms.toString(36);
}
