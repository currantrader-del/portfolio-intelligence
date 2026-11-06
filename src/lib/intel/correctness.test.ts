import { describe, expect, it } from "vitest";
import { officialCalendar, parseBeaSchedule, parseBlsSchedule, parseFedMonth, parseFomcMeetings } from "./calendar";
import { checkEvent, companyDomain, finalCheck, officialFor, quoteOnPage, type ClaimCheck, type Fetcher } from "./verify";
import { filingItems, researchItems, companySymbols, type ResearchState } from "./holdings";
import { computeObservations } from "./observations";
import { outlookChange } from "./jobs";
import { deskStatus } from "./coverage";
import { buildSnapshot, type Series } from "./snapshot";
import { INSTRUMENTS, MACRO } from "./instruments";
import type { CalendarEvent, DeskResult, Item } from "./desks";
import type { Filing } from "../market/sec";

// Synthetic data only: page text is written in the publishers' formats, not copied from them.
const now = new Date("2026-11-06T20:00:00Z");

describe("official calendars", () => {
  it("reads BLS schedule rows, including zero-padded days", () => {
    const ev = parseBlsSchedule("Reference Month Release Date Release Time September 2026 Oct. 15, 2026 08:30 AM October 2026 Nov. 10, 2026 08:30 AM November 2026 Dec. 09, 2026 08:30 AM", "Consumer Price Index");
    expect(ev.map((e) => [e.date, e.time, e.event])).toEqual([
      ["2026-10-15", "8:30 AM ET", "Consumer Price Index (September 2026)"],
      ["2026-11-10", "8:30 AM ET", "Consumer Price Index (October 2026)"],
      ["2026-12-09", "8:30 AM ET", "Consumer Price Index (November 2026)"],
    ]);
    expect(ev[1].line).toBe("October 2026 Nov. 10, 2026 08:30 AM");
  });
  it("reads BEA rows and keeps only the releases asked for", () => {
    const t = "Year 2026 November 25 8:30 AM News GDP (Second Estimate) and Corporate Profits, 3rd Quarter 2026 November 25 10:00 AM News Personal Income and Outlays, October 2026 November 26 8:30 AM News U.S. International Investment Position";
    const ev = parseBeaSchedule(t, 2026, /GDP \(|Personal Income and Outlays/);
    expect(ev.map((e) => [e.date, e.time])).toEqual([["2026-11-25", "8:30 AM ET"], ["2026-11-25", "10:00 AM ET"]]);
    expect(ev[0].event).toMatch(/^GDP \(Second Estimate\)/);
  });
  it("reads FOMC minutes from the Fed's monthly calendar and decisions from the meeting list", () => {
    const m = parseFedMonth("Speeches 9:00 a.m. Governor speaks 12 2:00 p.m. FOMC Minutes Meeting of October 27-28 18", 2026, 10);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ date: "2026-11-18", time: "2:00 PM ET", event: "FOMC Minutes (Meeting of October 27-28)", type: "fed" });
    const f = parseFomcMeetings("2026 FOMC Meetings January 27-28 March 17-18* October 27-28 December 8-9* 2025 FOMC Meetings December 9-10*", 2026);
    expect(f.map((e) => e.date)).toEqual(["2026-01-28", "2026-03-18", "2026-10-28", "2026-12-09"]);
    expect(f[3].event).toMatch(/with economic projections/);
  });
  it("confirms events only from pages that were read, and reports pages that were not", async () => {
    const pages: Record<string, string> = {
      "https://www.bls.gov/schedule/news_release/cpi.htm": "October 2026 Nov. 10, 2026 08:30 AM",
      "https://www.bls.gov/schedule/news_release/ppi.htm": "October 2026 Nov. 13, 2026 08:30 AM",
      "https://www.federalreserve.gov/newsevents/2026-november.htm": "2:00 p.m. FOMC Minutes Meeting of October 27-28 18",
      "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm": "2026 FOMC Meetings October 27-28 December 8-9* 2025 FOMC Meetings",
    };
    const r = await officialCalendar(now, 40, async (url) => (pages[url] ? { ok: true, status: 200, ms: 1, text: pages[url], error: null } : { ok: false, status: 403, ms: 1, text: "", error: "HTTP 403" }));
    expect(r.events.map((e) => [e.date, e.event.split(" (")[0]])).toEqual([
      ["2026-11-10", "Consumer Price Index"], ["2026-11-13", "Producer Price Index"], ["2026-11-18", "FOMC Minutes"], ["2026-12-09", "FOMC rate decision"],
    ]);
    expect(r.events.every((e) => e.status === "confirmed" && e.check?.official && e.check.retrievedAt && /on the official page/.test(e.check.note))).toBe(true);
    expect(r.events[0].source).toMatchObject({ url: "https://www.bls.gov/schedule/news_release/cpi.htm", publisher: "U.S. Bureau of Labor Statistics" });
    expect(r.log.find((l) => l.url.includes("empsit"))).toMatchObject({ ok: false, error: "HTTP 403", events: 0 });
  });
});

