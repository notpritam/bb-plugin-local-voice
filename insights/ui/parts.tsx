import type { ReactNode } from "react";

export function StatCard({ value, label, badge, children }: { value: string; label: string; badge?: string; children?: ReactNode }) {
  return (
    <section className="bbv-card">
      <div className="bbv-card-head">
        <div className="bbv-stat">{value}</div>
        {badge ? <span className="bbv-badge">{badge}</span> : null}
      </div>
      <div className="bbv-label">{label}</div>
      {children ? <div className="bbv-card-body">{children}</div> : null}
    </section>
  );
}

/** Half-circle gauge; `fraction` 0..1 fills clockwise from the left. */
export function Gauge({ fraction, caption, value }: { fraction: number; caption: string; value: string }) {
  const r = 44;
  const c = Math.PI * r;
  const filled = Math.max(0, Math.min(1, fraction)) * c;
  return (
    <div className="bbv-gauge">
      <svg viewBox="0 0 120 64" width="160" height="86" aria-hidden="true">
        <path d="M 16 60 A 44 44 0 0 1 104 60" fill="none" stroke="var(--muted, #e5e7eb)" strokeWidth="10" strokeLinecap="round" />
        <path d="M 16 60 A 44 44 0 0 1 104 60" fill="none" stroke="var(--primary, #0f766e)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${filled} ${c}`} />
      </svg>
      <div className="bbv-gauge-text">
        <span className="bbv-muted">{caption}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

export function BarRow({ label, share, detail }: { label: string; share: number; detail: string }) {
  return (
    <div className="bbv-row">
      <div className="bbv-bar" style={{ width: `${Math.max(8, share)}%` }}>{share}%</div>
      <div className="bbv-row-text">
        <span>{detail}</span>
        <span className="bbv-muted"> {label}</span>
      </div>
    </div>
  );
}

export function Heatmap({ days, weeks }: { days: { day: string; words: number; level: number }[]; weeks: number }) {
  const size = 12;
  const gap = 3;
  return (
    <svg className="bbv-heatmap" viewBox={`0 0 ${weeks * (size + gap)} ${7 * (size + gap)}`} width="100%" role="img" aria-label="Daily dictation heatmap">
      {days.map((d, i) => (
        <rect key={d.day} x={Math.floor(i / 7) * (size + gap)} y={(i % 7) * (size + gap)} width={size} height={size} rx="2" className={`bbv-cell bbv-cell-${d.level}`}>
          <title>{`${d.day}: ${d.words} words`}</title>
        </rect>
      ))}
    </svg>
  );
}
