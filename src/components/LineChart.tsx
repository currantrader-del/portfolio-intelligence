/**
 * A small server-rendered SVG line chart. No client JS. Series share one y-axis.
 * Colours come from theme tokens so it works in light and dark mode.
 */
export type ChartSeries = { label: string; points: { date: string; value: number }[]; color: "accent" | "muted" | "gain" | "loss"; dashed?: boolean };

const COLOR = { accent: "var(--accent)", muted: "var(--muted)", gain: "var(--gain)", loss: "var(--loss)" };

function ticks(min: number, max: number, n = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

export function LineChart({ series, height = 220, format, label }: { series: ChartSeries[]; height?: number; format: (v: number) => string; label: string }) {
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return <p className="text-sm text-muted">Not enough data to draw a chart yet.</p>;
  const dates = [...new Set(all.map((p) => p.date))].sort();
  const W = 640, H = height, L = 2, R = 2, T = 8, B = 4;
  let min = Math.min(...all.map((p) => p.value)), max = Math.max(...all.map((p) => p.value));
  const pad = (max - min) * 0.06 || Math.abs(max) * 0.02 || 1;
  min -= pad; max += pad;
  const x = (d: string) => L + (dates.indexOf(d) / Math.max(1, dates.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const yt = ticks(min, max);
  const xLabels = [dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]];
  const fmtDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" });
  const last = series.map((s) => ({ s, p: s.points[s.points.length - 1] })).filter((x) => x.p);

  return (
    <figure className="flex flex-col gap-2">
      <div className="relative pl-12">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label={`${label}. ${last.map(({ s, p }) => `${s.label} ${format(p.value)} on ${fmtDate(p.date)}`).join("; ")}`}>
          {yt.map((v) => <line key={v} x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
          {series.map((s) => (
            <polyline key={s.label} fill="none" stroke={COLOR[s.color]} strokeWidth={s.dashed ? 1.5 : 2} strokeDasharray={s.dashed ? "4 3" : undefined} vectorEffect="non-scaling-stroke" strokeLinejoin="round"
              points={s.points.map((p) => `${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ")} />
          ))}
        </svg>
        <div className="absolute top-0 left-0 w-12 pointer-events-none" style={{ height }} aria-hidden="true">
          {yt.map((v) => <span key={v} className="absolute right-0 w-12 pr-1.5 text-right text-[10px] font-mono text-muted -translate-y-1/2 whitespace-nowrap" style={{ top: `${(y(v) / H) * 100}%` }}>{format(v)}</span>)}
        </div>
        <div className="flex justify-between text-[10px] font-mono text-muted mt-0.5" aria-hidden="true">{xLabels.map((d, i) => <span key={i}>{fmtDate(d)}</span>)}</div>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {last.map(({ s, p }) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 h-0.5" style={{ background: COLOR[s.color], opacity: s.dashed ? 0.7 : 1 }} />{s.label}<span className="font-mono text-ink ml-1">{format(p.value)}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