describe("company sites count as official for earnings dates", () => {
  it("accepts the company's own domain, never an aggregator", () => {
    expect(companyDomain("nvidianews.nvidia.com", ["NVIDIA Corporation"])).toBe(true);
    expect(companyDomain("iren.com", ["IREN Limited"])).toBe(true);
    expect(companyDomain("sirens.com", ["IREN Limited"])).toBe(false);
    expect(officialFor("earnings", "https://nvidianews.nvidia.com/news/nvidia-sets-conference-call", ["NVIDIA Corp"])).toBe(true);
    expect(officialFor("earnings", "https://nvidianews.nvidia.com/news/x")).toBe(false);
    expect(officialFor("earnings", "https://www.tipranks.com/stocks/nvda/earnings", ["NVIDIA Corp"])).toBe(false);
  });
  it("confirms an earnings date from the company's release when the date is on the page", async () => {
    const ev: CalendarEvent = { date: "2026-11-17", time: "5:00 PM ET", event: "NVIDIA Q3 FY2027 results", type: "earnings", status: "estimated", expectation: null, why: "", symbols: ["NVDA"], source: { url: "https://nvidianews.nvidia.com/news/sets-call", title: "t", publisher: "NVIDIA", published: "2026-10-28", checked: true } };
    const page: Fetcher = async () => ({ ok: true, status: 200, ms: 1, text: "NVIDIA will host a conference call on Tuesday, November 17, at 2 p.m. PT (5 p.m. ET)", error: null });
    const r = await checkEvent(ev, page, { NVDA: "NVIDIA Corporation" });
    expect(r.status).toBe("confirmed");
    expect(r.check.retrievedAt).toBeTruthy();
    expect((await checkEvent(ev, page)).status).toBe("estimated");
  });
});

describe("a claim is verified only when the page supports it", () => {
  const item: Item = { headline: "Payrolls rose", detail: "Employers added 165,000 jobs in October.", kind: "verified", significance: "high", sources: [], portfolio: null, unsourced: false };
  const fig: ClaimCheck = { status: "matched", url: "https://www.bls.gov/x", found: ["165,000"], missing: [], note: "" };
  const text = "Total nonfarm payroll employment rose by 165,000 in October, the agency reported.";
  it("needs a quote that is really on the page", () => {
    expect(quoteOnPage("payroll employment rose by 165,000 in October", text)).toBe(true);
    expect(quoteOnPage("payroll employment rose by 200,000 in October", text)).toBe(false);
    expect(quoteOnPage("165,000", text)).toBe(false); // too short to count as a passage
  });
  it("keeps verified only with matching figures and a real supporting quote", () => {
    const ok = finalCheck(item, fig, { support: "supported", quote: "payroll employment rose by 165,000 in October" }, text, "2026-11-06T20:00:00Z");
    expect([ok.check.status, ok.kind, ok.check.retrievedAt]).toEqual(["matched", "verified", "2026-11-06T20:00:00Z"]);
    const madeUp = finalCheck(item, fig, { support: "supported", quote: "employers added a stunning 165,000 jobs" }, text, "t");
    expect(madeUp.kind).toBe("reported");
    const against = finalCheck(item, fig, { support: "unsupported", quote: null }, text, "t");
    expect([against.check.status, against.kind]).toEqual(["unsupported", "reported"]);
    const unread = finalCheck(item, { ...fig, status: "unreachable", found: [] }, null, null, "t");
    expect(unread.kind).toBe("reported");
    const someFigs = finalCheck(item, { ...fig, status: "partial", missing: ["59,000"] }, { support: "supported", quote: "payroll employment rose by 165,000 in October" }, text, "t");
    expect([someFigs.check.status, someFigs.kind]).toEqual(["partial", "reported"]);
  });
});

