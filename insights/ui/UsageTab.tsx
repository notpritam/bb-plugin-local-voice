import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { UsageReportDto, insightsRpcContract } from "../rpc";
import { fmtDuration, fmtInt, fmtPct } from "./fmt";
import { BarRow, Gauge, Heatmap, StatCard } from "./parts";

/** One label per month boundary across the heatmap's columns. */
function heatmapMonths(days: { day: string }[]): string[] {
  const labels: string[] = [];
  let last = "";
  for (let week = 0; week * 7 < days.length; week += 1) {
    const month = days[week * 7]!.day.slice(0, 7);
    labels.push(month === last ? "" : new Date(`${days[week * 7]!.day}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" }));
    last = month;
  }
  return labels;
}

export function UsageTab() {
  const rpc = useRpc<typeof insightsRpcContract>();
  const [report, setReport] = useState<UsageReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    rpc.call("insights_usage", null).then(
      (r) => {
        setReport(r);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRealtime("voice-clip", refresh);

  if (error) return <p className="bbv-error">{error}</p>;
  if (!report) return <p className="bbv-muted">Loading…</p>;
  const { totals, month, wpm, fixes, surfaces, categories, languages, streak, heatmap, peak } = report;
  const composerShare = surfaces.find((s) => s.key === "composer")?.share ?? 0;
  if (totals.clips === 0) {
    return (
      <div className="bbv-empty">
        <strong>Nothing dictated yet</strong>
        Click the mic in the composer, or focus any text field and press <span className="bbv-kbd">Ctrl</span> <span className="bbv-kbd">Shift</span> <span className="bbv-kbd">Space</span>. Your first clip shows up here.
      </div>
    );
  }
  const monthLabels = heatmapMonths(heatmap.days);

  return (
    <div className="bbv-grid">
      <StatCard value={wpm.value === null ? "—" : String(wpm.value)} label="Words per minute">
        <Gauge fraction={wpm.value === null ? 0 : Math.min(1, wpm.value / 200)} caption="Top" value={wpm.topPercent === null ? "—" : `Top ${wpm.topPercent}%`} />
      </StatCard>
      <StatCard value={fmtInt(fixes.edits)} label="Fixes made while polishing">
        <div className="bbv-lines">
          <div>{fmtInt(fixes.fillers)} filler words removed</div>
          <div>{fmtInt(fixes.translated)} clips translated</div>
        </div>
      </StatCard>
      <StatCard value={fmtInt(totals.words)} label="Total words dictated" badge={month.deltaPct === null ? undefined : `${fmtPct(month.deltaPct)} this month`}>
        <div className="bbv-lines">
          <div>{totals.books >= 1 ? `You've written ${totals.books} books!` : `${fmtInt(totals.clips)} clips · ${fmtDuration(totals.durationMs)} of speech`}</div>
          <div className="bbv-split">
            <div className="bbv-split-a" style={{ width: `${composerShare}%` }}>Composer</div>
            <div className="bbv-split-b">Fields & CLI</div>
          </div>
        </div>
      </StatCard>
      <section className="bbv-card bbv-span2">
        <h3 className="bbv-h">
          What you dictate <span className="bbv-muted">{fmtInt(totals.clips)} clips</span>
        </h3>
        {categories.map((c) => (
          <BarRow key={c.key} label={c.label} share={c.share} detail={fmtInt(c.clips)} />
        ))}
        <h4 className="bbv-sub">Where</h4>
        {surfaces.filter((s) => s.clips > 0).map((s) => (
          <BarRow key={s.key} label={s.label} share={s.share} detail={fmtInt(s.clips)} />
        ))}
        <h4 className="bbv-sub">Languages</h4>
        {languages.map((l) => (
          <BarRow key={l.language} label={l.language} share={l.share} detail={fmtInt(l.clips)} />
        ))}
      </section>
      <section className="bbv-card bbv-span2">
        <h3 className="bbv-h">
          {streak.current} day streak <span className="bbv-muted">Longest streak · {streak.longest} days</span>
        </h3>
        <Heatmap days={heatmap.days} weeks={heatmap.weeks} />
        <div className="bbv-heatmap-months">{monthLabels.map((m, i) => <span key={i}>{m}</span>)}</div>
        <div className="bbv-muted bbv-small">{peak ? `You dictate most on ${peak.label}.` : "No peak time yet."}</div>
      </section>
    </div>
  );
}
