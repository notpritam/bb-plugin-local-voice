import { describe, expect, it, vi } from "vitest";
import { selectEngine, transcribeWithScribe, type FormatFn } from "./engine";
import { KEYTERMS, SCRIBE_URL, languageName, readApiKey, scribeRequest } from "./scribe";
import { PCM_BYTES_PER_MS, pcmToWav } from "./stream";

/** Audible tone as a 16 kHz wav. */
function toneWav(ms = 1000): Buffer {
  const pcm = Buffer.alloc(ms * PCM_BYTES_PER_MS);
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), i * 2);
  return pcmToWav(pcm);
}

function scribeFetch(answer: () => Response = () => new Response(JSON.stringify({ text: "hello", language_code: "eng", language_probability: 0.98 }))) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return answer();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("selectEngine", () => {
  it("routes whisper-* to whisper.cpp, scribe* to that ElevenLabs model, and old names to the configured Scribe model", () => {
    expect(selectEngine("whisper-small")).toEqual({ kind: "whisper", model: "small" });
    expect(selectEngine("whisper-medium.en")).toEqual({ kind: "whisper", model: "medium.en" });
    expect(selectEngine("scribe_v1")).toEqual({ kind: "scribe", model: "scribe_v1" });
    expect(selectEngine("qwen3-asr")).toEqual({ kind: "scribe", model: "scribe_v2" });
    expect(selectEngine("qwen3-asr-0.6b", "scribe_v1")).toEqual({ kind: "scribe", model: "scribe_v1" });
  });
});