describe("holdings desk", () => {
  const filing = (over: Partial<Filing>): Filing => ({ form: "10-Q", filed: "2026-11-05", reportDate: "2026-09-30", description: "Quarterly report", items: [], isEarnings: false, url: "https://www.sec.gov/Archives/edgar/data/1/0001/x.htm", category: "periodic", note: "Read the filing for details.", ...over } as Filing);
  it("lists company filings from the last 14 days as primary sources, never as trade signals", () => {
    const items = filingItems("ACME", "Acme Corp", [filing({}), filing({ form: "8-K", isEarnings: true, items: ["Earnings results"], reportDate: null }), filing({ filed: "2026-10-01" })], now, 0.05, "2026-11-06T20:00:00Z", "https://data.sec.gov/submissions/CIK1.json");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "verified", significance: "high", period: "2026-09-30", check: { status: "primary" } });
    expect(items[1].headline).toBe("ACME: 8-K filed 2026-11-05 (earnings results)");
    expect(items.every((i) => /not a buy or sell signal/.test(i.portfolio ?? ""))).toBe(true);
  });
  const v = (id: string, asOf: string, current: boolean, action: string, completeness = "complete") => ({ id, research_as_of: asOf, completeness, origin: "test", is_current: current, conclusion: { action } });
  it("shows a newer research version in progress instead of hiding it behind the approved one", () => {
    const r: ResearchState = { symbol: "ACME", name: "Acme", current: v("a", "2026-09-10", true, "HOLD / NO ADD"), newer: [v("b", "2026-11-06", false, "WAIT / REVIEW", "in_progress")], filingCheck: { id: "f", at: "2026-11-06T14:52:00Z", status: "WAIT / REVIEW", reason: "Refresh rules call for a full reassessment.", document: { form: "10-Q", filed: "2026-11-05", periodEnd: "2026-09-30", indexUrl: "https://www.sec.gov/x/index.json" }, material: [], refreshLevel: "full_reassessment" } };
    const items = researchItems(r, 0.03, now);
    expect(items[0].headline).toBe("ACME: research update in progress, dated 2026-11-06 (WAIT / REVIEW)");
    expect(items[0].detail).toMatch(/approved version is dated 2026-09-10 with the call HOLD \/ NO ADD; it stays on file unchanged/);
    expect(items[1]).toMatchObject({ kind: "calculation", headline: "ACME: filing check WAIT / REVIEW against the 10-Q filed 2026-11-05" });
  });
  it("flags stale research when there is no newer version", () => {
    const items = researchItems({ symbol: "ACME", name: null, current: v("a", "2026-05-01", true, "HOLD"), newer: [], filingCheck: null }, null, now);
    expect(items[0].headline).toBe("ACME: research is 189 days old");
  });
  it("covers single companies only and is complete even with nothing new", () => {
    expect(companySymbols({ quality: "", cashNote: null, upcoming: [], holdings: [{ symbol: "VOO", weight: 0.3, bucket: "US broad-market equity", research: null, limit: null }, { symbol: "ACME", weight: 0.02, bucket: "Asymmetric/high-risk growth sleeve", research: null, limit: null }] })).toEqual(["ACME"]);
    const d = { items: [], problems: [], calendar: [], status: "ok" } as unknown as DeskResult;
    expect(deskStatus("holdings", d, null).level).toBe("complete");
  });
});

describe("observations and outlook changes", () => {
  const rising: Series = { symbol: "X", price: 140, prevClose: 136, marketTime: "2026-11-06T15:55:00Z", closes: Array.from({ length: 300 }, (_, i) => ({ date: new Date(Date.UTC(2025, 10, 7) + i * 864e5).toISOString().slice(0, 10), close: 100 + i / 10 })), provider: "yahoo" };
  const macro = new Map(MACRO.map((m) => [m.id, [{ date: "2026-10-01", value: m.id === "BAMLH0A0HYM2" ? 3.4 : 1 }, { date: "2026-11-01", value: m.id === "BAMLH0A0HYM2" ? 3.48 : 1 }]]));
  it("computes reproducible observations with ids, rules and refs", () => {
    const snap = buildSnapshot(new Map(INSTRUMENTS.map((i) => [i.symbol, rising])), macro, now);
    const a = computeObservations(snap), b = computeObservations(snap);
    expect(a).toEqual(b);
    expect(a.observations[0]).toMatchObject({ id: "O1", area: "trend", reading: "supportive", refs: ["S:^GSPC"] });
    const hy = a.observations.find((o) => o.refs.includes("F:BAMLH0A0HYM2"))!;
    expect(hy.text).toMatch(/3\.48% \(2026-11-01\), \+8bp/);
    expect(hy.reading).toBe("supportive");
    expect(a.unavailable[0]).toMatch(/Earnings estimate revisions/);
  });
  it("states the stance change against the previous briefing", () => {
    const s = (st: "bullish" | "mixed", lt: "bullish" | "mixed") => ({ shortTerm: { stance: st }, longTerm: { stance: lt } }) as never;
    expect(outlookChange({ id: "p", at: "2026-11-06T19:45:00Z", synthesis: s("mixed", "mixed") }, s("bullish", "mixed"))).toEqual({ previousId: "p", previousAt: "2026-11-06T19:45:00Z", shortTerm: { from: "mixed", to: "bullish" }, longTerm: { from: "mixed", to: "mixed" } });
    expect(outlookChange(null, s("mixed", "mixed")).shortTerm.from).toBeNull();
  });
});
