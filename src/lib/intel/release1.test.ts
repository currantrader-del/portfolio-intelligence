import { afterEach, describe, expect, it, vi } from "vitest";
import { checkEvent, checkItem, claimFigures, dateOnPage, htmlText, matchFigures, officialFor, pageValues, type Fetcher } from "./verify";
import { computeCoverage, deskStatus } from "./coverage";
import { buildSnapshot, takeSnapshot, type Series } from "./snapshot";
import { INSTRUMENTS, MACRO } from "./instruments";
import type { CalendarEvent, DeskResult, Item } from "./desks";

// Synthetic data only.
const page = (text: string): Fetcher => async () => ({ ok: true, status: 200, ms: 5, text, error: null });
const down: Fetcher = async () => ({ ok: false, status: 403, ms: 5, text: "", error: "HTTP 403" });
const src = (url: string) => ({ url, title: "t", publisher: "p", published: "2026-11-06", checked: true });
const item = (detail: string, over: Partial<Item> = {}): Item => ({ headline: "Payrolls rose", detail, kind: "verified", significance: "high", sources: [src("https://news.example/jobs")], portfolio: null, unsourced: false, ...over });

describe("claim checks against the cited page", () => {
  it("picks out amounts and percentages but not years or dates", () => {
    expect(claimFigures("Payrolls rose 165,000 in October 2026; unemployment fell to 4.1% on Nov 6, from 4.2%. Revenue $3.45B.").map((f) => f.label))
      .toEqual(["165,000", "4.1%", "4.2%", "$3.45B"]);
  });
  it("matches figures written differently on the page", () => {
    const vals = pageValues(htmlText("<p>Employers added 165K jobs; the jobless rate was <b>4.1%</b> and revenue was $3,450 million.</p>"));
    expect(matchFigures(claimFigures("rose 165,000; 4.1%; $3.45 billion"), vals)).toEqual({ found: ["165,000", "4.1%", "$3.45 billion"], missing: [] });
  });
  it("reports matched, not found and unreadable pages honestly", async () => {
    expect((await checkItem(item("Payrolls rose 165,000."), page("Employers added 165,000 jobs."))).status).toBe("matched");
    expect((await checkItem(item("Payrolls rose 165,000 and 4.1%."), page("Employers added 165,000 jobs."))).status).toBe("partial");
    expect((await checkItem(item("Payrolls rose 999,000."), page("Employers added 165,000 jobs."))).status).toBe("not_found");
    expect((await checkItem(item("Payrolls rose 165,000."), down)).status).toBe("unreachable");
    expect((await checkItem(item("x", { kind: "statistical" }), page(""))).status).toBe("not_checked");
  });
});

describe("calendar confirmation", () => {
  const ev = (type: CalendarEvent["type"], url: string): CalendarEvent => ({ date: "2026-11-17", time: null, event: "e", type, status: "confirmed", expectation: null, why: "", symbols: [], source: src(url) });
  it("treats only company releases, filings and agencies as official", () => {
    expect(officialFor("earnings", "https://investor.example.com/news/q3-date")).toBe(true);
    expect(officialFor("earnings", "https://www.businesswire.com/news/home/123")).toBe(true);
    expect(officialFor("earnings", "https://www.example.com/investors/events")).toBe(true);
    expect(officialFor("earnings", "https://www.earningswhispers.com/epsdetails/x")).toBe(false);
    expect(officialFor("earnings", "https://www.nasdaq.com/market-activity/earnings")).toBe(false);
    expect(officialFor("economic", "https://www.bls.gov/schedule/news_release/cpi.htm")).toBe(true);
    expect(officialFor("economic", "https://fedratecalc.com/us-economic-calendar/")).toBe(false);
  });
  it("finds a date in its usual written forms", () => {
    for (const t of ["on November 17, 2026", "Nov. 17 after the close", "11/17/2026", "2026-11-17", "17 November"]) expect(dateOnPage("2026-11-17", t)).toBe(true);
    expect(dateOnPage("2026-11-17", "November 18, 2026")).toBe(false);
  });
  it("confirms an earnings date only from an official page that shows it", async () => {
    expect((await checkEvent(ev("earnings", "https://investor.example.com/q3"), page("Results on November 17, 2026"))).status).toBe("confirmed");
    expect((await checkEvent(ev("earnings", "https://investor.example.com/q3"), page("Results on November 19, 2026"))).status).toBe("estimated");
    expect((await checkEvent(ev("earnings", "https://investor.example.com/q3"), down)).check.note).toMatch(/could not be read/);
    expect((await checkEvent(ev("earnings", "https://www.wallstreethorizon.com/x"), page("November 17, 2026"))).status).toBe("estimated");
  });
});

