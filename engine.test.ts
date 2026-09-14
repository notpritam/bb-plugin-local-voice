import { describe, expect, it, vi } from "vitest";
import { buildPolishPrompt, parseAsrText, selectEngine, transcribeWithLlama } from "./engine";

describe("parseAsrText", () => {
  it("strips llama.cpp's language prefix and returns the detected language", () => {
    expect(parseAsrText("language Hindi<asr_text>यार कल का डिप्लॉय फेल हो गया था")).toEqual({
      language: "Hindi",
      text: "यार कल का डिप्लॉय फेल हो गया था",
    });
    expect(parseAsrText("language English<asr_text>Hello there. ")).toEqual({ language: "English", text: "Hello there." });
  });
  it("passes plain text through with no language", () => {
    expect(parseAsrText("  just text\n")).toEqual({ language: null, text: "just text" });
    expect(parseAsrText("")).toEqual({ language: null, text: "" });
  });
});

describe("selectEngine", () => {
  it("routes whisper-* models to whisper.cpp and everything else to the llama server", () => {
    expect(selectEngine("whisper-small")).toEqual({ kind: "whisper", model: "small" });
    expect(selectEngine("whisper-medium.en")).toEqual({ kind: "whisper", model: "medium.en" });
    expect(selectEngine("qwen3-asr")).toEqual({ kind: "llama", model: "qwen3-asr" });
  });
});

