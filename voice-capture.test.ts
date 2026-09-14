// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fileNameFor, isVoiceSupported, pickMimeType, transcribeViaBb } from "./voice-capture";

describe("pickMimeType", () => {
  it("returns the first supported type in preference order", () => {
    expect(pickMimeType((m) => m === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => true)).toBe("audio/webm");
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe("fileNameFor", () => {
  it("derives the extension from the container", () => {
    expect(fileNameFor("audio/webm;codecs=opus")).toBe("bb-dock.webm");
    expect(fileNameFor("audio/mp4")).toBe("bb-dock.mp4");
    expect(fileNameFor("audio/ogg")).toBe("bb-dock.ogg");
    expect(fileNameFor("")).toBe("bb-dock.webm");
  });
});

describe("isVoiceSupported", () => {
  it("needs a secure context, mediaDevices, and MediaRecorder", () => {
    const base = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia: () => {} } }, MediaRecorder: class {} };
    expect(isVoiceSupported(base as unknown as Window)).toBe(true);
    expect(isVoiceSupported({ ...base, isSecureContext: false } as unknown as Window)).toBe(false);
    expect(isVoiceSupported({ ...base, MediaRecorder: undefined } as unknown as Window)).toBe(false);
    expect(isVoiceSupported({ ...base, navigator: {} } as unknown as Window)).toBe(false);
  });
});

describe("transcribeViaBb", () => {
  const file = new File(["x"], "recording.webm", { type: "audio/webm" });
  it("POSTs the clip as multipart to bb's voice endpoint and returns the text", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("same-origin");
      const sent = (init?.body as FormData).get("file") as File;
      expect([sent.name, sent.type, sent.size]).toEqual([file.name, file.type, file.size]);
      return new Response(JSON.stringify({ text: " hi " }), { status: 200 });
    });
    await expect(transcribeViaBb(file, new AbortController().signal, fetchImpl as unknown as typeof fetch)).resolves.toBe(" hi ");
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/v1/system/voice-transcription");
  });
  it("surfaces the server's error message", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: "transcription_unavailable", message: "Voice transcription is temporarily unavailable" }), { status: 503 }),
    );
    await expect(transcribeViaBb(file, new AbortController().signal, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "Voice transcription is temporarily unavailable",
    );
  });
  it("falls back to the status when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(transcribeViaBb(file, new AbortController().signal, fetchImpl as unknown as typeof fetch)).rejects.toThrow("500");
  });
});
