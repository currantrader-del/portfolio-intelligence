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
