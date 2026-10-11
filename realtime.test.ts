import { describe, expect, it, vi } from "vitest";
import { RealtimeSession, realtimeUrl, type PcmDecoder, type RealtimeSocket, type Session } from "./realtime";
import type { SessionResult } from "./stream";

/** An ElevenLabs socket stand-in: records what is sent, lets the test answer. */
class FakeSocket implements RealtimeSocket {
  sent: { message_type: string; audio_base_64: string; commit: boolean; sample_rate: number }[] = [];
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as FakeSocket["sent"][number]);
  }
  close(): void {
    this.closed = true;
  }
  emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  get audio(): Buffer {
    return Buffer.concat(this.sent.map((m) => Buffer.from(m.audio_base_64, "base64")));
  }
  get commits(): number {
    return this.sent.filter((m) => m.commit).length;
  }
}

/** A decoder that hands every written byte straight back as PCM (or nothing, for an unsupported container). */
function fakeDecoder(o: { silent?: boolean } = {}) {
  const decoder = { killed: false, ended: false };
  const start = (onPcm: (pcm: Buffer) => void): PcmDecoder => ({
    write: (bytes) => {
      if (!o.silent) onPcm(bytes);
    },
    end: async () => {
      decoder.ended = true;
    },
    kill: () => {
      decoder.killed = true;
    },
  });
  return { decoder, start };
}

function fakeBatch(result: SessionResult) {
  const appended: Buffer[] = [];
  const session: Session = { append: (slice) => appended.push(slice), finish: async () => result, cancel: () => undefined, lastActivityAt: 0 };
  return { appended, fallback: vi.fn(() => session) };
}

const batchResult: SessionResult = { ok: true, text: "From the batch path.", rawText: "From the batch path", language: "English", durationMs: 1000, asrMs: 900, polishMs: null, polished: false, translated: false, chunks: 1 };

function setup(o: { polish?: (text: string, translate: boolean) => Promise<string | null>; translate?: boolean; silent?: boolean; finalWaitMs?: number } = {}) {
  const socket = new FakeSocket();
  const { decoder, start } = fakeDecoder({ silent: o.silent });
  const batch = fakeBatch(batchResult);
  const openSocket = vi.fn((_url: string, _key: string) => socket);
  const session = new RealtimeSession({
    apiKey: "key",
    openSocket,
    startDecoder: start,
    fallback: batch.fallback,
    polish: o.polish ?? null,
    translate: o.translate ?? false,
    finalWaitMs: o.finalWaitMs ?? 1000,
  });
  return { socket, decoder, batch, openSocket, session };
}

const pcm = (bytes: number, fill = 1) => Buffer.alloc(bytes, fill);