describe("transcribeWithLlama", () => {
  const wav = Buffer.from("RIFFfake");
  function fakeFetch(handlers: { asr?: (init: RequestInit) => Response; chat?: (body: unknown) => Response }) {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/audio/transcriptions")) {
        calls.push({ url: u, body: init?.body });
        return handlers.asr?.(init!) ?? new Response(JSON.stringify({ text: "language English<asr_text>hello" }));
      }
      const parsed = JSON.parse(String(init?.body));
      calls.push({ url: u, body: parsed });
      return handlers.chat?.(parsed) ?? new Response(JSON.stringify({ choices: [{ message: { content: " translated " } }] }));
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  }
  const base = (fetchImpl: typeof fetch, o: Partial<Parameters<typeof transcribeWithLlama>[0]> = {}) => ({
    wav,
    model: "qwen3-asr",
    serverUrl: "http://127.0.0.1:8091",
    polish: true,
    translate: true,
    polishModel: "gemma-4-e4b",
    remainingMs: () => 8000,
    signal: new AbortController().signal,
    fetchImpl,
    ...o,
  });

  it("posts the wav as multipart with the model, then polishes even English", async () => {
    const { fetchImpl, calls } = fakeFetch({
      chat: () => new Response(JSON.stringify({ choices: [{ message: { content: "Hello." } }] })),
    });
    const result = await transcribeWithLlama(base(fetchImpl));
    expect(result).toEqual({ ok: true, text: "Hello.", language: "English", polished: true });
    expect(calls).toHaveLength(2);
    const form = calls[0]!.body as FormData;
    expect(form.get("model")).toBe("qwen3-asr");
    expect((form.get("file") as File).name).toBe("audio.wav");
  });

  it("returns the raw transcript when polishing is off", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const result = await transcribeWithLlama(base(fetchImpl, { polish: false }));
    expect(result).toEqual({ ok: true, text: "hello", language: "English", polished: false });
    expect(calls).toHaveLength(1);
  });

  it("polishes through the chat endpoint with thinking off and the English rule when translate is on", async () => {
    const { fetchImpl, calls } = fakeFetch({
      asr: () => new Response(JSON.stringify({ text: "language Hindi<asr_text>यार कल" })),
      chat: (body) => {
        const b = body as { model: string; temperature: number; chat_template_kwargs: { enable_thinking: boolean }; messages: { role: string; content: string }[] };
        expect(b.model).toBe("gemma-4-e4b");
        expect(b.temperature).toBe(0);
        expect(b.chat_template_kwargs.enable_thinking).toBe(false);
        expect(b.messages[0]!.role).toBe("system");
        expect(b.messages[0]!.content).toContain("must be in English");
        expect(b.messages.at(-1)).toEqual({ role: "user", content: "यार कल" });
        return new Response(JSON.stringify({ choices: [{ message: { content: "Dude, yesterday" } }] }));
      },
    });
    const result = await transcribeWithLlama(base(fetchImpl));
    expect(result).toEqual({ ok: true, text: "Dude, yesterday", language: "Hindi", polished: true });
    expect(calls.map((c) => c.url.split("/v1/")[1])).toEqual(["audio/transcriptions", "chat/completions"]);
  });

  it("keeps the spoken language when translate is off", async () => {
    const { fetchImpl, calls } = fakeFetch({
      asr: () => new Response(JSON.stringify({ text: "language Hindi<asr_text>नमस्ते" })),
      chat: (body) => {
        const b = body as { messages: { content: string }[] };
        expect(b.messages[0]!.content).toContain("Keep the speaker's language");
        expect(b.messages[0]!.content).not.toContain("must be in English");
        return new Response(JSON.stringify({ choices: [{ message: { content: "नमस्ते।" } }] }));
      },
    });
    expect(await transcribeWithLlama(base(fetchImpl, { translate: false }))).toMatchObject({ text: "नमस्ते।", polished: true });
    expect(calls).toHaveLength(2);
  });

  it("skips polishing when the text is empty or when the budget is nearly spent", async () => {
    const hindi = () => new Response(JSON.stringify({ text: "language Hindi<asr_text>नमस्ते" }));
    let f = fakeFetch({ asr: hindi });
    expect(await transcribeWithLlama(base(f.fetchImpl, { remainingMs: () => 900 }))).toMatchObject({ text: "नमस्ते", polished: false });
    expect(f.calls).toHaveLength(1);

    f = fakeFetch({ asr: () => new Response(JSON.stringify({ text: "language Hindi<asr_text>" })) });
    expect(await transcribeWithLlama(base(f.fetchImpl))).toMatchObject({ text: "", polished: false });
    expect(f.calls).toHaveLength(1);
  });

  it("falls back to the raw transcript when polishing fails or returns nothing", async () => {
    const hindi = () => new Response(JSON.stringify({ text: "language Hindi<asr_text>नमस्ते" }));
    let f = fakeFetch({ asr: hindi, chat: () => new Response("boom", { status: 500 }) });
    expect(await transcribeWithLlama(base(f.fetchImpl))).toMatchObject({ ok: true, text: "नमस्ते", polished: false });
    f = fakeFetch({ asr: hindi, chat: () => new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] })) });
    expect(await transcribeWithLlama(base(f.fetchImpl))).toMatchObject({ ok: true, text: "नमस्ते", polished: false });
  });

  it("buildPolishPrompt carries the transcriptionist rules", () => {
    const english = buildPolishPrompt(true);
    expect(english).toContain("filler words");
    expect(english).toContain("Never answer");
    expect(english).toContain("dot t s x");
    expect(buildPolishPrompt(false)).toContain("Keep the speaker's language");
  });

  it("maps a refused connection to service_unavailable naming the systemd unit", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const result = await transcribeWithLlama(base(fetchImpl));
    expect(result).toMatchObject({ ok: false, code: "service_unavailable" });
    if (!result.ok) expect(result.message).toContain("bb-local-voice");
  });

  it("maps an HTTP error to request_failed with the server's message and an abort to timeout", async () => {
    let f = fakeFetch({ asr: () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }) });
    const failed = await transcribeWithLlama(base(f.fetchImpl));
    expect(failed).toMatchObject({ ok: false, code: "request_failed" });
    if (!failed.ok) expect(failed.message).toContain("model not found");

    const aborted = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    expect(await transcribeWithLlama(base(aborted))).toMatchObject({ ok: false, code: "timeout" });
  });
});
