/**
 * Research price bands drawn as one bar, with today's price as a marker.
 * Bands are prompts to research, never automatic trades; the caller labels them that way.
 */
export type ZoneView = { low: number; high: number | null; label: string; action: string };

const kind = (action: string) => (/add|buy|accumulate/i.test(action) ? "add" : /trim|sell|reduce/i.test(action) ? "trim" : "hold");
const FILL = { add: "#24332b", hold: "#2a2c31", trim: "#3a2a24" };
const money = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 0 : 2)}`;

export function ZoneBar({ zones, price }: { zones: ZoneView[]; price: number | null }) {
  const z = [...zones].sort((a, b) => a.low - b.low);
  if (!z.length) return null;
  // Equal-width segments; the marker sits proportionally inside the band that holds the price.
  let marker: number | null = null;
  if (price !== null) {
    const i = z.findIndex((x) => price >= x.low && (x.high === null || price < x.high));
    if (i >= 0) {
      const b = z[i];
      const lo = b.low > 0 ? b.low : (b.high ?? price) * 0.6;
      const hi = b.high ?? Math.max(b.low * 1.4, price * 1.05);
      const within = Math.max(0.04, Math.min(0.96, (price - lo) / (hi - lo || 1)));
      marker = ((i + within) / z.length) * 100;
    } else marker = price < z[0].low ? 2 : 98;
  }
  const first = z[0];
  const last = z[z.length - 1];
  const left = kind(first.action) === "add" && first.high ? `Add research below ${money(first.high)}` : first.label;
  const right = kind(last.action) === "trim" && last.low ? `Trim review above ${money(last.low)}` : last.label;
  const label = `Research price bands: ${z.map((x) => `${x.label} ${x.action}`).join("; ")}${price !== null ? `. Today ${money(price)}` : ""}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-2 flex gap-0.5" role="img" aria-label={label}>
        {z.map((x, i) => (
          <span key={i} className={`flex-1 h-2 ${i === 0 ? "rounded-l-full" : ""} ${i === z.length - 1 ? "rounded-r-full" : ""}`} style={{ background: FILL[kind(x.action)] }} />
        ))}
        {marker !== null && <span className="absolute -top-[3px] -bottom-[3px] w-[3px] rounded-sm bg-ink" style={{ left: `calc(${marker}% - 1.5px)` }} />}
      </div>
      <div className="flex justify-between gap-2 t-xs">
        <span>{left}</span>
        {price !== null && <span className="num text-ink">{money(price)} today</span>}
        <span className="text-right">{right}</span>
      </div>
    </div>
  );
}

export function toZoneViews(zones: { low: number; high: number; label: string; action: string }[]): ZoneView[] {
  return zones.map((z) => ({ low: z.low, high: Number.isFinite(z.high) ? z.high : null, label: z.label, action: z.action }));
}
