// The "voice everywhere" content script: one floating mic button that docks
// to whichever text input has focus, records (streaming slices to the plugin
// as it goes), and inserts the transcript at the caret.

export const COMPOSER_ROOT_SELECTOR = "[data-app-composer]";
export const DOCK_ATTR = "data-bb-whisper-dock";
export const HOTKEY = { code: "Space", ctrl: true, shift: true } as const;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);
const DOCK_SIZE = 28;
const DOCK_INSET = 6;

export type DockState = "idle" | "recording" | "transcribing" | "error";

export interface Recorder {
  /** Stop, wait for the transcript. Rejects with the reason when it fails (the audio is kept in History). */
  stop(signal: AbortSignal): Promise<string>;
  /** Stop and discard; never rejects. */
  cancel(): void;
}

export interface DockDeps {
  signal: AbortSignal;
  createRecorder: () => Promise<Recorder>;
  doc?: Document;
  minDurationMs?: number;
  errorDisplayMs?: number;
  now?: () => number;
}

function editableValue(node: HTMLElement): boolean {
  const owner = node.closest<HTMLElement>("[contenteditable]");
  if (owner === null) return false;
  const value = owner.getAttribute("contenteditable");
  return value === "" || value === "true" || value === "plaintext-only";
}

export function isVoiceTarget(node: EventTarget | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  if (node.closest(COMPOSER_ROOT_SELECTOR) !== null) return false;
  if (node.closest(`[${DOCK_ATTR}]`) !== null) return false;
  if (node instanceof HTMLTextAreaElement) return !node.disabled && !node.readOnly;
  if (node instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(node.type) && !node.disabled && !node.readOnly;
  }
  return editableValue(node);
}

function isFormField(node: HTMLElement): node is HTMLTextAreaElement | HTMLInputElement {
  return node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement;
}

/** Characters adjacent to the caret, so the insert can pad itself with spaces. */
function caretNeighbours(target: HTMLElement, doc: Document): { before: string | undefined; after: string | undefined } {
  if (isFormField(target)) {
    const caret = target.selectionStart ?? target.value.length;
    return { before: target.value[caret - 1], after: target.value[caret] };
  }
  const selection = doc.getSelection();
  if (selection !== null && selection.rangeCount > 0 && target.contains(selection.anchorNode)) {
    const anchor = selection.anchorNode;
    if (anchor !== null && anchor.nodeType === Node.TEXT_NODE) {
      const text = anchor.textContent ?? "";
      return { before: text[selection.anchorOffset - 1], after: text[selection.anchorOffset] };
    }
    return { before: undefined, after: undefined };
  }
  const text = target.textContent ?? "";
  return { before: text[text.length - 1], after: undefined };
}

const isWord = (ch: string | undefined): boolean => ch !== undefined && !/\s/.test(ch);

/**
 * Dictation appends; it never types over a selection. Tab-focusing an input
 * selects its whole value, so an insert-at-selection would wipe the field.
 * Collapse any selection to its end first.
 */
function collapseSelectionToEnd(target: HTMLElement, doc: Document): void {
  if (isFormField(target)) {
    const end = target.selectionEnd ?? target.value.length;
    target.setSelectionRange(end, end);
    return;
  }
  const selection = doc.getSelection();
  if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed && target.contains(selection.anchorNode)) {
    selection.collapseToEnd();
  }
}

/** Set a form field's value through the prototype setter so React's tracker sees it. */
function setNativeValue(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
  if (descriptor?.set) descriptor.set.call(field, value);
  else field.value = value;
}

export function insertTextAtCursor(target: HTMLElement, text: string): void {
  const doc = target.ownerDocument;
  target.focus();
  collapseSelectionToEnd(target, doc);
  const { before, after } = caretNeighbours(target, doc);
  const spaced = `${isWord(before) ? " " : ""}${text}${isWord(after) ? " " : ""}`;
  const exec = (doc as Document & { execCommand?: (command: string, ui: boolean, value: string) => boolean })
    .execCommand;
  if (typeof exec === "function" && exec.call(doc, "insertText", false, spaced)) return;

  if (isFormField(target)) {
    const start = target.selectionStart ?? target.value.length;
    setNativeValue(target, target.value.slice(0, start) + spaced + target.value.slice(start));
    const caret = start + spaced.length;
    target.setSelectionRange(caret, caret);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  const selection = doc.getSelection();
  const node = doc.createTextNode(spaced);
  if (selection !== null && selection.rangeCount > 0 && target.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    target.appendChild(node);
  }
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: spaced }));
}

export function describeMicError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Microphone permission denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone found";
    case "NotReadableError":
    case "TrackStartError":
      return "Microphone is already in use";
    case "AbortError":
      return "Voice capture was aborted";
    default:
      return "Failed to start voice recording";
  }
}

const MIC_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8 21h8"/></svg>';
const STOP_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const SPIN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>';

const LABELS: Record<DockState, string> = {
  idle: "Start voice input (Ctrl+Shift+Space)",
  recording: "Stop and transcribe (Ctrl+Shift+Space)",
  transcribing: "Transcribing…",
  error: "Voice input failed",
};

