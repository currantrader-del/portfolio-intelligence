export function usd(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? "−" : ""}$${s}`;
}

export function pctStr(n: number | null | undefined, digits = 1, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const v = Math.abs(n * 100).toFixed(digits);
  if (!signed) return `${n < 0 ? "−" : ""}${v}%`;
  return `${n >= 0 ? "+" : "−"}${v}%`;
}

export function toneOf(n: number | null | undefined): string {
  if (n === null || n === undefined || Math.abs(n) < 0.0005) return "text-ink";
  return n > 0 ? "text-gain" : "text-loss";
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}
