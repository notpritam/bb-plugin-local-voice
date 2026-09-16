// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCK_ATTR,
  insertTextAtCursor,
  isVoiceTarget,
  mountVoiceDock,
  type Recorder,
} from "./voice-dock";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, parent: Element = document.body) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.appendChild(node);
  return node;
}
const dock = () => document.querySelector<HTMLButtonElement>(`[${DOCK_ATTR}]`);
const focus = (node: HTMLElement) => {
  node.focus();
  node.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
};
const blur = (node: HTMLElement, relatedTarget: Element | null = null) => {
  node.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget }));
  // A real blur() fires a second focusout with relatedTarget null; only do it
  // when that is the scenario under test.
  if (relatedTarget === null) node.blur();
};

function fakeRecorder(text = "spoken text") {
  const recorder: Recorder = { stop: vi.fn(async () => text), cancel: vi.fn() };
  return recorder;
}

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("isVoiceTarget", () => {
  it("accepts textareas, text-like inputs, and contenteditable", () => {
    expect(isVoiceTarget(el("textarea"))).toBe(true);
    expect(isVoiceTarget(el("input"))).toBe(true);
    expect(isVoiceTarget(el("input", { type: "search" }))).toBe(true);
    expect(isVoiceTarget(el("div", { contenteditable: "true" }))).toBe(true);
    expect(isVoiceTarget(el("div", { contenteditable: "" }))).toBe(true);
  });
  it("rejects passwords, disabled/readonly fields, plain divs, and bb's composer", () => {
    expect(isVoiceTarget(el("input", { type: "password" }))).toBe(false);
    expect(isVoiceTarget(el("input", { type: "checkbox" }))).toBe(false);
    expect(isVoiceTarget(el("textarea", { disabled: "" }))).toBe(false);
    expect(isVoiceTarget(el("textarea", { readonly: "" }))).toBe(false);
    expect(isVoiceTarget(el("div"))).toBe(false);
    expect(isVoiceTarget(el("div", { contenteditable: "false" }))).toBe(false);
    const composer = el("div", { "data-app-composer": "" });
    expect(isVoiceTarget(el("div", { contenteditable: "true" }, composer))).toBe(false);
    expect(isVoiceTarget(null)).toBe(false);
  });
});

describe("insertTextAtCursor", () => {
  it("inserts at the caret in a textarea, adds a leading space after a word, and fires input", () => {
    const area = el("textarea");
    area.value = "hello world";
    area.focus();
    area.setSelectionRange(5, 5);
    const onInput = vi.fn();
    area.addEventListener("input", onInput);
    insertTextAtCursor(area, "there");
    expect(area.value).toBe("hello there world");
    expect(area.selectionStart).toBe(11);
    expect(onInput).toHaveBeenCalledTimes(1);
  });
  it("does not add a space at the start or after whitespace", () => {
    const input = el("input");
    input.value = "";
    input.focus();
    insertTextAtCursor(input, "hi");
    expect(input.value).toBe("hi");
    input.value = "a ";
    input.setSelectionRange(2, 2);
    insertTextAtCursor(input, "b");
    expect(input.value).toBe("a b");
  });
  it("never replaces a selection: a fully selected input (tab-focus) gets the text appended", () => {
    const input = el("input");
    input.value = "http://127.0.0.1:8091";
    input.focus();
    input.select();
    insertTextAtCursor(input, "hello");
    expect(input.value).toBe("http://127.0.0.1:8091 hello");
    expect(input.selectionStart).toBe(input.value.length);
  });
  it("collapses a partial selection to its end instead of deleting it", () => {
    const area = el("textarea");
    area.value = "keep this end";
    area.focus();
    area.setSelectionRange(5, 9); // "this"
    insertTextAtCursor(area, "NEW");
    expect(area.value).toBe("keep this NEW end");
  });
  it("adds a trailing space when inserting in front of a word", () => {
    const area = el("textarea");
    area.value = "hello world";
    area.focus();
    area.setSelectionRange(0, 0);
    insertTextAtCursor(area, "well");
    expect(area.value).toBe("well hello world");
    area.setSelectionRange(5, 5); // between "well " and "hello": before 'h', after ' '
    insertTextAtCursor(area, "then");
    expect(area.value).toBe("well then hello world");
  });
  it("collapses a contenteditable selection to its end before inserting", () => {
    const box = el("div", { contenteditable: "true" });
    box.textContent = "alpha beta";
    box.focus();
    const range = document.createRange();
    range.setStart(box.firstChild!, 0);
    range.setEnd(box.firstChild!, 5); // "alpha"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    insertTextAtCursor(box, "gamma");
    expect(box.textContent).toBe("alpha gamma beta");
  });
  it("prefers document.execCommand when the browser supports it", () => {
    const area = el("textarea");
    area.value = "x";
    area.focus();
    area.setSelectionRange(1, 1);
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    insertTextAtCursor(area, "y");
    expect(exec).toHaveBeenCalledWith("insertText", false, " y");
    expect(area.value).toBe("x"); // execCommand owns the mutation in a real browser
    delete (document as Partial<Document & { execCommand: unknown }>).execCommand;
  });
  it("inserts a text node into contenteditable and fires input", () => {
    const box = el("div", { contenteditable: "true" });
    box.textContent = "hello";
    box.focus();
    const range = document.createRange();
    range.setStart(box.firstChild!, 5);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const onInput = vi.fn();
    box.addEventListener("input", onInput);
    insertTextAtCursor(box, "world");
    expect(box.textContent).toBe("hello world");
    expect(onInput).toHaveBeenCalledTimes(1);
  });
});

