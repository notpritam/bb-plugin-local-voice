export const fmtInt = (n: number): string => new Intl.NumberFormat("en-US").format(Math.round(n));
export const fmtPct = (n: number | null): string => (n === null ? "—" : `${n > 0 ? "+" : ""}${n}%`);
export function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
