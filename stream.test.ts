import { describe, expect, it, vi } from "vitest";
import { PCM_BYTES_PER_MS, RecordingSession, joinChunkTexts, majorityLanguage, pauseSpanMs, pcmRmsDb, pcmToWav, quietestWindow } from "./stream";

/** Deterministic "speech": a loud tone with silent gaps at the given ms offsets. */
function speech(totalMs: number, gaps: { at: number; ms: number }[]): Buffer {
  const pcm = Buffer.alloc(totalMs * PCM_BYTES_PER_MS);
  for (let ms = 0; ms < totalMs; ms += 1) {
    const silent = gaps.some((g) => ms >= g.at && ms < g.at + g.ms);
    for (let s = 0; s < 16; s += 1) {
      const i = ms * 16 + s;
      const value = silent ? 0 : Math.round(Math.sin(i / 3) * 8000);
      pcm.writeInt16LE(value, i * 2);
    }
  }
  return pcm;
}

function wavMs(wav: Buffer): number {
  return (wav.length - 44) / PCM_BYTES_PER_MS;
}

describe("pcm helpers", () => {
  it("measures level and finds the quietest window", () => {
    const pcm = speech(2000, [{ at: 1200, ms: 200 }]);
    expect(pcmRmsDb(pcm, 0, 1000 * PCM_BYTES_PER_MS)).toBeGreaterThan(-20);
    expect(pcmRmsDb(pcm, 1200 * PCM_BYTES_PER_MS, 1400 * PCM_BYTES_PER_MS)).toBe(Number.NEGATIVE_INFINITY);
    const cut = quietestWindow(pcm, 500, 1800);
    expect(cut.at).toBeGreaterThanOrEqual(1200);
    expect(cut.at).toBeLessThanOrEqual(1400);
    expect(cut.level).toBe(Number.NEGATIVE_INFINITY);
  });

  it("measures how long a pause is", () => {
    const pcm = speech(4000, [{ at: 1000, ms: 600 }, { at: 3000, ms: 150 }]);
    const level = pcmRmsDb(pcm);
    expect(pauseSpanMs(pcm, 1300, level)).toBeGreaterThanOrEqual(550);
    expect(pauseSpanMs(pcm, 1300, level)).toBeLessThanOrEqual(700);
    expect(pauseSpanMs(pcm, 3075, level)).toBeLessThanOrEqual(200);
    expect(pauseSpanMs(pcm, 500, level)).toBe(0);
  });

  it("wraps pcm in a 44-byte RIFF header", () => {
    const wav = pcmToWav(Buffer.alloc(320));
    expect(wav.length).toBe(364);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(320);
  });

  it("joins chunk texts and votes on the language", () => {
    const chunks = [
      { language: "Hindi", text: "एक" },
      { language: "English", text: "" },
      { language: "english", text: "two" },
      { language: "hindi", text: "तीन" },
    ];
    expect(joinChunkTexts(chunks)).toBe("एक two तीन");
    expect(majorityLanguage(chunks)).toBe("Hindi");
    expect(majorityLanguage([{ language: null, text: "x" }])).toBeNull();
  });
});