describe("mountVoiceDock", () => {
  let controller: AbortController;
  let recorder: Recorder;
  let now: number;
  beforeEach(() => {
    controller = new AbortController();
    recorder = fakeRecorder();
    now = 0;
  });
  function mount(overrides: Partial<Parameters<typeof mountVoiceDock>[0]> = {}) {
    dispose = mountVoiceDock({
      signal: controller.signal,
      createRecorder: async () => recorder,
      minDurationMs: 300,
      errorDisplayMs: 50,
      now: () => now,
      ...overrides,
    });
    return dispose;
  }

  it("creates one hidden dock and shows it when a target gets focus", () => {
    mount();
    expect(document.querySelectorAll(`[${DOCK_ATTR}]`)).toHaveLength(1);
    expect(dock()!.hidden).toBe(true);
    const area = el("textarea");
    focus(area);
    expect(dock()!.hidden).toBe(false);
    expect(dock()!.dataset.state).toBe("idle");
  });

  it("ignores non-targets and bb's composer", () => {
    mount();
    const composer = el("div", { "data-app-composer": "" });
    focus(el("div", { contenteditable: "true" }, composer));
    expect(dock()!.hidden).toBe(true);
    focus(el("input", { type: "password" }));
    expect(dock()!.hidden).toBe(true);
  });

  it("hides on blur unless focus moves to the dock", () => {
    mount();
    const area = el("textarea");
    focus(area);
    blur(area, dock());
    expect(dock()!.hidden).toBe(false);
    blur(area, null);
    expect(dock()!.hidden).toBe(true);
  });

  it("records on click, transcribes on second click, and inserts into the target", async () => {
    mount();
    const area = el("textarea");
    area.value = "note:";
    focus(area);
    area.setSelectionRange(5, 5);
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    now = 1000;
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("idle"));
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(area.value).toBe("note: spoken text");
  });

  it("toggles with Ctrl+Shift+Space while a target is focused", async () => {
    mount();
    const area = el("textarea");
    focus(area);
    const key = () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", ctrlKey: true, shiftKey: true, bubbles: true }));
    key();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    now = 1000;
    key();
    await vi.waitFor(() => expect(area.value).toBe("spoken text"));
  });

  it("discards clips shorter than minDurationMs without transcribing", async () => {
    mount();
    focus(el("textarea"));
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    now = 100;
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("idle"));
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the dock visible while recording even if the target blurs, and still inserts", async () => {
    mount();
    const area = el("textarea");
    focus(area);
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    blur(area, null);
    expect(dock()!.hidden).toBe(false);
    now = 1000;
    dock()!.click();
    await vi.waitFor(() => expect(area.value).toBe("spoken text"));
  });

  it("shows the transcription error on the dock, then returns to idle", async () => {
    (recorder.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Voice transcription is temporarily unavailable"));
    mount();
    focus(el("textarea"));
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    now = 1000;
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("error"));
    expect(dock()!.title).toContain("temporarily unavailable");
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("idle"));
  });

  it("turns into a retry button when the failure kept the clip, and inserts the retried text", async () => {
    const failure = Object.assign(new Error("router down"), { name: "TranscriptionFailed", clipId: 42 });
    (recorder.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure);
    const retry = vi.fn(async (clipId: number) => `retried ${clipId}`);
    mount({ retry, describeFailure: (e) => `${(e as Error).message} — click to retry` });
    const area = el("textarea");
    focus(area);
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    now = 1000;
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("error"));
    expect(dock()!.title).toBe("router down — click to retry");
    expect(dock()!.classList.contains("bbw-dock-retry")).toBe(true);
    expect(dock()!.disabled).toBe(false);
    dock()!.click();
    await vi.waitFor(() => expect(area.value).toBe("retried 42"));
    expect(retry).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    expect(dock()!.dataset.state).toBe("idle");
    expect(dock()!.classList.contains("bbw-dock-retry")).toBe(false);
  });

  it("the hotkey also retries, and a second failure keeps the retry offer", async () => {
    const failure = Object.assign(new Error("router down"), { name: "TranscriptionFailed", clipId: 7 });
    (recorder.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure);
    const retry = vi.fn(async () => { throw new Error("still down"); });
    mount({ retry });
    const area = el("textarea");
    focus(area);
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    now = 1000;
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("error"));
    area.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(dock()!.title).toBe("still down"));
    expect(dock()!.classList.contains("bbw-dock-retry")).toBe(true);
  });

  it("does not offer a retry without a retry dep or a clip id", async () => {
    (recorder.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("lost"), { clipId: null }));
    mount({ retry: vi.fn() });
    focus(el("textarea"));
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    now = 1000;
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("error"));
    expect(dock()!.classList.contains("bbw-dock-retry")).toBe(false);
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("idle"));
  });

  it("shows a microphone error when the recorder cannot start", async () => {
    mount({ createRecorder: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
    focus(el("textarea"));
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("error"));
    expect(dock()!.title).toBe("Microphone permission denied");
  });

  it("does not steal focus from the target on mousedown", () => {
    mount();
    const area = el("textarea");
    focus(area);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    dock()!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("dispose removes the dock, cancels a live recording, and stops listening", async () => {
    const teardown = mount();
    focus(el("textarea"));
    dock()!.click();
    await vi.waitFor(() => expect(dock()!.dataset.state).toBe("recording"));
    teardown();
    expect(dock()).toBeNull();
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    focus(el("textarea"));
    expect(dock()).toBeNull();
    dispose = null;
  });

  it("aborting the signal disposes too, and dispose is idempotent", () => {
    const teardown = mount();
    controller.abort();
    expect(dock()).toBeNull();
    teardown();
    teardown();
    dispose = null;
  });
});