const desk = (key: DeskResult["desk"], over: Partial<DeskResult> = {}): DeskResult => ({
  version: "desk@2", desk: key, title: key, generatedAt: "", model: "m", searches: 2, pagesReturned: 5, problems: [], uncertainties: [], usage: { input: 0, output: 0, searches: 0 }, status: "ok",
  items: key === "events" ? [] : [item("Payrolls rose 165,000.", { check: { status: "matched", url: null, found: [], missing: [], note: "" } })],
  calendar: key === "events" ? [{ date: "2026-11-17", time: null, event: "e", type: "earnings", status: "estimated", expectation: null, why: "", symbols: [], source: null }] : [],
  ...over,
});
const series = (): Series => ({ symbol: "X", price: 140, prevClose: 136, marketTime: "2026-11-06T15:55:00Z", closes: Array.from({ length: 300 }, (_, i) => ({ date: new Date(Date.UTC(2025, 10, 7) + i * 864e5).toISOString().slice(0, 10), close: 100 + i / 10 })), provider: "yahoo" });
const now = new Date("2026-11-06T16:00:00Z");
const fullSnapshot = () => buildSnapshot(new Map(INSTRUMENTS.map((i) => [i.symbol, series()])), new Map(MACRO.map((m) => [m.id, Array.from({ length: 30 }, (_, k) => ({ date: new Date(Date.UTC(2024, k, 1)).toISOString().slice(0, 10), value: 100 + k }))])), now);

describe("coverage and outlook gates", () => {
  it("rates a desk complete, partial or unavailable from its own results", () => {
    expect(deskStatus("us", desk("us"), null).level).toBe("complete");
    expect(deskStatus("us", desk("us", { items: [item("x", { unsourced: true })] }), null).level).toBe("partial");
    expect(deskStatus("us", desk("us", { status: "failed", error: "boom" }), null)).toMatchObject({ level: "unavailable", detail: "failed: boom" });
    expect(deskStatus("events", desk("events", { calendar: [] }), null).level).toBe("unavailable");
    expect(deskStatus("markets", null, null).detail).toBe("did not finish");
  });
  it("issues both outlooks only when every required input is complete", () => {
    const c = computeCoverage(fullSnapshot(), (["world", "us", "markets", "events"] as const).map((k) => ({ key: k, result: desk(k), reusedFrom: null })));
    expect([c.shortTerm.status, c.longTerm.status]).toEqual(["issued", "issued"]);
  });
  it("withholds the short-term outlook when the markets desk failed, and the long-term one without economic data", () => {
    const snap = buildSnapshot(new Map(INSTRUMENTS.map((i) => [i.symbol, series()])), new Map(), now);
    const c = computeCoverage(snap, [{ key: "world", result: desk("world"), reusedFrom: null }, { key: "us", result: desk("us"), reusedFrom: null }, { key: "markets", result: null, reusedFrom: null }, { key: "events", result: desk("events"), reusedFrom: "2026-11-06T12:00:00Z" }]);
    expect(c.shortTerm).toMatchObject({ status: "withheld" });
    expect(c.shortTerm.reasons[0]).toMatch(/Markets, sectors/);
    expect(c.longTerm.status).toBe("withheld");
    expect(c.longTerm.reasons[0]).toMatch(/0 of 15 series/);
    expect(c.inputs.find((i) => i.key === "events")?.reusedFrom).toBe("2026-11-06T12:00:00Z");
  });
});

describe("FRED requests are logged one series first, then the rest", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it("records status, latency and rows, falls back to the CSV when the API fails, and never logs the key", async () => {
    vi.stubEnv("FRED_API_KEY", "secret-key-123");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("yahoo")) return new Response("{}", { status: 404 });
      if (url.includes("api.stlouisfed.org")) return new Response("busy", { status: 503 });
      return new Response("observation_date,X\n2026-09-01,1.5\n2026-10-01,1.6\n", { status: 200 });
    }));
    const s = await takeSnapshot(now);
    const fred = s.fetchLog!.filter((l) => l.source !== "yahoo");
    expect(fred[0]).toMatchObject({ source: "fred-api", id: MACRO[0].id, status: 503, ok: false });
    expect(fred[1]).toMatchObject({ source: "fred-csv", id: MACRO[0].id, status: 200, ok: true, rows: 2 });
    expect(calls.findIndex((u) => u.includes(MACRO[1].id))).toBeGreaterThan(calls.findIndex((u) => u.includes(`fredgraph.csv?id=${MACRO[0].id}`)));
    expect(fred.filter((l) => l.ok).length).toBe(MACRO.length);
    expect(JSON.stringify(s.fetchLog)).not.toContain("secret-key-123");
    expect(s.macroSource?.kind).toBe("fred-api");
  });
  it("reports a timeout as such", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }));
    const s = await takeSnapshot(now);
    expect(s.fetchLog!.find((l) => l.source === "fred-csv")).toMatchObject({ ok: false, status: null, error: "timed out" });
    expect(s.notes.join(" ")).toMatch(/FRED requests failed \(fred-csv timed out\)/);
  });
});
