import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ClipRowDto, recordingRpcContract } from "../rpc";
import { fmtInt } from "./fmt";

const PAGE = 50;

type HistoryRpc = typeof recordingRpcContract;

/** "Today", "Yesterday", or a date, from a clip's local day. */
export function dayLabel(day: string, today: string = new Date().toISOString().slice(0, 10)): string {
  if (day === today) return "Today";
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (day === yesterday.toISOString().slice(0, 10)) return "Yesterday";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

export function groupByDay(clips: ClipRowDto[]): { day: string; clips: ClipRowDto[] }[] {
  const groups: { day: string; clips: ClipRowDto[] }[] = [];
  for (const clip of clips) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.day === clip.day) last.clips.push(clip);
    else groups.push({ day: clip.day, clips: [clip] });
  }
  return groups;
}

/** The panel runs on bb's own origin, so the plugin route resolves relatively. */
export const PLUGIN_ID = "local-voice";
export function audioUrl(id: number, pluginId: string = PLUGIN_ID): string {
  return `/api/v1/plugins/${pluginId}/http/clip-audio?id=${id}`;
}

export function HistoryTab() {
  const rpc = useRpc<HistoryRpc>();
  const [clips, setClips] = useState<ClipRowDto[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(
    (before: number | null) => {
      rpc.call("history_list", { before, limit: PAGE, query: query.trim() === "" ? null : query.trim() }).then(
        (page) => {
          setClips((current) => (before === null || current === null ? page.clips : [...current, ...page.clips]));
          setHasMore(page.hasMore);
          setError(null);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      );
    },
    [rpc, query],
  );
  useEffect(() => {
    const timer = setTimeout(() => load(null), query === "" ? 0 : 200);
    return () => clearTimeout(timer);
  }, [load, query]);
  useRealtime("voice-history", () => load(null));

  const groups = useMemo(() => groupByDay(clips ?? []), [clips]);

  async function retry(clip: ClipRowDto): Promise<void> {
    const r = await rpc.call("clip_retry", { id: clip.id });
    setNotice(r.ok ? null : r.message);
    if (r.ok) load(null);
  }
  async function remove(clip: ClipRowDto): Promise<void> {
    if (!confirm("Delete this clip and its audio?")) return;
    await rpc.call("clip_delete", { id: clip.id });
    load(null);
  }
  async function copy(clip: ClipRowDto): Promise<void> {
    try {
      await navigator.clipboard.writeText(clip.text || clip.rawText);
      setNotice("Copied.");
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice("Could not copy.");
    }
  }
  function play(clip: ClipRowDto): void {
    const current = audioRef.current;
    if (current !== null && playing === clip.id) {
      current.pause();
      current.src = "";
      audioRef.current = null;
      setPlaying(null);
      return;
    }
    current?.pause();
    const audio = new Audio(audioUrl(clip.id));
    audio.onended = () => setPlaying(null);
    audio.onerror = () => {
      setPlaying(null);
      setNotice("Could not play this clip.");
    };
    audioRef.current = audio;
    setPlaying(clip.id);
    void audio.play().catch(() => setPlaying(null));
  }
  useEffect(() => () => audioRef.current?.pause(), []);

  if (error) return <p className="bbv-error">{error}</p>;
  if (clips === null) return <p className="bbv-muted">Loading…</p>;

  return (
    <div className="bbv-history">
      <div className="bbv-history-toolbar">
        <input className="bbv-input bbv-history-search" type="search" placeholder="Search your dictations" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search history" />
        {notice ? <span className="bbv-muted bbv-history-notice">{notice}</span> : null}
      </div>
      {clips.length === 0 ? (
        <div className="bbv-empty">
          <strong>{query === "" ? "Nothing recorded yet" : "No clips match"}</strong>
          {query === "" ? "Every dictation lands here as it is recorded — the audio too, so a failed transcription can be retried." : "Try a different word."}
        </div>
      ) : null}
      {groups.map((group) => (
        <section key={group.day} className="bbv-history-day">
          <h3 className="bbv-history-daylabel">{dayLabel(group.day)}</h3>
          <ol className="bbv-history-list">
            {group.clips.map((clip) => (
              <li key={clip.id} className={`bbv-history-row bbv-history-${clip.status}`} data-clip-id={clip.id}>
                <time className="bbv-history-time" dateTime={new Date(clip.at).toISOString()}>{timeLabel(clip.at)}</time>
                <div className="bbv-history-body">
                  {clip.status === "done" ? (
                    <p className="bbv-history-text">{clip.text === "" ? <span className="bbv-muted">(silence)</span> : clip.text}</p>
                  ) : clip.status === "failed" ? (
                    <p className="bbv-history-text">
                      <span className="bbv-history-failnote">Transcription failed.</span> <span className="bbv-muted">{clip.error}</span>{" "}
                      {clip.audioBytes > 0 ? (
                        <button type="button" className="bbv-link" onClick={() => void retry(clip)}>
                          Retry
                        </button>
                      ) : (
                        <span className="bbv-muted">(audio no longer kept)</span>
                      )}
                    </p>
                  ) : (
                    <p className="bbv-history-text bbv-muted">
                      <span className="bbv-spinner" aria-hidden="true" /> {clip.status === "recording" ? "Recording…" : "Transcribing…"}
                    </p>
                  )}
                  <p className="bbv-history-meta bbv-muted">
                    {clip.status === "done" && clip.words > 0 ? `${fmtInt(clip.words)} words · ` : ""}
                    {clip.durationMs > 0 ? `${Math.round(clip.durationMs / 1000)} s · ` : ""}
                    {clip.language ?? ""}
                    {clip.translated ? " → English" : ""}
                    {clip.attempts > 1 ? ` · attempt ${clip.attempts}` : ""}
                    {clip.surface === "composer" ? " · composer" : clip.surface === "field" ? " · field" : ""}
                  </p>
                </div>
                <div className="bbv-history-actions">
                  {clip.audioBytes > 0 ? (
                    <button type="button" className="bbv-icon-btn" title={playing === clip.id ? "Stop" : "Play the audio"} aria-label={playing === clip.id ? "Stop" : "Play"} onClick={() => play(clip)}>
                      {playing === clip.id ? "■" : "▶"}
                    </button>
                  ) : null}
                  {clip.status === "done" && clip.text !== "" ? (
                    <button type="button" className="bbv-icon-btn" title="Copy the text" aria-label="Copy" onClick={() => void copy(clip)}>
                      ⧉
                    </button>
                  ) : null}
                  {clip.status === "done" && clip.audioBytes > 0 ? (
                    <button type="button" className="bbv-icon-btn" title="Transcribe again" aria-label="Transcribe again" onClick={() => void retry(clip)}>
                      ↻
                    </button>
                  ) : null}
                  {clip.status !== "recording" ? (
                    <button type="button" className="bbv-icon-btn" title="Delete" aria-label="Delete" onClick={() => void remove(clip)}>
                      ✕
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {hasMore ? (
        <button type="button" className="bbv-link bbv-history-more" onClick={() => load(clips[clips.length - 1]?.at ?? null)}>
          Load more
        </button>
      ) : null}
    </div>
  );
}