describe("RecordingSession", () => {
  function makeSession(overrides: Partial<ConstructorParameters<typeof RecordingSession>[0]> = {}) {
    let clock = 0;
    const asrCalls: { fromMs: number; ms: number }[] = [];
    const asr = vi.fn(async (wav: Buffer) => {
      const ms = wavMs(wav);
      asrCalls.push({ fromMs: -1, ms });
      return { language: ms > 6000 ? "Hindi" : "English", text: `chunk${asrCalls.length}(${ms})` };
    });
    const polish = vi.fn(async (text: string, translate: boolean) => `${translate ? "EN:" : "SAME:"}${text}`);
    const session = new RecordingSession({
      decode: async (bytes) => bytes, // slices are already PCM in these tests
      asr,
      polish,
      translate: true,
      now: () => clock,
      ...overrides,
    });
    return { session, asr, polish, asrCalls, tick: (ms: number) => (clock += ms) };
  }

  it("cuts at silences while recording and only the tail remains at finish", async () => {
    // 30 s of speech with pauses at 7 s, 16 s and 25 s.
    const pcm = speech(30_000, [{ at: 7000, ms: 300 }, { at: 16_000, ms: 300 }, { at: 25_000, ms: 300 }]);
    const { session, asr, asrCalls, tick } = makeSession();
    // Feed 1 s slices like MediaRecorder's timeslice.
    for (let ms = 0; ms < 30_000; ms += 1000) {
      tick(1000);
      session.append(pcm.subarray(ms * PCM_BYTES_PER_MS, (ms + 1000) * PCM_BYTES_PER_MS));
      await new Promise((r) => setTimeout(r, 0));
    }
    // Three chunks were dispatched before the user stopped.
    expect(session.chunksDispatched).toBe(3);
    const result = await session.finish();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asr).toHaveBeenCalledTimes(4);
    // Every cut landed inside a pause: chunk lengths ≈ 7.1 s, 9 s, 9 s, 4.9 s.
    expect(asrCalls.map((c) => Math.round(c.ms / 100) / 10)).toEqual([7.1, 9, 9, 4.9]);
    expect(result.rawText).toBe("chunk1(7075) chunk2(9000) chunk3(9000) chunk4(4925)");
    expect(result.text).toBe("EN:chunk1(7075) chunk2(9000) chunk3(9000) chunk4(4925)");
    expect(result.language).toBe("Hindi");
    expect(result.translated).toBe(true);
    expect(result.polished).toBe(true);
    expect(result.durationMs).toBe(30_000);
    expect(result.chunks).toBe(4);
  });

  it("handles a whole clip fed at once (retry / CLI path) with the same cuts", async () => {
    const pcm = speech(20_000, [{ at: 9000, ms: 300 }]);
    const { session, asrCalls } = makeSession();
    session.append(pcm);
    const result = await session.finish();
    expect(result.ok).toBe(true);
    expect(asrCalls.map((c) => Math.round(c.ms / 100) / 10)).toEqual([9.1, 10.9]);
  });

  it("forces a cut at maxMs when the speaker never pauses", async () => {
    const { session, asrCalls } = makeSession();
    session.append(speech(30_000, []));
    const result = await session.finish();
    expect(result.ok).toBe(true);
    // 12 s, 12 s, 6 s tail
    expect(asrCalls.map((c) => Math.round(c.ms / 1000))).toEqual([12, 12, 6]);
  });

  it("skips silent chunks without calling the recogniser", async () => {
    const { session, asr } = makeSession();
    session.append(Buffer.alloc(3000 * PCM_BYTES_PER_MS));
    const result = await session.finish();
    expect(asr).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, text: "", rawText: "", durationMs: 3000 });
  });

  it("keeps the raw text when polishing fails or is off", async () => {
    const pcm = speech(2000, []);
    const failing = makeSession({ polish: async () => { throw new Error("router down"); } });
    failing.session.append(pcm);
    expect(await failing.session.finish()).toMatchObject({ ok: true, text: "chunk1(2000)", polished: false, translated: false });
    const off = makeSession({ polish: null });
    off.session.append(pcm);
    expect(await off.session.finish()).toMatchObject({ ok: true, text: "chunk1(2000)", polished: false });
  });

  it("reports a recogniser failure so the clip can be retried", async () => {
    const { session } = makeSession({ asr: async () => { throw new Error("ECONNREFUSED"); } });
    session.append(speech(2000, []));
    expect(await session.finish()).toMatchObject({ ok: false, code: "asr_failed", message: "ECONNREFUSED", cause: expect.any(Error) });
  });

  it("reports a decode failure", async () => {
    const { session } = makeSession({ decode: async () => { throw new Error("ffmpeg exploded"); } });
    session.append(Buffer.alloc(10));
    expect(await session.finish()).toMatchObject({ ok: false, code: "decode_failed", message: "ffmpeg exploded" });
  });

  it("cancel aborts in-flight work and finish reports cancelled", async () => {
    const { session, asr } = makeSession();
    session.append(speech(2000, []));
    session.cancel();
    expect(session.signal.aborted).toBe(true);
    expect(await session.finish()).toMatchObject({ ok: false, code: "cancelled" });
    expect(asr).not.toHaveBeenCalled();
  });

  it("limits chunks in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const { session } = makeSession({
      maxInFlight: 2,
      asr: async (wav: Buffer) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { language: "English", text: `c${wavMs(wav)}` };
      },
    });
    session.append(speech(40_000, [{ at: 8000, ms: 300 }, { at: 16_000, ms: 300 }, { at: 24_000, ms: 300 }, { at: 32_000, ms: 300 }]));
    const result = await session.finish();
    expect(result.ok).toBe(true);
    expect(peak).toBe(2);
  });
});

