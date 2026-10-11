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
});