describe("scribeRequest", () => {
  const pcm = Buffer.alloc(3200, 1);
  const call = (fetchImpl: typeof fetch, apiKey: string | null = "k-test") =>
    scribeRequest({ pcm, apiKey, model: "scribe_v2", signal: new AbortController().signal, budgetMs: 5000, fetchImpl });

  it("posts raw PCM as multipart with the agreed fields and the key header", async () => {
    const { fetchImpl, calls } = scribeFetch();
    await expect(call(fetchImpl)).resolves.toEqual({ language: "English", text: "hello" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SCRIBE_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("k-test");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("file_format")).toBe("pcm_s16le_16");
    expect(form.get("no_verbatim")).toBe("true");
    expect(form.get("tag_audio_events")).toBe("false");
    expect(form.get("timestamps_granularity")).toBe("none");
    expect(form.has("language_code")).toBe(false);
    expect(form.has("diarize")).toBe(false);
    expect(form.has("prompt")).toBe(false);
    expect(form.getAll("keyterms")).toEqual([...KEYTERMS]);
    expect((form.get("file") as File).size).toBe(pcm.length);
  });

  it("keeps the keyterm list within ElevenLabs' limits", () => {
    expect(KEYTERMS.length).toBeLessThan(50);
    for (const term of KEYTERMS) {
      expect(term.length).toBeLessThan(50);
      expect(term.split(/\s+/u).length).toBeLessThanOrEqual(5);
    }
  });

  it("maps language codes to names", async () => {
    expect(languageName("eng")).toBe("English");
    expect(languageName("hin")).toBe("Hindi");
    expect(languageName("xyz")).toBe("xyz");
    expect(languageName(null)).toBeNull();
    const { fetchImpl } = scribeFetch(() => new Response(JSON.stringify({ text: " कल का meeting reschedule कर दो ", language_code: "hin" })));
    await expect(call(fetchImpl)).resolves.toEqual({ language: "Hindi", text: "कल का meeting reschedule कर दो" });
  });

  it("maps 401/403 to service_unavailable about the key, without calling when no key is set", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = scribeFetch(() => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status }));
      const error = await call(fetchImpl).catch((e: unknown) => e as { code: string; message: string });
      expect(error).toMatchObject({ code: "service_unavailable" });
      expect((error as { message: string }).message).toContain("API key");
      expect((error as { message: string }).message).toContain("Invalid API key");
    }
    const { fetchImpl, calls } = scribeFetch();
    await expect(call(fetchImpl, null)).rejects.toMatchObject({ code: "service_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("maps 429 to rate_limited, 5xx to service_unavailable, other 4xx to request_failed", async () => {
    await expect(call(scribeFetch(() => new Response("{}", { status: 429 })).fetchImpl)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(call(scribeFetch(() => new Response("upstream", { status: 500 })).fetchImpl)).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(call(scribeFetch(() => new Response("upstream", { status: 503 })).fetchImpl)).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(call(scribeFetch(() => new Response(JSON.stringify({ detail: "bad file" }), { status: 422 })).fetchImpl)).rejects.toMatchObject({ code: "request_failed", message: expect.stringContaining("bad file") });
  });

  it("maps a network failure to service_unavailable and an abort to timeout, never mentioning a local server", async () => {
    const down = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch;
    const error = (await call(down).catch((e: unknown) => e)) as { code: string; message: string };
    expect(error.code).toBe("service_unavailable");
    expect(error.message).toContain("ElevenLabs");
    expect(error.message).not.toMatch(/Local Voice server|llama|systemctl/u);
    const aborted = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    await expect(call(aborted)).rejects.toMatchObject({ code: "timeout" });
  });

  it("treats a sliver of audio as no words instead of an error", async () => {
    const { fetchImpl, calls } = scribeFetch();
    await expect(scribeRequest({ pcm: Buffer.alloc(1000), apiKey: "k", model: "scribe_v2", signal: new AbortController().signal, budgetMs: 1000, fetchImpl })).resolves.toEqual({ language: null, text: "" });
    expect(calls).toHaveLength(0);
    const tooShort = scribeFetch(() => new Response(JSON.stringify({ detail: { code: "audio_too_short", message: "Audio is too short." } }), { status: 400 }));
    await expect(call(tooShort.fetchImpl)).resolves.toEqual({ language: null, text: "" });
  });

  it("rejects a response without text", async () => {
    await expect(call(scribeFetch(() => new Response(JSON.stringify({ language_code: "eng" }))).fetchImpl)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("readApiKey", () => {
  it("reads the host's key file first, then the env var", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "lv-key-"));
    try {
      expect(await readApiKey(dir, {})).toBeNull();
      expect(await readApiKey(dir, { ELEVENLABS_API_KEY: " from-env " })).toBe("from-env");
      await writeFile(path.join(dir, "elevenlabs-api-key"), "from-file\n");
      expect(await readApiKey(dir, { ELEVENLABS_API_KEY: "from-env" })).toBe("from-file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("transcribeWithScribe", () => {
  const base = (fetchImpl: typeof fetch, o: Partial<Parameters<typeof transcribeWithScribe>[0]> = {}) => ({
    wav: toneWav(),
    model: "scribe_v2",
    apiKey: "k-test",
    polish: true,
    translate: true,
    format: vi.fn<FormatFn>(async () => "Formatted."),
    remainingMs: () => 8000,
    signal: new AbortController().signal,
    fetchImpl,
    ...o,
  });

  it("sends the chunk's PCM (no wav header) and formats the joined text", async () => {
    const { fetchImpl, calls } = scribeFetch(() => new Response(JSON.stringify({ text: "कल का meeting reschedule कर दो", language_code: "hin" })));
    const args = base(fetchImpl);
    const result = await transcribeWithScribe(args);
    expect(result).toEqual({ ok: true, text: "Formatted.", rawText: "कल का meeting reschedule कर दो", language: "Hindi", polished: true, translated: true, asrMs: expect.any(Number), polishMs: expect.any(Number) });
    expect(((calls[0]!.init.body as FormData).get("file") as File).size).toBe(1000 * PCM_BYTES_PER_MS);
    expect(args.format).toHaveBeenCalledWith("कल का meeting reschedule कर दो", true, expect.any(AbortSignal), expect.any(Number));
  });

  it("returns Scribe's text when formatting is off, gives nothing back, or the budget is nearly spent", async () => {
    let f = scribeFetch();
    expect(await transcribeWithScribe(base(f.fetchImpl, { polish: false }))).toMatchObject({ text: "hello", polished: false, polishMs: null });
    f = scribeFetch();
    expect(await transcribeWithScribe(base(f.fetchImpl, { format: async () => null }))).toMatchObject({ text: "hello", polished: false });
    const format = vi.fn<FormatFn>(async () => "never");
    f = scribeFetch();
    expect(await transcribeWithScribe(base(f.fetchImpl, { format, remainingMs: () => 900 }))).toMatchObject({ text: "hello", polished: false });
    expect(format).not.toHaveBeenCalled();
  });

  it("passes the formatter the time left of bb's budget", async () => {
    const format = vi.fn<FormatFn>(async () => "Hi.");
    await transcribeWithScribe(base(scribeFetch().fetchImpl, { format, remainingMs: () => 4000 }));
    expect(format.mock.calls[0]![3]).toBe(3750);
  });

  it("surfaces Scribe failures with their code", async () => {
    expect(await transcribeWithScribe(base(scribeFetch(() => new Response("{}", { status: 429 })).fetchImpl))).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await transcribeWithScribe(base(scribeFetch().fetchImpl, { apiKey: null }))).toMatchObject({ ok: false, code: "service_unavailable" });
  });
});
