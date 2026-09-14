import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  audioExtensionFor,
  buildFfmpegArgs,
  buildWhisperArgs,
  cleanTranscript,
  configFromSettings,
  expandHome,
  failure,
  lastLine,
  resolveModelPath,
  wavRmsDb,
} from "./whisper";

describe("configFromSettings", () => {
  it("returns defaults for empty input", () => {
    expect(configFromSettings({})).toEqual(DEFAULT_CONFIG);
  });
  it("parses threads from a string and clamps to 1..64", () => {
    expect(configFromSettings({ threads: "8" }).threads).toBe(8);
    expect(configFromSettings({ threads: "0" }).threads).toBe(1);
    expect(configFromSettings({ threads: "999" }).threads).toBe(64);
    expect(configFromSettings({ threads: "abc" }).threads).toBe(DEFAULT_CONFIG.threads);
  });
  it("trims modelsDir and falls back to the default when blank", () => {
    expect(configFromSettings({ modelsDir: "  /models " }).modelsDir).toBe("/models");
    expect(configFromSettings({ modelsDir: "   " }).modelsDir).toBe(DEFAULT_CONFIG.modelsDir);
  });
  it("trims serverUrl and translateModel and falls back to defaults", () => {
    expect(configFromSettings({ serverUrl: " http://10.0.0.2:9000/ " }).serverUrl).toBe("http://10.0.0.2:9000");
    expect(configFromSettings({ serverUrl: "" }).serverUrl).toBe(DEFAULT_CONFIG.serverUrl);
    expect(configFromSettings({ polishModel: " gemma-4-e2b " }).polishModel).toBe("gemma-4-e2b");
    expect(configFromSettings({ polishModel: "" }).polishModel).toBe(DEFAULT_CONFIG.polishModel);
    expect(configFromSettings({ polish: false }).polish).toBe(false);
    expect(configFromSettings({}).polish).toBe(true);
  });
  it("only accepts a real boolean for translate", () => {
    expect(configFromSettings({ translate: false }).translate).toBe(false);
    expect(configFromSettings({ translate: "false" }).translate).toBe(true);
  });
});

describe("expandHome", () => {
  it("expands a leading ~/", () => {
    expect(expandHome("~/.bb/whisper-models", "/home/p")).toBe("/home/p/.bb/whisper-models");
  });
  it("leaves absolute paths alone", () => {
    expect(expandHome("/opt/models", "/home/p")).toBe("/opt/models");
  });
});

describe("resolveModelPath", () => {
  it("maps a model name to ggml-<model>.bin inside modelsDir", () => {
    expect(resolveModelPath("small", "/m")).toEqual({ ok: true, path: "/m/ggml-small.bin" });
    expect(resolveModelPath("large-v3", "/m")).toEqual({ ok: true, path: "/m/ggml-large-v3.bin" });
    expect(resolveModelPath("small.en", "/m")).toEqual({ ok: true, path: "/m/ggml-small.en.bin" });
  });
  it("refuses names that could escape the directory", () => {
    for (const bad of ["../x", "a/b", "", "Small", ".hidden", "x".repeat(65)]) {
      const result = resolveModelPath(bad, "/m");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("request_failed");
    }
  });
});

describe("audioExtensionFor", () => {
  it("maps browser recorder mime types", () => {
    expect(audioExtensionFor("audio/webm")).toBe("webm");
    expect(audioExtensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtensionFor("audio/mp4")).toBe("mp4");
    expect(audioExtensionFor("video/mp4")).toBe("mp4");
    expect(audioExtensionFor("audio/ogg")).toBe("ogg");
    expect(audioExtensionFor("audio/wav")).toBe("wav");
    expect(audioExtensionFor("audio/x-wav")).toBe("wav");
    expect(audioExtensionFor("audio/mpeg")).toBe("mp3");
    expect(audioExtensionFor("audio/flac")).toBe("flac");
  });
  it("falls back to bin so ffmpeg sniffs the container", () => {
    expect(audioExtensionFor("application/octet-stream")).toBe("bin");
  });
});

describe("arg builders", () => {
  it("builds ffmpeg args for 16 kHz mono pcm", () => {
    expect(buildFfmpegArgs("/t/in.webm", "/t/in.wav")).toEqual([
      "-y", "-loglevel", "error", "-i", "/t/in.webm",
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "/t/in.wav",
    ]);
  });
  it("builds whisper-cli args with translate and prompt", () => {
    expect(
      buildWhisperArgs({ modelPath: "/m/ggml-small.bin", wavPath: "/t/in.wav", threads: 12, translate: true, prompt: "bb, Codex" }),
    ).toEqual([
      "-m", "/m/ggml-small.bin", "-f", "/t/in.wav",
      "-l", "auto", "-nt", "-np", "-t", "12", "-tr", "--prompt", "bb, Codex",
    ]);
  });
  it("omits -tr and --prompt when not wanted", () => {
    const args = buildWhisperArgs({ modelPath: "/m/x.bin", wavPath: "/t/a.wav", threads: 4, translate: false, prompt: null });
    expect(args).not.toContain("-tr");
    expect(args).not.toContain("--prompt");
  });
});

describe("cleanTranscript", () => {
  it("trims, collapses whitespace, and drops whisper tags", () => {
    expect(cleanTranscript("\n [BLANK_AUDIO] \n Hello   world. \n (silence)\n")).toBe("Hello world.");
    expect(cleanTranscript("[_BEG_] Hi [BLANK_AUDIO]")).toBe("Hi");
  });
  it("returns an empty string for silence", () => {
    expect(cleanTranscript(" [BLANK_AUDIO]\n")).toBe("");
  });
});

describe("misc", () => {
  it("lastLine returns the last non-empty line", () => {
    expect(lastLine("a\nb\n\n")).toBe("b");
    expect(lastLine("")).toBe("");
  });
  it("failure builds the contract shape", () => {
    expect(failure("timeout", "slow")).toEqual({ ok: false, code: "timeout", message: "slow" });
  });
});

describe("wavRmsDb", () => {
  function wav(samples: number[], extraChunk = false): Buffer {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
    const list = extraChunk ? Buffer.concat([Buffer.from("LIST"), u32(4), Buffer.from("INFO")]) : Buffer.alloc(0);
    const fmt = Buffer.concat([Buffer.from("fmt "), u32(16), Buffer.from([1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0])]);
    const body = Buffer.concat([Buffer.from("WAVE"), fmt, list, Buffer.from("data"), u32(data.length), data]);
    return Buffer.concat([Buffer.from("RIFF"), u32(body.length), body]);
  }
  function u32(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  }
  it("is -Infinity for digital silence and 0 dBFS for full scale", () => {
    expect(wavRmsDb(wav([0, 0, 0, 0]))).toBe(Number.NEGATIVE_INFINITY);
    expect(wavRmsDb(wav([32767, -32768, 32767, -32768]))).toBeCloseTo(0, 1);
  });
  it("measures a quiet signal in dBFS", () => {
    expect(wavRmsDb(wav([328, -328, 328, -328]))).toBeCloseTo(-40, 0);
  });
  it("skips metadata chunks before the data chunk", () => {
    expect(wavRmsDb(wav([32767, -32768], true))).toBeCloseTo(0, 1);
  });
  it("returns null for something that is not a RIFF wav", () => {
    expect(wavRmsDb(Buffer.from("not a wav file at all"))).toBeNull();
  });
});