describe("polish groups", () => {
  it("polishes each thought at its long pause while recording; short pauses only split the recogniser's work", async () => {
    // Thought A (0–8.6 s) has a short hesitation at 4 s and ends with a 600 ms pause at 8 s;
    // thought B runs to the end with a short pause at 12 s.
    const pcm = speech(16_000, [{ at: 4000, ms: 200 }, { at: 8000, ms: 600 }, { at: 12_000, ms: 200 }]);
    let clock = 0;
    const polishCalls: { text: string; at: number }[] = [];
    const asr = vi.fn(async (wav: Buffer) => ({ language: "English", text: `c${Math.round((wav.length - 44) / PCM_BYTES_PER_MS / 100)}` }));
    const polish = vi.fn(async (text: string) => {
      polishCalls.push({ text, at: clock });
      return `P[${text}]`;
    });
    const session = new RecordingSession({ decode: async (b) => b, asr, polish, translate: false, now: () => clock, polishMode: "groups" });
    for (let ms = 0; ms < 16_000; ms += 1000) {
      clock += 1000;
      session.append(pcm.subarray(ms * PCM_BYTES_PER_MS, (ms + 1000) * PCM_BYTES_PER_MS));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    }
    // Chunks: [0, ~4.1] (short pause at 4 s, min 4 s), [~4.1, ~8.4] long pause → group A closed and polished before the stop.
    expect(session.chunksDispatched).toBeGreaterThanOrEqual(2);
    expect(polishCalls).toHaveLength(1);
    expect(polishCalls[0]!.at).toBeLessThan(16_000);
    const result = await session.finish();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Group B (everything after the long pause, including the tail) was polished at finish, as one text.
    expect(polishCalls).toHaveLength(2);
    expect(result.text).toBe(polishCalls.map((c) => `P[${c.text}]`).join(" "));
    expect(result.polished).toBe(true);
    expect(session.groupsPolished).toBe(2);
    expect(result.rawText.split(" ")).toHaveLength(session.chunksDispatched);
  });

  it("keeps a group's raw text when its polish fails and marks the clip unpolished", async () => {
    const pcm = speech(12_000, [{ at: 6000, ms: 600 }]);
    let n = 0;
    const session = new RecordingSession({
      decode: async (b) => b,
      asr: async () => ({ language: "English", text: `t${(n += 1)}` }),
      polish: async (text) => (text === "t1" ? "One." : Promise.reject(new Error("nope"))),
      translate: false,
      polishMode: "groups",
    });
    session.append(pcm);
    const result = await session.finish();
    expect(result).toMatchObject({ ok: true, text: "One. t2", polished: false });
  });
});

