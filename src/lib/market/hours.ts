/** US equity regular session, 9:30-16:00 America/New_York, weekdays. Holidays are not modeled yet. */
export function nyParts(now: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  return { weekday: parts.weekday as string, minutes: hour * 60 + Number(parts.minute) };
}

export function isMarketOpen(now: Date): boolean {
  const { weekday, minutes } = nyParts(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function nyTimeLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(d) + " ET";
}

/**
 * The trading session a set of quotes describes: the New York date of the latest quote, with that day's close
 * (16:00 ET). A move "today" runs from the previous close to this session's close (or the quote time while open).
 */
export function sessionOfQuotes(asOfs: (string | null | undefined)[], now: Date): { date: string; closeIso: string; open: boolean; label: string } | null {
  const ts = asOfs.filter((x): x is string => !!x).map((x) => Date.parse(x)).filter(Number.isFinite);
  if (!ts.length) return null;
  const last = new Date(Math.max(...ts));
  const date = last.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const close = nyClose(date);
  const open = isMarketOpen(now) && now.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === date;
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return { date, closeIso: close.toISOString(), open, label: open ? `${day} session, in progress (delayed quotes)` : `${day} session, at the close` };
}

/** 16:00 New York time on a date, as a Date (handles daylight saving). */
export function nyClose(date: string): Date {
  for (const off of [4, 5]) {
    const d = new Date(`${date}T${String(16 + off).padStart(2, "0")}:00:00Z`);
    if (nyParts(d).minutes === 16 * 60) return d;
  }
  return new Date(`${date}T21:00:00Z`);
}

/** Whether a headline came before, during or after a price move that ended at `endIso` and began at `startIso`. */
export function headlineTiming(publishedAt: string | null | undefined, startIso: string, endIso: string): "before" | "during" | "after" | "unknown" {
  const t = publishedAt ? Date.parse(publishedAt) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  if (t > Date.parse(endIso)) return "after";
  if (t >= Date.parse(startIso)) return "during";
  return "before";
}
