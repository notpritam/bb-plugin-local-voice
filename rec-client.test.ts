import { describe, expect, it, vi } from "vitest";
import { RecordingUpload, type RpcTransport } from "./rec-client";

/** An rpc whose `rec_append` calls hang until `releaseAppend()`, like a slow link to omni. */
function slowRpc() {
  const appends: { seq: number; data: string }[] = [];
  const gates: (() => void)[] = [];
  const rpc: RpcTransport = {
    call: vi.fn(async (method: string, input: unknown) => {
      if (method === "rec_append") {
        const { seq, data } = input as { seq: number; data: string };
        appends.push({ seq, data: atob(data) });
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      if (method === "rec_result") return { status: "done", id: 1, text: "ok" } as never;
      return { ok: true } as never;
    }),
  };
  const releaseAppend = () => gates.shift()?.();
  return { rpc, appends, releaseAppend };
}

describe("RecordingUpload", () => {
  it("sends the slices that piled up during a slow append in one request, so a 250 ms recorder never outruns the link", async () => {
    const { rpc, appends, releaseAppend } = slowRpc();
    const upload = new RecordingUpload(rpc, "composer", "audio/webm");
    upload.append(new Blob(["a"]));
    await vi.waitFor(() => expect(appends).toEqual([{ seq: 0, data: "a" }]));
    upload.append(new Blob(["b"]));
    upload.append(new Blob(["c"]));
    upload.append(new Blob(["d"]));
    releaseAppend();
    await vi.waitFor(() => expect(appends).toEqual([{ seq: 0, data: "a" }, { seq: 1, data: "bcd" }]));
    releaseAppend();
    await expect(upload.finish()).resolves.toEqual({ id: 1, text: "ok" });
    expect(appends).toHaveLength(2);
  });

  it("Stop is one request: it does not wait for the append in flight, carries the unsent slices, and gets the text back", async () => {
    const calls: { method: string; input: Record<string, unknown> }[] = [];
    let releaseAppend: () => void = () => undefined;
    const rpc: RpcTransport = {
      call: vi.fn(async (method: string, input: unknown) => {
        calls.push({ method, input: input as Record<string, unknown> });
        if (method === "rec_append") await new Promise<void>((resolve) => (releaseAppend = resolve));
        if (method === "rec_finish") return { ok: true, result: { status: "done", id: 9, text: "Ship it." } } as never;
        return { ok: true } as never;
      }),
    };
    const upload = new RecordingUpload(rpc, "composer", "audio/webm");
    upload.append(new Blob(["a"]));
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_append"]));
    upload.append(new Blob(["b"]));
    upload.append(new Blob(["c"]));
    const finishing = upload.finish();
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_append", "rec_finish"]));
    expect(calls[2]!.input).toEqual({ uid: upload.uid, appends: 1, tail: btoa("bc"), wait: true });
    releaseAppend();
    await expect(finishing).resolves.toEqual({ id: 9, text: "Ship it." });
    expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_append", "rec_finish"]);
  });

  it("resends an append that failed in flight, so the server's wait for it ends", async () => {
    const calls: { method: string; input: Record<string, unknown> }[] = [];
    let failFirst: (error: Error) => void = () => undefined;
    const rpc: RpcTransport = {
      call: vi.fn(async (method: string, input: unknown) => {
        calls.push({ method, input: input as Record<string, unknown> });
        if (method === "rec_append" && calls.filter((c) => c.method === "rec_append").length === 1) {
          await new Promise<void>((_resolve, reject) => (failFirst = reject));
        }
        if (method === "rec_finish") return { ok: true, result: { status: "done", id: 9, text: "Ship it." } } as never;
        return { ok: true } as never;
      }),
    };
    const upload = new RecordingUpload(rpc, "composer", "audio/webm");
    upload.append(new Blob(["a"]));
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_append"]));
    const finishing = upload.finish();
    await vi.waitFor(() => expect(calls.at(-1)?.method).toBe("rec_finish"));
    expect(calls.at(-1)!.input).toMatchObject({ appends: 1, wait: true });
    failFirst(new Error("network"));
    await expect(finishing).resolves.toEqual({ id: 9, text: "Ship it." });
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["rec_start", "rec_append", "rec_finish", "rec_append"]));
    expect(atob(calls[3]!.input.data as string)).toBe("a");
  });

  it("counts only appends that landed, so earlier failures never leave the server waiting", async () => {
    const calls: { method: string; input: Record<string, unknown> }[] = [];
    let appendCalls = 0;
    const rpc: RpcTransport = {
      call: vi.fn(async (method: string, input: unknown) => {
        calls.push({ method, input: input as Record<string, unknown> });
        if (method === "rec_append" && (appendCalls += 1) === 1) throw new Error("blip");
        if (method === "rec_finish") return { ok: true, result: { status: "done", id: 9, text: "Ship it." } } as never;
        return { ok: true } as never;
      }),
    };
    const upload = new RecordingUpload(rpc, "composer", "audio/webm");
    upload.append(new Blob(["a"]));
    await vi.waitFor(() => expect(appendCalls).toBe(1));
    upload.append(new Blob(["b"]));
    await vi.waitFor(() => expect(appendCalls).toBe(2));
    await upload.finish();
    // The failed append was resent inside the second one: one landed, nothing left over.
    expect(atob(calls.find((c) => c.method === "rec_append" && atob(c.input.data as string) === "ab")!.input.data as string)).toBe("ab");
    expect(calls.at(-1)!.input).toEqual({ uid: upload.uid, appends: 1, wait: true });
  });

  it("polls when the server answers pending (or is an older one that does not wait)", async () => {
    const methods: string[] = [];
    const rpc: RpcTransport = {
      call: vi.fn(async (method: string) => {
        methods.push(method);
        if (method === "rec_finish") return { ok: true, result: { status: "pending" } } as never;
        if (method === "rec_result") return { status: "done", id: 4, text: "Later." } as never;
        return { ok: true } as never;
      }),
    };
    const upload = new RecordingUpload(rpc, "field", "audio/webm");
    upload.append(new Blob(["a"]));
    await expect(upload.finish()).resolves.toEqual({ id: 4, text: "Later." });
    expect(methods.at(-1)).toBe("rec_result");
  });

  it("a failed outcome in the finish answer throws with the kept clip's id", async () => {
    const rpc: RpcTransport = {
      call: vi.fn(async (method: string) => {
        if (method === "rec_finish") return { ok: true, result: { status: "failed", id: 6, message: "Scribe is down" } } as never;
        return { ok: true } as never;
      }),
    };
    const upload = new RecordingUpload(rpc, "field", "audio/webm");
    upload.append(new Blob(["a"]));
    await expect(upload.finish()).rejects.toMatchObject({ name: "TranscriptionFailed", message: "Scribe is down", clipId: 6 });
  });
});