describe("realtimeUrl", () => {
  it("asks for Scribe v2 Realtime on 16 kHz PCM, English with Hindi second, VAD commits, no fillers, with the keyterms", () => {
    const url = new URL(realtimeUrl(["MCAVA", "Bug Dossier"]));
    expect(url.origin + url.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(url.searchParams.get("language_code")).toBe("en");
    expect(url.searchParams.getAll("secondary_languages")).toEqual(["hi"]);
    expect(url.searchParams.get("commit_strategy")).toBe("vad");
    expect(url.searchParams.get("no_verbatim")).toBe("true");
    expect(url.searchParams.getAll("keyterms")).toEqual(["MCAVA", "Bug Dossier"]);
  });
});

describe("RealtimeSession", () => {
  it("holds audio until the session opens, streams it while recording, and answers from the final commit", async () => {
    const polish = vi.fn(async (text: string) => `${text} (cleaned)`);
    const { socket, session, openSocket, batch } = setup({ polish });
    expect(openSocket).toHaveBeenCalledWith(expect.stringContaining("scribe_v2_realtime"), "key");

    session.append(pcm(6000));
    expect(socket.sent).toHaveLength(0);
    socket.emit({ message_type: "session_started", session_id: "s1", config: {} });
    expect(socket.audio.length).toBe(6000);
    session.append(pcm(20_000));
    // Long slices go out in pieces of at most 250 ms.
    expect(socket.sent.every((m) => Buffer.from(m.audio_base_64, "base64").length <= 8000)).toBe(true);
    expect(socket.audio.length).toBe(26_000);
    expect(socket.commits).toBe(0);

    // A pause: ElevenLabs commits the first thought on its own.
    socket.emit({ message_type: "partial_transcript", text: "First thought" });
    socket.emit({ message_type: "committed_transcript", text: "First thought." });

    const finishing = session.finish();
    await vi.waitFor(() => expect(socket.commits).toBe(1));
    expect(socket.sent.at(-1)).toMatchObject({ commit: true, sample_rate: 16000 });
    socket.emit({ message_type: "committed_transcript", text: "And the rest." });
    const result = await finishing;

    expect(result).toEqual({
      ok: true,
      rawText: "First thought. And the rest.",
      text: "First thought. And the rest. (cleaned)",
      language: "English",
      durationMs: Math.round(26_000 / 32),
      asrMs: expect.any(Number),
      polishMs: expect.any(Number),
      polished: true,
      translated: false,
      chunks: 2,
      model: "scribe_v2_realtime",
    });
    expect(polish).toHaveBeenCalledWith("First thought. And the rest.", false, expect.any(AbortSignal));
    expect(socket.closed).toBe(true);
    expect(batch.fallback).not.toHaveBeenCalled();
  });

  it("never splits a 16-bit sample across messages", async () => {
    const { socket, session } = setup();
    socket.emit({ message_type: "session_started" });
    session.append(pcm(3, 7));
    session.append(pcm(5, 7));
    expect(socket.sent.every((m) => Buffer.from(m.audio_base_64, "base64").length % 2 === 0)).toBe(true);
    expect(socket.audio.length).toBe(8);
  });

  it("calls Devanagari Hindi and marks it translated when the English setting is on", async () => {
    const { socket, session } = setup({ polish: async () => "Make the copy shorter.", translate: true });
    socket.emit({ message_type: "session_started" });
    session.append(pcm(3200));
    const finishing = session.finish();
    await vi.waitFor(() => expect(socket.commits).toBe(1));
    socket.emit({ message_type: "committed_transcript", text: "copy थोड़ा छोटा कर दो" });
    expect(await finishing).toMatchObject({ ok: true, language: "Hindi", translated: true, text: "Make the copy shorter." });
  });

  it("silence answers with empty text and skips the formatter", async () => {
    const polish = vi.fn(async () => "never");
    const { socket, session } = setup({ polish });
    socket.emit({ message_type: "session_started" });
    session.append(pcm(3200, 0));
    const finishing = session.finish();
    await vi.waitFor(() => expect(socket.commits).toBe(1));
    socket.emit({ message_type: "committed_transcript", text: "" });
    expect(await finishing).toMatchObject({ ok: true, text: "", rawText: "", language: null, polished: false });
    expect(polish).not.toHaveBeenCalled();
  });

  it("keeps Scribe's text when the formatter fails", async () => {
    const { socket, session } = setup({ polish: async () => Promise.reject(new Error("rate limited")) });
    socket.emit({ message_type: "session_started" });
    session.append(pcm(3200));
    const finishing = session.finish();
    await vi.waitFor(() => expect(socket.commits).toBe(1));
    socket.emit({ message_type: "committed_transcript", text: "Ship it today." });
    expect(await finishing).toMatchObject({ ok: true, text: "Ship it today.", polished: false, polishMs: null });
  });

  it("hands every byte to the batch path when the connection fails", async () => {
    const { socket, session, batch } = setup();
    socket.emit({ message_type: "session_started" });
    session.append(pcm(100, 1));
    socket.onerror?.({});
    session.append(pcm(100, 2));
    expect(await session.finish()).toEqual(batchResult);
    expect(Buffer.concat(batch.appended)).toEqual(Buffer.concat([pcm(100, 1), pcm(100, 2)]));
    expect(socket.closed).toBe(true);
  });

  it("falls back when ElevenLabs reports an error", async () => {
    const { socket, session, batch } = setup();
    socket.emit({ message_type: "session_started" });
    session.append(pcm(100));
    socket.emit({ message_type: "quota_exceeded", error: "Quota exceeded" });
    expect(await session.finish()).toEqual(batchResult);
    expect(batch.fallback).toHaveBeenCalledTimes(1);
  });

  it("falls back when the session never opens or the final transcript never comes", async () => {
    const neverOpens = setup({ finalWaitMs: 30 });
    neverOpens.session.append(pcm(100));
    expect(await neverOpens.session.finish()).toEqual(batchResult);

    const noAnswer = setup({ finalWaitMs: 30 });
    noAnswer.socket.emit({ message_type: "session_started" });
    noAnswer.session.append(pcm(100));
    expect(await noAnswer.session.finish()).toEqual(batchResult);
    expect(noAnswer.socket.commits).toBe(1);
  });

  it("falls back when the container could not be decoded as it streamed", async () => {
    const { socket, session, batch } = setup({ silent: true });
    socket.emit({ message_type: "session_started" });
    session.append(Buffer.from("unsupported container"));
    const finishing = session.finish();
    await vi.waitFor(() => expect(socket.commits).toBe(1));
    socket.emit({ message_type: "committed_transcript", text: "" });
    expect(await finishing).toEqual(batchResult);
    expect(Buffer.concat(batch.appended).toString()).toBe("unsupported container");
  });

  it("cancel closes the socket and stops the decoder; a later finish reports the cancel", async () => {
    const { socket, session, decoder, batch } = setup();
    socket.emit({ message_type: "session_started" });
    session.append(pcm(100));
    session.cancel();
    expect(socket.closed).toBe(true);
    expect(decoder.killed).toBe(true);
    expect(await session.finish()).toMatchObject({ ok: false, code: "cancelled" });
    expect(batch.fallback).not.toHaveBeenCalled();
  });

  it("tracks activity for the idle sweep", () => {
    vi.useFakeTimers({ now: 1000, toFake: ["Date"] });
    try {
      const { session } = setup();
      expect(session.lastActivityAt).toBe(1000);
      vi.setSystemTime(5000);
      session.append(pcm(10));
      expect(session.lastActivityAt).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});