describe("critical path at finish", () => {
  it("splits a long tail at pauses into pieces that recognise in parallel, never shorter than tailMinMs", async () => {
    // 9 s with pauses at 4.5 s and 7 s and no long pause. Recording: 9 s usable minus the guard is 8.7 s,
    // the earliest pause after 4 s is at 4.5 s → chunk [0, 4.6]. Finish: tail [4.6, 9] is 4.4 s < 7 s → stays whole
    // (splitting at 7 s would leave a 2 s piece).
    const pcm = speech(9000, [{ at: 4500, ms: 200 }, { at: 7000, ms: 200 }]);
    const lengths: number[] = [];
    const asr = async (wav: Buffer) => { lengths.push(Math.round((wav.length - 44) / PCM_BYTES_PER_MS / 100) / 10); return { language: "English", text: "x" }; };
    const short = new RecordingSession({ decode: async (b) => b, asr, polish: null, translate: false, polishMode: "groups" });
    short.append(pcm);
    expect((await short.finish()).ok).toBe(true);
    expect(lengths).toEqual([4.6, 4.4]);

    // A 12 s tail with pauses at 4 s and 8 s is split into three ~4 s pieces.
    lengths.length = 0;
    const long = new RecordingSession({ decode: async (b) => b, asr, polish: null, translate: false, polishMode: "groups", targetMs: 100_000 });
    long.append(speech(12_000, [{ at: 4000, ms: 200 }, { at: 8000, ms: 200 }]));
    expect((await long.finish()).ok).toBe(true);
    expect(lengths).toEqual([4.1, 4, 3.9]);
  });

  it("closes a polish group once it spans groupMaxMs even without a long pause", async () => {
    // 30 s of speech with only short pauses every 5 s: groups must still close so the last polish stays small.
    const pcm = speech(30_000, [5000, 10_000, 15_000, 20_000, 25_000].map((at) => ({ at, ms: 200 })));
    const polished: string[] = [];
    let n = 0;
    const session = new RecordingSession({ decode: async (b) => b, asr: async () => ({ language: "English", text: `c${(n += 1)}` }), polish: async (t) => { polished.push(t); return t.toUpperCase(); }, translate: false, polishMode: "groups", groupMaxMs: 12_000 });
    session.append(pcm);
    const result = await session.finish();
    expect(result.ok).toBe(true);
    expect(polished.length).toBeGreaterThanOrEqual(2);
    for (const group of polished) expect(group.split(" ").length).toBeLessThanOrEqual(3);
  });
});

describe("recogniser context", () => {
  it("hands each chunk the text of the latest chunk already recognised", async () => {
    const pcm = speech(20_000, [{ at: 5000, ms: 300 }, { at: 10_000, ms: 300 }, { at: 15_000, ms: 300 }]);
    const seen: (string | null)[] = [];
    let n = 0;
    const session = new RecordingSession({
      decode: async (b) => b,
      asr: async (_wav, _signal, context) => {
        seen.push(context);
        await new Promise((r) => setTimeout(r, 5));
        return { language: "Hindi", text: `chunk${(n += 1)} `.repeat(30).trim() };
      },
      polish: null,
      translate: false,
      maxInFlight: 1, // serial, so every chunk sees its predecessor
    });
    session.append(pcm);
    const result = await session.finish();
    expect(result.ok).toBe(true);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toMatch(/chunk1$/);
    expect(seen[1]!.length).toBeLessThanOrEqual(200);
    expect(seen[2]).toMatch(/chunk2$/);
  });

  it("waits briefly for the previous chunk when contextWaitMs is set, so the tail still gets context", async () => {
    const pcm = speech(12_000, [{ at: 6000, ms: 300 }]);
    const seen: (string | null)[] = [];
    const session = new RecordingSession({
      decode: async (b) => b,
      asr: async (_wav, _signal, context) => {
        seen.push(context);
        await new Promise((r) => setTimeout(r, 30));
        return { language: "Hindi", text: `t${seen.length}` };
      },
      polish: null,
      translate: false,
      contextWaitMs: 500,
    });
    session.append(pcm);
    expect((await session.finish()).ok).toBe(true);
    // Both chunks were dispatched together (batch), yet the second waited for the first's text.
    expect(seen).toEqual([null, "t1"]);
  });
});
