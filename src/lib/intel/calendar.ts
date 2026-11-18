/**
 * Official calendars, read by code from the publishers themselves: BLS release schedules, the
 * Federal Reserve's monthly calendar and FOMC meeting list, and BEA's release schedule. An event
 * found here is "confirmed" with the page URL, the line it came from and the retrieval time.
 * Parsers are pure and tested; when a page cannot be read the failure is reported, never filled in.
 */
import type { CalendarEvent, Source } from "./desks";

export type OfficialFetch = { url: string; ok: boolean; status: number | null; ms: number; error: string | null; events: number };
type Ev = Omit<CalendarEvent, "source" | "check" | "status"> & { line: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = (s: string) => MONTHS.findIndex((m) => m.slice(0, 3).toLowerCase() === s.slice(0, 3).toLowerCase());
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const et = (t: string) => `${t.replace(/^0/, "").replace(/\s*([AP])\.?M\.?/i, (_, x) => ` ${x.toUpperCase()}M`)} ET`;

/** BLS per-release schedule table rows: "October 2026 | Nov. 10, 2026 | 08:30 AM". */
export function parseBlsSchedule(text: string, release: string): Ev[] {
  const re = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/g;
  const out: Ev[] = [];
  for (const m of text.matchAll(re)) {
    const [line, refMonth, refYear, mon, day, year, time] = m;
    out.push({ date: iso(Number(year), MON(mon), Number(day)), time: et(time), event: `${release} (${refMonth} ${refYear})`, type: "economic", expectation: null, why: "", symbols: [], line: line.replace(/\s+/g, " ") });
  }
  return out;
}

/** BEA schedule rows: "November 25 8:30 AM News GDP (Second Estimate) and Corporate Profits, 3rd Quarter 2026". */
export function parseBeaSchedule(text: string, year: number, keep: RegExp): Ev[] {
  // Tolerates responsive-table cell labels ("Date/Time", "Type", "Release") between the cells.
  const M = "January|February|March|April|May|June|July|August|September|October|November|December";
  const re = new RegExp(`\\b(${M})\\s+(\\d{1,2})\\s+(\\d{1,2}:\\d{2}\\s*[AP]M)\\s+(?:[A-Za-z/]+\\s+){0,2}?(?:News|Article)\\s+(?:Release\\s+)?(.+?)(?=\\s+(?:[A-Za-z/]+\\s+){0,2}?(?:${M})\\s+\\d{1,2}\\s+\\d{1,2}:\\d{2}|$)`, "g");
  const out: Ev[] = [];
  for (const m of text.matchAll(re)) {
    const [line, month, day, time, title] = m;
    if (!keep.test(title)) continue;
    out.push({ date: iso(year, MON(month), Number(day)), time: et(time), event: title.replace(/\s+(Date\/Time|Type|Release)$/i, "").trim().slice(0, 140), type: "economic", expectation: null, why: "", symbols: [], line: line.replace(/\s+/g, " ").slice(0, 200) });
  }
  return out;
}

/** The Fed's monthly calendar: "2:00 p.m. FOMC Minutes Meeting of October 27-28 18" (time, title, detail, day). */
export function parseFedMonth(text: string, year: number, month: number): Ev[] {
  const out: Ev[] = [];
  // Minutes only: meeting and decision dates come from the FOMC meeting list.
  const re = /(\d{1,2}:\d{2}\s*[ap]\.m\.)\s+(FOMC Minutes)\s+((?:Meeting of\s+)?[A-Z][a-z]+\s+\d{1,2}(?:-\d{1,2})?)?\s*(\d{1,2})\b/g;
  for (const m of text.matchAll(re)) {
    const [line, time, title, detail, day] = m;
    out.push({ date: iso(year, month, Number(day)), time: et(time), event: `${title}${detail ? ` (${detail.trim()})` : ""}`, type: "fed", expectation: null, why: "", symbols: [], line: line.replace(/\s+/g, " ") });
  }
  return out;
}

/** FOMC meeting list for one year: "October 27-28 ... December 8-9*". The decision is on the last day. */
export function parseFomcMeetings(text: string, year: number): Ev[] {
  const start = text.indexOf(`${year} FOMC Meetings`);
  if (start < 0) return [];
  const end = text.indexOf(`${year - 1} FOMC Meetings`, start + 10);
  const section = text.slice(start, end > start ? end : start + 20000);
  const out: Ev[] = [];
  for (const m of section.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)(?:\/[A-Z][a-z]+)?\s+(\d{1,2})-(\d{1,2})(\*)?/g)) {
    const [line, month, , d2, sep] = m;
    out.push({ date: iso(year, MON(month), Number(d2)), time: "2:00 PM ET", event: `FOMC rate decision (meeting ${month} ${m[2]}-${d2}${sep ? ", with economic projections" : ""})`, type: "fed", expectation: null, why: "", symbols: [], line: line.trim() });
  }
  return out;
}

