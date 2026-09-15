import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { AdminOverviewDto, BoardPageDto, LeaderboardStatusDto, leaderboardRpcContract } from "../rpc";
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
  const [admin, setAdmin] = useState<AdminOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteLabel, setInviteLabel] = useState("");
  const [inviteUses, setInviteUses] = useState(5);
  const [lastCode, setLastCode] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    rpc.call("leaderboard_status", null).then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [rpc]);
  const refreshAdmin = useCallback(() => {
    rpc.call("leaderboard_admin_overview", null).then(setAdmin, () => setAdmin(null));
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
    refreshAdmin();
  }, [refreshStatus, refreshAdmin]);
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
  const createInvite = async () => {
    if (inviteLabel.trim() === "") return;
    setBusy(true);
    try {
      const { code } = await rpc.call("leaderboard_admin_invite_create", { label: inviteLabel.trim(), maxUses: inviteUses });
      setLastCode(code);
      setInviteLabel("");
      refreshAdmin();
    } finally {
      setBusy(false);
    }
  };
  const revokeInvite = async (code: string) => {
    await rpc.call("leaderboard_admin_invite_revoke", { code });
    refreshAdmin();
  };
  const removeMember = async (memberId: string, name: string) => {
    if (!confirm(`Remove ${name} from the leaderboard?`)) return;
    await rpc.call("leaderboard_admin_member_remove", { memberId });
    refreshAdmin();
    refreshBoard();
  };
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

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
                <span className="bbv-muted">The board is invite-only. In the plugin settings turn on the leaderboard, set a display name and enter your invite code, then join here.</span>
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
      {admin?.hosting ? (
        <section className="bbv-admin" aria-labelledby="bbv-admin-title">
          <h3 className="bbv-h" id="bbv-admin-title">
            You host this board <span className="bbv-muted">{admin.counts.members} of {admin.maxMembers} members</span>
          </h3>
          <div className="bbv-admin-counts">
            <div><strong>{admin.counts.join}</strong><span>joins this week</span></div>
            <div><strong>{admin.counts.report}</strong><span>reports this week</span></div>
            <div><strong>{admin.counts.leave}</strong><span>leaves this week</span></div>
            <div><strong>{admin.counts.rejected}</strong><span>rejected joins</span></div>
          </div>
          <div className="bbv-admin-grid">
            <section className="bbv-card">
              <h4 className="bbv-sub">Invites</h4>
              <form className="bbv-invite-form" onSubmit={(e) => { e.preventDefault(); void createInvite(); }}>
                <input className="bbv-input" placeholder="Who is this for? (label)" value={inviteLabel} onChange={(e) => setInviteLabel(e.target.value)} />
                <input className="bbv-input bbv-input-n" type="number" min={1} max={1000} value={inviteUses} onChange={(e) => setInviteUses(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} aria-label="Uses" />
                <button type="submit" className="bbv-btn" disabled={busy || inviteLabel.trim() === ""}>Create invite</button>
              </form>
              {lastCode ? <p className="bbv-code-line">New code: <code className="bbv-code">{lastCode}</code> — share it; the member enters it as their invite code in the plugin settings.</p> : null}
              {admin.invites.length === 0 ? <p className="bbv-muted bbv-small">No invites yet.</p> : (
                <table className="bbv-table bbv-table-tight">
                  <thead><tr><th>Code</th><th>Label</th><th>Used</th><th>State</th><th></th></tr></thead>
                  <tbody>
                    {admin.invites.map((i) => (
                      <tr key={i.code}>
                        <td><code className="bbv-code">{i.code}</code></td>
                        <td>{i.label}</td>
                        <td>{i.uses}/{i.maxUses}</td>
                        <td className="bbv-muted">{i.revokedAt !== null ? "revoked" : i.uses >= i.maxUses ? "used up" : "open"}</td>
                        <td className="bbv-right">{i.revokedAt === null ? <button type="button" className="bbv-link" onClick={() => void revokeInvite(i.code)}>Revoke</button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="bbv-card">
              <h4 className="bbv-sub">Members</h4>
              {admin.members.length === 0 ? <p className="bbv-muted bbv-small">Nobody has joined yet.</p> : (
                <table className="bbv-table bbv-table-tight">
                  <thead><tr><th>Member</th><th>Words</th><th>Days</th><th>Last seen</th><th></th></tr></thead>
                  <tbody>
                    {admin.members.map((m) => (
                      <tr key={m.memberId}>
                        <td>{m.displayName}<span className="bbv-muted bbv-small"> · {m.inviteCode ?? "founder"}</span></td>
                        <td>{fmtInt(m.words)}</td>
                        <td>{m.days}</td>
                        <td className="bbv-muted">{when(m.lastSeen)}</td>
                        <td className="bbv-right"><button type="button" className="bbv-link" onClick={() => void removeMember(m.memberId, m.displayName)}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
          <section className="bbv-card">
            <h4 className="bbv-sub">Recent activity</h4>
            {admin.events.length === 0 ? <p className="bbv-muted bbv-small">Nothing yet.</p> : (
              <ul className="bbv-events">
                {admin.events.slice(0, 20).map((e, i) => (
                  <li key={i}><span className="bbv-muted">{when(e.at)}</span> <span className={`bbv-ev bbv-ev-${e.kind}`}>{e.kind}</span> {e.memberId ? <code className="bbv-code">{e.memberId}</code> : null} {e.detail}</li>
                ))}
              </ul>
            )}
          </section>
        </section>
      ) : null}
    </div>
  );
}
