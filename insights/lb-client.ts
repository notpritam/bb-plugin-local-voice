// The client half: every install (including the public host itself) talks to the leaderboard over HTTP.
import type { RankedMember, ReportDay } from "./leaderboard.js";

/** Indirection so tests can stub the network. */
export const lbFetch: typeof fetch = (...args) => fetch(...args);

export interface BoardPage {
  period: "week" | "all";
  total: number;
  offset: number;
  members: RankedMember[];
  me: RankedMember | null;
}

async function call<T>(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const json = (await response.json().catch(() => null)) as { code?: string; message?: string } | T | null;
  if (!response.ok) {
    const message = json !== null && typeof json === "object" && "message" in json && typeof json.message === "string" ? json.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (json === null) throw new Error("empty response");
  return json as T;
}

export function joinRemote(base: string, body: { displayName: string; invite: string }, fetchImpl: typeof fetch = lbFetch): Promise<{ memberId: string; token: string }> {
  return call(fetchImpl, `${base}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function reportRemote(base: string, auth: { memberId: string; token: string; displayName?: string }, days: ReportDay[], fetchImpl: typeof fetch = lbFetch): Promise<{ ok: true }> {
  return call(fetchImpl, `${base}/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...auth, days }) });
}

export function boardRemote(base: string, q: { period: "week" | "all"; offset: number; limit: number; me: string | null }, fetchImpl: typeof fetch = lbFetch): Promise<BoardPage> {
  const params = new URLSearchParams({ period: q.period, offset: String(q.offset), limit: String(q.limit) });
  if (q.me !== null) params.set("me", q.me);
  return call(fetchImpl, `${base}/board?${params.toString()}`, { method: "GET" });
}

export function leaveRemote(base: string, auth: { memberId: string; token: string }, fetchImpl: typeof fetch = lbFetch): Promise<{ ok: true }> {
  return call(fetchImpl, `${base}/leave`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(auth) });
}
