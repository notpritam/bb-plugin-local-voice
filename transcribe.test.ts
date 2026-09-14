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
    config: { modelsDir, threads: 4, translate: true },
    homeDir: root,
    tempRoot: path.join(root, "tmp"),
    run,
    signal: new AbortController().signal,
    ...overrides,
  };
}
const request = (o: Partial<Parameters<typeof transcribeAudio>[0]> = {}) => ({
  model: "small",
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
    expect(result).toEqual({ ok: true, model: "small", text: "Hello there." });
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

  it("expands ~ in modelsDir", async () => {
    await mkdir(path.join(root, "home-models"));
    await writeFile(path.join(root, "home-models", "ggml-small.bin"), "m");
    const run = vi.fn<Runner>(async () => ok("x"));
    const result = await transcribeAudio(
      request(),
      deps(run, { config: { modelsDir: "~/home-models", threads: 1, translate: false } }),
    );
    expect(result.ok).toBe(true);
    expect(run.mock.calls[1]![1]).toContain(path.join(root, "home-models", "ggml-small.bin"));
  });

  it("reports a missing model as service_unavailable with a download hint", async () => {
    const run = vi.fn<Runner>();
    const result = await transcribeAudio(request({ model: "medium" }), deps(run));
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
    const result = await transcribeAudio(request({ model: "../etc" }), deps(run));
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

  it("returns an empty transcript for silence", async () => {
    const run = vi.fn<Runner>(async () => ok(" [BLANK_AUDIO]\n"));
    expect(await transcribeAudio(request(), deps(run))).toEqual({ ok: true, model: "small", text: "" });
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