export const BLS_RELEASES: { path: string; name: string }[] = [
  { path: "cpi", name: "Consumer Price Index" },
  { path: "ppi", name: "Producer Price Index" },
  { path: "empsit", name: "Employment Situation (jobs report)" },
  { path: "jolts", name: "Job Openings and Labor Turnover (JOLTS)" },
];
const BEA_KEEP = /GDP \(|Personal Income and Outlays|International Trade in Goods and Services/;

/** A short sample of the page around the first month name, so a format change can be diagnosed from the log. */
function sample(text: string) {
  const i = text.search(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/);
  return text.slice(Math.max(0, i), Math.max(0, i) + 160).replace(/"/g, "'");
}

/** Every official calendar page, fetched and parsed; events from today up to `days` ahead. */
export async function officialCalendar(now: Date, days = 30, fetchText: (url: string) => Promise<{ ok: boolean; status: number | null; ms: number; text: string; error: string | null }>): Promise<{ events: CalendarEvent[]; log: OfficialFetch[] }> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const until = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
  const y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7)) - 1;
  const next = mo === 11 ? { y: y + 1, m: 0 } : { y, m: mo + 1 };
  const monthName = (m: number) => MONTHS[m].toLowerCase();
  const jobs: { url: string; publisher: string; title: string; parse: (t: string) => Ev[] }[] = [
    ...BLS_RELEASES.map((r) => ({ url: `https://www.bls.gov/schedule/news_release/${r.path}.htm`, publisher: "U.S. Bureau of Labor Statistics", title: `${r.name} release schedule`, parse: (t: string) => parseBlsSchedule(t, r.name) })),
    { url: "https://www.bea.gov/news/schedule", publisher: "U.S. Bureau of Economic Analysis", title: "BEA release schedule", parse: (t) => parseBeaSchedule(t, y, BEA_KEEP).concat(next.y !== y ? parseBeaSchedule(t, next.y, BEA_KEEP) : []) },
    { url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", publisher: "Federal Reserve Board", title: "FOMC meeting calendar", parse: (t) => parseFomcMeetings(t, y).concat(next.y !== y ? parseFomcMeetings(t, next.y) : []) },
    { url: `https://www.federalreserve.gov/newsevents/${y}-${monthName(mo)}.htm`, publisher: "Federal Reserve Board", title: `Federal Reserve calendar, ${MONTHS[mo]} ${y}`, parse: (t) => parseFedMonth(t, y, mo) },
    { url: `https://www.federalreserve.gov/newsevents/${next.y}-${monthName(next.m)}.htm`, publisher: "Federal Reserve Board", title: `Federal Reserve calendar, ${MONTHS[next.m]} ${next.y}`, parse: (t) => parseFedMonth(t, next.y, next.m) },
  ];
  const log: OfficialFetch[] = [];
  const events: CalendarEvent[] = [];
  await Promise.all(jobs.map(async (j) => {
    const p = await fetchText(j.url);
    const found = p.ok ? j.parse(p.text) : [];
    const ahead = found.filter((e) => e.date >= today && e.date <= until);
    log.push({ url: j.url, ok: p.ok, status: p.status, ms: p.ms, error: p.ok ? (found.length ? null : `page read, but no dates in the expected format; text sample: "${sample(p.text)}"`) : p.error, events: ahead.length });
    const retrievedAt = new Date().toISOString();
    for (const e of ahead) {
      const source: Source = { url: j.url, title: j.title, publisher: j.publisher, published: null, checked: true };
      const { line, ...rest } = e;
      events.push({ ...rest, status: "confirmed", source, check: { official: true, dateFound: true, url: j.url, note: `on the official page: "${line}"`, retrievedAt } });
    }
  }));
  // The FOMC list and the monthly calendar can both give the decision date; keep one.
  const seen = new Set<string>();
  const deduped = events.filter((e) => { const k = `${e.date}|${e.event.replace(/\(.*\)/, "").trim().toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
  deduped.sort((a, b) => a.date.localeCompare(b.date));
  return { events: deduped, log };
}
