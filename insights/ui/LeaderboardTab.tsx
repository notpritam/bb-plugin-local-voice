import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { BoardPageDto, LeaderboardStatusDto, leaderboardRpcContract } from "../rpc";
import { fmtInt } from "./fmt";

const PAGE = 20;
const MEDALS = ["🥇", "🥈", "🥉"];

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function LeaderboardTab() {
  const rpc = useRpc<typeof leaderboardRpcContract>();
  const [status, setStatus] = useState<LeaderboardStatusDto | null>(null);
  const [period, setPeriod] = useState<"week" | "all">("week");
  const [offset, setOffset] = useState(0);
  const [board, setBoard] = useState<BoardPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(() => {
    rpc.call("leaderboard_status", null).then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [rpc]);
  const refreshBoard = useCallback(() => {
    rpc.call("leaderboard_board", { period, offset }).then(
      (b) => {
        setBoard(b);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc, period, offset]);
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    refreshBoard();
  }, [refreshBoard]);

  const join = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("leaderboard_join", null);
      if (!result.ok) setError(result.message ?? "Could not join");
      refreshStatus();
      refreshBoard();
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    if (!confirm("Leave the leaderboard? Your scores are removed from the public host.")) return;
    setBusy(true);
    try {
      await rpc.call("leaderboard_leave", null);
      refreshStatus();
      refreshBoard();
    } finally {
      setBusy(false);
    }
  };
  const jumpToMe = () => {
    if (board?.me) setOffset(Math.floor((board.me.rank - 1) / PAGE) * PAGE);
  };

  const top3 = board?.offset === 0 ? board.members.slice(0, 3) : [];
  const podiumOrder = [top3[1], top3[0], top3[2]];

  return (
    <div>
      {status ? (
        <div className="bbv-lb-status">
          {status.joined ? (
            <span>
              You're on the board as <strong>{status.displayName || status.memberId}</strong>
              {status.lastReportAt ? <span className="bbv-muted"> · last report {new Date(status.lastReportAt).toLocaleTimeString()}</span> : null}
              {status.lastError ? <span className="bbv-error"> · {status.lastError}</span> : null}
              {" · "}
              <button type="button" className="bbv-link" onClick={() => void leave()} disabled={busy}>Leave</button>
            </span>
          ) : (
            <span>
              {status.enabled && status.displayName ? (
                <button type="button" className="bbv-btn" onClick={() => void join()} disabled={busy}>Join as {status.displayName}</button>
              ) : (
                <span className="bbv-muted">Turn on the leaderboard and set a display name in the plugin settings, then join.</span>
              )}
            </span>
          )}
        </div>
      ) : null}
      <div className="bbv-lb-toolbar">
        <div className="bbv-seg">
          <button type="button" className={period === "week" ? "bbv-seg-on" : ""} onClick={() => { setPeriod("week"); setOffset(0); }}>This week</button>
          <button type="button" className={period === "all" ? "bbv-seg-on" : ""} onClick={() => { setPeriod("all"); setOffset(0); }}>All time</button>
        </div>
        <div className="bbv-pager">
          {board?.me ? <button type="button" className="bbv-link" onClick={jumpToMe}>Jump to me</button> : null}
          <span className="bbv-muted">{board ? `${board.total === 0 ? 0 : board.offset + 1}-${Math.min(board.total, board.offset + PAGE)} of ${board.total}` : ""}</span>
          <button type="button" className="bbv-link" disabled={!board || board.offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹</button>
          <button type="button" className="bbv-link" disabled={!board || board.offset + PAGE >= board.total} onClick={() => setOffset(offset + PAGE)}>›</button>
        </div>
      </div>
      {error ? <p className="bbv-error">{error}</p> : null}
      {!board ? <p className="bbv-muted">Loading…</p> : board.total === 0 ? <p className="bbv-muted">Nobody on the board yet. Be the first.</p> : (
        <>
          {top3.length > 0 ? (
            <div className="bbv-podium">
              {podiumOrder.map((m, i) => m ? (
                <div key={m.memberId} className={`bbv-podium-card bbv-podium-${m.rank}`}>
                  <div className="bbv-podium-medal">{MEDALS[m.rank - 1]}</div>
                  <div className="bbv-podium-name">{m.displayName}</div>
                  <div className="bbv-podium-words">{fmtInt(m.words)}</div>
                  <div className="bbv-label">Total words</div>
                </div>
              ) : <div key={`empty-${i}`} />)}
            </div>
          ) : null}
          <table className="bbv-table">
            <thead><tr><th>Rank</th><th>Member</th><th className="bbv-right">Total words</th></tr></thead>
            <tbody>
              {board.members.map((m) => (
                <tr key={m.memberId} className={board.me?.memberId === m.memberId ? "bbv-me" : ""}>
                  <td>
                    <span className="bbv-rank">{m.rank <= 3 ? MEDALS[m.rank - 1] : m.rank}</span>
                    {m.delta !== null && m.delta !== 0 ? <span className={m.delta > 0 ? "bbv-up" : "bbv-down"}>{m.delta > 0 ? "↑" : "↓"}{Math.abs(m.delta)}</span> : null}
                  </td>
                  <td><span className="bbv-avatar">{initials(m.displayName)}</span>{m.displayName}{board.me?.memberId === m.memberId ? " (you)" : ""}</td>
                  <td className="bbv-right">{fmtInt(m.words)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
