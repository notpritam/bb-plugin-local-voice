import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand, transcribeAudio, type RunResult, type Runner } from "./transcribe";

const AUDIO = Buffer.from("fake-webm").toString("base64");
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, missing: false });

let root: string;
let modelsDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bbw-test-"));
  modelsDir = path.join(root, "models");
  await mkdir(modelsDir);
  await writeFile(path.join(modelsDir, "ggml-small.bin"), "model");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(run: Runner, overrides: Partial<Parameters<typeof transcribeAudio>[1]> = {}) {
  return {
    config: { modelsDir, threads: 4, translate: true, polish: true, serverUrl: "http://127.0.0.1:8091", polishModel: "gemma-4-e4b" },
    homeDir: root,
    tempRoot: path.join(root, "tmp"),
    run,
    signal: new AbortController().signal,
    ...overrides,
  };
}
const request = (o: Partial<Parameters<typeof transcribeAudio>[0]> = {}) => ({
  model: "whisper-small",
  audioBase64: AUDIO,
  mimeType: "audio/webm;codecs=opus",
  prompt: null,
  timeoutMs: 10_000,
  ...o,
});

describe("transcribeAudio", () => {
  it("runs ffmpeg then whisper-cli and returns the cleaned transcript", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = vi.fn<Runner>(async (cmd, args) => {
      calls.push({ cmd, args });
      return cmd === "whisper-cli" ? ok("\n [BLANK_AUDIO] Hello there. \n") : ok();
    });
    const result = await transcribeAudio(request(), deps(run));
    expect(result).toEqual({ ok: true, model: "whisper-small", text: "Hello there." });
    expect(calls.map((c) => c.cmd)).toEqual(["ffmpeg", "whisper-cli"]);
    const ffmpegInput = calls[0]!.args[calls[0]!.args.indexOf("-i") + 1]!;
    expect(ffmpegInput.endsWith("/in.webm")).toBe(true);
    const whisperArgs = calls[1]!.args;
    expect(whisperArgs).toContain("-tr");
    expect(whisperArgs[whisperArgs.indexOf("-m") + 1]).toBe(path.join(modelsDir, "ggml-small.bin"));
    expect(whisperArgs[whisperArgs.indexOf("-t") + 1]).toBe("4");
  });

  it("writes the decoded audio to the temp dir and removes it afterwards", async () => {
    let seenDir = "";
    const run = vi.fn<Runner>(async (cmd, args) => {
      if (cmd === "ffmpeg") {
        const input = args[args.indexOf("-i") + 1]!;
        seenDir = path.dirname(input);
        const { readFile } = await import("node:fs/promises");
        expect((await readFile(input)).toString()).toBe("fake-webm");
      }
      return ok("hi");
    });
    await transcribeAudio(request(), deps(run));
    expect(seenDir.startsWith(path.join(root, "tmp"))).toBe(true);
    await expect(readdir(seenDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never lets a wav upload collide with the converted wav", async () => {
    const paths: string[] = [];
    const run = vi.fn<Runner>(async (cmd, args) => {
      if (cmd === "ffmpeg") paths.push(args[args.indexOf("-i") + 1]!, args[args.length - 1]!);
      return ok("x");
    });
    await transcribeAudio(request({ mimeType: "audio/wav" }), deps(run));
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths[0]!.endsWith(".wav")).toBe(true);
  });

  it("expands ~ in modelsDir", async () => {
    await mkdir(path.join(root, "home-models"));
    await writeFile(path.join(root, "home-models", "ggml-small.bin"), "m");
    const run = vi.fn<Runner>(async () => ok("x"));
    const result = await transcribeAudio(
      request(),
      deps(run, { config: { modelsDir: "~/home-models", threads: 1, translate: false, polish: true, serverUrl: "http://127.0.0.1:8091", polishModel: "gemma-4-e4b" } }),
    );
    expect(result.ok).toBe(true);
    expect(run.mock.calls[1]![1]).toContain(path.join(root, "home-models", "ggml-small.bin"));
  });

  it("reports a missing model as service_unavailable with a download hint", async () => {
    const run = vi.fn<Runner>();
    const result = await transcribeAudio(request({ model: "whisper-medium" }), deps(run));
    expect(result).toMatchObject({ ok: false, code: "service_unavailable" });
    if (!result.ok) {
      expect(result.message).toContain(path.join(modelsDir, "ggml-medium.bin"));
      expect(result.message).toContain("ggml-medium.bin");
      expect(result.message).toContain("huggingface.co");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an invalid model name before touching the filesystem", async () => {
    const run = vi.fn<Runner>();
    const result = await transcribeAudio(request({ model: "whisper-../etc" }), deps(run));
    expect(result).toMatchObject({ ok: false, code: "request_failed" });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps a missing binary to service_unavailable", async () => {
    const run = vi.fn<Runner>(async (cmd) =>
      cmd === "ffmpeg" ? { code: null, stdout: "", stderr: "", timedOut: false, missing: true } : ok("x"),
    );
    const result = await transcribeAudio(request(), deps(run));
    expect(result).toMatchObject({ ok: false, code: "service_unavailable" });
    if (!result.ok) expect(result.message).toContain("ffmpeg");
  });

  it("maps a timeout to timeout and a non-zero exit to request_failed with the last stderr line", async () => {
    const timedOut = vi.fn<Runner>(async () => ({ code: null, stdout: "", stderr: "", timedOut: true, missing: false }));
    expect(await transcribeAudio(request(), deps(timedOut))).toMatchObject({ ok: false, code: "timeout" });

    const failed = vi.fn<Runner>(async (cmd) =>
      cmd === "whisper-cli"
        ? { code: 3, stdout: "", stderr: "warn\nerror: failed to load model\n", timedOut: false, missing: false }
        : ok(),
    );
    const result = await transcribeAudio(request(), deps(failed));
    expect(result).toMatchObject({ ok: false, code: "request_failed" });
    if (!result.ok) expect(result.message).toContain("failed to load model");
  });

  it("gives whisper-cli only the time ffmpeg left over", async () => {
    const budgets: number[] = [];
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const run = vi.fn<Runner>(async (cmd, _args, o) => {
      budgets.push(o.timeoutMs);
      if (cmd === "ffmpeg") now += 400;
      return ok("x");
    });
    await transcribeAudio(request({ timeoutMs: 2_000 }), deps(run));
    expect(budgets[0]).toBe(2_000);
    expect(budgets[1]).toBe(1_600);
    vi.restoreAllMocks();
  });

  it("skips whisper-cli when the converted wav is silent", async () => {
    const run = vi.fn<Runner>(async (cmd, args) => {
      if (cmd === "ffmpeg") {
        const { writeFile: write } = await import("node:fs/promises");
        // RIFF wav with 4 zero samples
        const data = Buffer.alloc(8);
        const header = Buffer.from("RIFF\x2c\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\x3e\x00\x00\x00\x7d\x00\x00\x02\x00\x10\x00data\x08\x00\x00\x00", "binary");
        await write(args[args.length - 1]!, Buffer.concat([header, data]));
      }
      return ok("you");
    });
    const result = await transcribeAudio(request(), deps(run));
    expect(result).toEqual({ ok: true, model: "whisper-small", text: "" });
    expect(run.mock.calls.map((c) => c[0])).toEqual(["ffmpeg"]);
  });

  it("returns an empty transcript for silence", async () => {
    const run = vi.fn<Runner>(async () => ok(" [BLANK_AUDIO]\n"));
    expect(await transcribeAudio(request(), deps(run))).toEqual({ ok: true, model: "whisper-small", text: "" });
  });
});

describe("transcribeAudio via llama-server", () => {
  const wavBytes = () => {
    const data = Buffer.alloc(8);
    data.writeInt16LE(20000, 0);
    data.writeInt16LE(-20000, 2);
    const header = Buffer.from("RIFF\x2c\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\x3e\x00\x00\x00\x7d\x00\x00\x02\x00\x10\x00data\x08\x00\x00\x00", "binary");
    return Buffer.concat([header, data]);
  };
  const ffmpegWritesWav = vi.fn<Runner>(async (cmd, args) => {
    if (cmd === "ffmpeg") {
      const { writeFile: write } = await import("node:fs/promises");
      await write(args[args.length - 1]!, wavBytes());
    }
    return ok();
  });

  it("sends the converted wav to the llama server and never runs whisper-cli", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/audio/transcriptions")) {
        const form = init?.body as FormData;
        expect(form.get("model")).toBe("qwen3-asr");
        expect((form.get("file") as File).size).toBe(52);
        return new Response(JSON.stringify({ text: "language English<asr_text>hi there" }));
      }
      throw new Error("unexpected " + String(url));
    }) as unknown as typeof fetch;
    const result = await transcribeAudio(request({ model: "qwen3-asr" }), deps(ffmpegWritesWav, { fetchImpl }));
    expect(result).toEqual({ ok: true, model: "qwen3-asr", text: "hi there" });
    expect(ffmpegWritesWav.mock.calls.map((c) => c[0])).toEqual(["ffmpeg"]);
  });

  it("does not require a whisper model file for the llama engine", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "ok" }))) as unknown as typeof fetch;
    const result = await transcribeAudio(request({ model: "qwen3-asr-0.6b" }), deps(ffmpegWritesWav, { fetchImpl }));
    expect(result).toEqual({ ok: true, model: "qwen3-asr-0.6b", text: "ok" });
  });

  it("passes llama failures through", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const result = await transcribeAudio(request({ model: "qwen3-asr" }), deps(ffmpegWritesWav, { fetchImpl }));
    expect(result).toMatchObject({ ok: false, code: "service_unavailable" });
  });
});

describe("runCommand", () => {
  it("captures stdout and exit code", async () => {
    const result = await runCommand("sh", ["-c", "echo out; echo err 1>&2; exit 2"], {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ code: 2, stdout: "out\n", stderr: "err\n", timedOut: false, missing: false });
  });
  it("reports a missing binary instead of throwing", async () => {
    const result = await runCommand("definitely-not-a-binary-xyz", [], {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(result.missing).toBe(true);
  });
  it("kills the child on timeout", async () => {
    const result = await runCommand("sleep", ["5"], { signal: new AbortController().signal, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
  it("kills the child on abort", async () => {
    const controller = new AbortController();
    const pending = runCommand("sleep", ["5"], { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
  });
});
