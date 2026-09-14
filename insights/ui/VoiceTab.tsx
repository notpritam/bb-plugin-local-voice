import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { VoiceReportDto, insightsRpcContract } from "../rpc";
import { fmtInt } from "./fmt";

export function VoiceTab() {
  const rpc = useRpc<typeof insightsRpcContract>();
  const [voice, setVoice] = useState<VoiceReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    rpc.call("insights_voice", null).then(
      (v) => {
        setVoice(v);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRealtime("voice-profile", refresh);
  useRealtime("voice-clip", refresh);

  const regenerate = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("insights_regenerate", null);
      if (!result.ok) setError(result.message ?? "Could not generate a profile");
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="bbv-error">{error}</p>;
  if (!voice) return <p className="bbv-muted">Loading…</p>;
  const { profile, wordsTotal, wordsUntilNext, generating } = voice;
  const span = profile === null ? Math.max(1, wordsTotal + wordsUntilNext) : 2000;
  const progress = Math.max(0, Math.min(100, Math.round(((span - wordsUntilNext) / span) * 100)));

  return (
    <div>
      <div className="bbv-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <div className="bbv-progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="bbv-progress-meta">
        <span className="bbv-muted">{profile ? `Updated ${new Date(profile.generatedAt).toLocaleDateString()}` : `${fmtInt(wordsTotal)} words dictated so far`}</span>
        <span className="bbv-muted">
          {generating || busy ? "Writing your profile…" : wordsUntilNext > 0 ? `Next update in ${fmtInt(wordsUntilNext)} more words` : "Update due"}
          {" · "}
          <button type="button" className="bbv-link" onClick={() => void regenerate()} disabled={busy || generating || wordsTotal === 0}>
            Regenerate
          </button>
        </span>
      </div>
      {profile === null ? (
        <section className="bbv-card bbv-hero">
          <h2 className="bbv-serif">Your voice profile is on its way</h2>
          <p className="bbv-muted">Dictate about {fmtInt(wordsUntilNext)} more words and Local Voice will write it — locally, from what you actually say.</p>
        </section>
      ) : (
        <>
          <section className="bbv-card bbv-hero">
            <h2 className="bbv-serif">{profile.title}</h2>
            <div className="bbv-label">Voice profile</div>
            <p className="bbv-hero-text">{profile.description}</p>
          </section>
          <div className="bbv-grid bbv-grid-2">
            <div className="bbv-stack">
              <section className="bbv-card">
                <div className="bbv-serif bbv-quote">“{profile.catchphrase}”</div>
                <div className="bbv-label">Catchphrase</div>
              </section>
              <section className="bbv-card">
                <div className="bbv-serif bbv-quote">“{profile.mostUsedWord ?? "—"}”</div>
                <div className="bbv-label">Most used word</div>
              </section>
              <section className="bbv-card">
                <div className="bbv-serif bbv-quote">“{profile.mostCorrectedWord ?? "—"}”</div>
                <div className="bbv-label">Most corrected word</div>
              </section>
            </div>
            <section className="bbv-card">
              <h2 className="bbv-serif">{profile.peakTitle}</h2>
              <div className="bbv-label">Your peak time</div>
              <p className="bbv-hero-text">{profile.peakDescription}</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