export function mountVoiceDock(deps: DockDeps): () => void {
  const doc = deps.doc ?? document;
  const win = doc.defaultView ?? window;
  const minDurationMs = deps.minDurationMs ?? 300;
  const errorDisplayMs = deps.errorDisplayMs ?? 4000;
  const now = deps.now ?? (() => Date.now());
  const abort = new AbortController();

  let disposed = false;
  let target: HTMLElement | null = null;
  let state: DockState = "idle";
  let recorder: Recorder | null = null;
  let startedAt = 0;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const dock = doc.createElement("button");
  dock.type = "button";
  dock.className = "bbw-dock";
  dock.setAttribute(DOCK_ATTR, "");
  dock.hidden = true;
  doc.body.appendChild(dock);

  function setState(next: DockState, title = LABELS[next]): void {
    state = next;
    dock.dataset.state = next;
    dock.setAttribute("aria-label", LABELS[next]);
    dock.title = title;
    dock.disabled = next === "transcribing";
    dock.innerHTML = next === "recording" ? STOP_SVG : next === "transcribing" ? SPIN_SVG : MIC_SVG;
  }
  setState("idle");

  function position(): void {
    if (target === null) return;
    const rect = target.getBoundingClientRect();
    const top =
      rect.height < DOCK_SIZE + DOCK_INSET * 2
        ? rect.top + (rect.height - DOCK_SIZE) / 2
        : rect.bottom - DOCK_SIZE - DOCK_INSET;
    const left = rect.right - DOCK_SIZE - DOCK_INSET;
    dock.style.top = `${Math.max(0, top)}px`;
    dock.style.left = `${Math.max(0, left)}px`;
  }

  function show(next: HTMLElement): void {
    if (target === next) return;
    resizeObserver?.disconnect();
    target = next;
    dock.hidden = false;
    position();
    if (typeof win.ResizeObserver === "function") {
      resizeObserver = new win.ResizeObserver(() => position());
      resizeObserver.observe(next);
    }
  }

  function hide(): void {
    if (state !== "idle") return; // keep the dock while a clip is in flight
    resizeObserver?.disconnect();
    resizeObserver = null;
    target = null;
    dock.hidden = true;
  }

  function showError(message: string): void {
    setState("error", message);
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorTimer = null;
      setState("idle");
      if (target === null || !target.isConnected) {
        target = null;
        dock.hidden = true;
      }
    }, errorDisplayMs);
  }

  async function start(): Promise<void> {
    if (target === null || state !== "idle") return;
    try {
      const next = await deps.createRecorder();
      if (disposed) {
        next.cancel();
        return;
      }
      recorder = next;
    } catch (error) {
      showError(describeMicError(error));
      return;
    }
    startedAt = now();
    setState("recording");
  }

  async function stop(): Promise<void> {
    const active = recorder;
    if (active === null || state !== "recording") return;
    recorder = null;
    if (now() - startedAt < minDurationMs) {
      active.cancel();
      finish();
      return;
    }
    setState("transcribing");
    try {
      const text = (await active.stop(abort.signal)).trim();
      if (disposed) return;
      if (text !== "" && target !== null && target.isConnected) insertTextAtCursor(target, text);
      finish();
    } catch (error) {
      if (disposed) return;
      showError(error instanceof Error && error.message !== "" ? error.message : "Voice transcription failed");
    }
  }

  function finish(): void {
    setState("idle");
    if (target === null || !target.isConnected || doc.activeElement !== target) {
      target = null;
      dock.hidden = true;
    }
  }

  function toggle(): void {
    if (state === "idle") void start();
    else if (state === "recording") void stop();
  }

  const onFocusIn = (event: FocusEvent) => {
    if (isVoiceTarget(event.target)) show(event.target);
  };
  const onFocusOut = (event: FocusEvent) => {
    if (event.target !== target) return;
    const next = event.relatedTarget;
    if (next instanceof Node && dock.contains(next)) return;
    hide();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      target === null ||
      event.code !== HOTKEY.code ||
      event.ctrlKey !== HOTKEY.ctrl ||
      event.shiftKey !== HOTKEY.shift ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }
    event.preventDefault();
    toggle();
  };
  const onMouseDown = (event: MouseEvent) => event.preventDefault();
  const onClick = () => toggle();
  const onReflow = () => position();

  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("scroll", onReflow, { capture: true, passive: true });
  win.addEventListener("resize", onReflow);
  dock.addEventListener("mousedown", onMouseDown);
  dock.addEventListener("click", onClick);

  const mutations = new win.MutationObserver(() => {
    if (target !== null && !target.isConnected && state === "idle") {
      target = null;
      dock.hidden = true;
    }
  });
  mutations.observe(doc.body, { childList: true, subtree: true });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    deps.signal.removeEventListener("abort", dispose);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("scroll", onReflow, { capture: true });
    win.removeEventListener("resize", onReflow);
    dock.removeEventListener("mousedown", onMouseDown);
    dock.removeEventListener("click", onClick);
    mutations.disconnect();
    resizeObserver?.disconnect();
    if (errorTimer !== null) clearTimeout(errorTimer);
    recorder?.cancel();
    recorder = null;
    dock.remove();
  };
  if (deps.signal.aborted) dispose();
  else deps.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
