import { describe, expect, it } from "vitest";
import { buildSnapshot, computeBreadth, computeRow, macroRow, parseFredCsv, parseYahooSeries, type Series } from "./snapshot";
import { INSTRUMENTS, MACRO } from "./instruments";
import { collectSearchPages, extractJson, validateDesk, type DeskResult } from "./desks";
import { mergedCalendar, validateSynthesis } from "./synthesis";

// Synthetic data only.
const now = new Date("2026-11-06T16:00:00Z"); // 11:00 ET, a Friday
const days = (n: number, start = 100, step = 0.1) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2025, 10, 7) + i * 86400000);
  return { date: d.toISOString().slice(0, 10), close: start + i * step };
});
const series = (over: Partial<Series> = {}): Series => {
  const closes = days(365);
  return { symbol: "X", price: 140, prevClose: 136, marketTime: "2026-11-06T15:55:00Z", closes, provider: "yahoo", ...over };
};

describe("market snapshot", () => {
  const spx = INSTRUMENTS.find((i) => i.symbol === "^GSPC")!;
  const tnx = INSTRUMENTS.find((i) => i.symbol === "^TNX")!;
  it("computes moves, averages and freshness from provider data", () => {
    const r = computeRow(spx, series(), now);
    expect(r.day).toBeCloseTo(140 / 136 - 1, 10);
    expect(r.freshness).toBe("live");
    expect(r.vs200d).toBeGreaterThan(0);
    expect(r.from52wHigh).toBeLessThanOrEqual(0);
    expect(r.ytd).not.toBeNull();
  });
  it("reports yield changes in basis points, not percent", () => {
    const r = computeRow(tnx, series({ price: 4.18, prevClose: 4.1, closes: days(300, 4.0, 0.0005) }), now);
    expect(r.day).toBeCloseTo(8, 6);
    expect(r.vs50d).toBeNull();
  });
  it("labels an earlier session as a previous close rather than a live price", () => {
    expect(computeRow(spx, series({ marketTime: "2026-11-05T21:00:00Z" }), now).freshness).toBe("previous close");
    expect(computeRow(spx, series({ marketTime: "2026-11-06T14:00:00Z" }), now).freshness).toBe("delayed");
  });
  it("lists instruments it could not load instead of filling them", () => {
    const s = buildSnapshot(new Map([["^GSPC", series()]]), new Map(), now);
    expect(s.rows).toHaveLength(1);
    expect(s.missing.length).toBe(INSTRUMENTS.length - 1);
    expect(s.macroMissing.length).toBe(MACRO.length);
    expect(s.breadth).toBeNull();
  });
  it("reads a Yahoo chart response with its market time", () => {
    const body = { chart: { result: [{ meta: { regularMarketPrice: 5000, regularMarketTime: 1762444500, exchangeTimezoneName: "America/New_York" }, timestamp: [1762266600, 1762353000, 1762439400], indicators: { quote: [{ close: [4900, 4950, 4990] }] } }] } };
    const s = parseYahooSeries("^GSPC", body)!;
    expect(s.price).toBe(5000);
    expect(s.marketTime).toBe(new Date(1762444500 * 1000).toISOString());
    expect(s.prevClose).toBe(4950); // the bar before the market-time session
    expect(parseYahooSeries("X", { chart: { result: [{ meta: { regularMarketPrice: 10 } }] } })).toBeNull(); // no time, no quote
  });
  it("measures breadth from sector funds only", () => {
    const rows = ["XLK", "XLC", "XLY", "XLP", "XLE", "XLF", "XLV", "XLI", "XLB", "XLRE", "XLU"].map((sym, i) =>
      computeRow(INSTRUMENTS.find((x) => x.symbol === sym)!, series({ price: i < 4 ? 150 : 120, prevClose: i % 2 ? 151 : 119 }), now));
    const b = computeBreadth(rows)!;
    expect(b.sectorsTotal).toBe(11);
    expect(b.sectorsUp).toBe(rows.filter((r) => r.day! > 0).length);
    expect(b.leaders).toHaveLength(3);
  });
});

describe("FRED macro data", () => {
  const csv = "observation_date,CPIAUCSL\n2025-09-01,320.0\n2025-10-01,321.0\n2026-08-01,328.0\n2026-09-01,329.6\n2026-10-01,.\n";
  it("skips missing observations and keeps each value's own date", () => {
    expect(parseFredCsv(csv).map((o) => o.date)).toEqual(["2025-09-01", "2025-10-01", "2026-08-01", "2026-09-01"]);
  });
  it("computes year-over-year against the same month, not the previous row", () => {
    const r = macroRow(MACRO.find((m) => m.id === "CPIAUCSL")!, parseFredCsv(csv))!;
    expect(r.date).toBe("2026-09-01");
    expect(r.value).toBeCloseTo((329.6 / 320 - 1) * 100, 6);
    expect(r.previous).toBeNull(); // 2025-08 is not in the data, so no prior YoY is claimed
    expect(r.source).toBe("https://fred.stlouisfed.org/series/CPIAUCSL");
  });
  it("turns payroll levels into monthly changes and claims into thousands", () => {
    const pay = macroRow(MACRO.find((m) => m.id === "PAYEMS")!, [{ date: "2026-08-01", value: 159000 }, { date: "2026-09-01", value: 159150 }, { date: "2026-10-01", value: 159100 }])!;
    expect(pay).toMatchObject({ value: -50, previous: 150, date: "2026-10-01" });
    const claims = macroRow(MACRO.find((m) => m.id === "ICSA")!, [{ date: "2026-10-24", value: 221000 }, { date: "2026-10-31", value: 228000 }])!;
    expect(claims.value).toBe(228);
  });
});

// A response shaped like the API's: search result blocks and a cited text block.
const response = [
  { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "fed" } },
  { type: "web_search_tool_result", tool_use_id: "s1", content: [
    { type: "web_search_result", url: "https://www.reuters.com/markets/us/fed-holds-2026-11-05/", title: "Fed holds rates", page_age: "November 5, 2026", encrypted_content: "x" },
    { type: "web_search_result", url: "https://www.bls.gov/news.release/empsit.nr0.htm", title: "Employment Situation", page_age: null, encrypted_content: "y" },
  ] },
  { type: "text", text: "Summary", citations: [{ type: "web_search_result_location", url: "https://apnews.com/article/oil-opec", title: "OPEC+ output", cited_text: "..." }] },
];

describe("desk results", () => {
  const pages = collectSearchPages(response);
  it("collects every page the searches returned, including cited ones", () => {
    expect([...pages.keys()]).toEqual(["https://reuters.com/markets/us/fed-holds-2026-11-05", "https://bls.gov/news.release/empsit.nr0.htm", "https://apnews.com/article/oil-opec"]);
  });
  it("reads the final JSON block", () => {
    expect(extractJson('text\n```json\n{"items":[]}\n```')).toEqual({ items: [] });
    expect(extractJson("no json here")).toBeNull();
  });
  const raw = {
    items: [
      { headline: "Fed holds rates", detail: "The FOMC left rates unchanged.", kind: "verified", significance: "high", sources: [{ url: "https://reuters.com/markets/us/fed-holds-2026-11-05/", publisher: "Reuters", published: "2026-11-05" }] },
      { headline: "Rumor of a rate cut in December", detail: "Unconfirmed.", kind: "verified", significance: "low", sources: [{ url: "https://example.com/made-up", publisher: "Example" }] },
      { headline: "", detail: "no headline" },
    ],
    calendar: [
      { date: "2026-11-04", event: "Past event", type: "economic", status: "confirmed" },
      { date: "2026-11-13", time: "08:30 ET", event: "CPI (October)", type: "economic", status: "confirmed", source: { url: "https://www.bls.gov/news.release/empsit.nr0.htm" } },
      { date: "2026-11-20", event: "NVDA earnings", type: "earnings", status: "confirmed", symbols: ["nvda"], source: { url: "https://example.com/guess" } },
    ],
    uncertainties: ["Consensus for CPI not found"],
  };
  const v = validateDesk(raw, pages, now);
  it("marks a source checked only when the search returned it, and downgrades an unchecked 'verified' item", () => {
    expect(v.items).toHaveLength(2);
    expect(v.items[0]).toMatchObject({ kind: "verified", unsourced: false });
    expect(v.items[0].sources[0]).toMatchObject({ checked: true, published: "2026-11-05" });
    expect(v.items[1]).toMatchObject({ kind: "interpretation", unsourced: true });
    expect(v.problems.join(" ")).toMatch(/no source that the search returned/);
  });
  it("keeps only future dates in the calendar, and 'confirmed' only with a checked source", () => {
    expect(v.calendar.map((c) => c.event)).toEqual(["CPI (October)", "NVDA earnings"]);
    expect(v.calendar[0].status).toBe("confirmed");
    expect(v.calendar[1]).toMatchObject({ status: "estimated", symbols: ["NVDA"] });
  });
});

describe("synthesis checks", () => {
  const desk = (key: "world" | "us" | "markets", n: number): DeskResult => ({
    version: "desk@1", desk: key, title: key, generatedAt: now.toISOString(), model: "m", searches: 1, pagesReturned: 1, problems: [], uncertainties: [], usage: { input: 0, output: 0, searches: 0 },
    items: Array.from({ length: n }, (_, i) => ({ headline: `h${i}`, detail: "d", kind: "verified", significance: "medium", sources: [], portfolio: null, unsourced: false })),
    calendar: key === "markets" ? [{ date: "2026-11-13", time: null, event: "CPI", type: "economic", status: "confirmed", expectation: null, why: "", symbols: [], source: null }] : [],
  });
  const snapshot = buildSnapshot(new Map([["^GSPC", series()]]), new Map(), now);
  const ctx = { snapshot, desks: [desk("world", 2), desk("us", 1), desk("markets", 1)] };
  const base = { headline: "H", summary: [{ text: "Stocks rose", refs: ["S:^GSPC", "W2", "Z9"] }], attention: [{ text: "No evidence", refs: [] }],
    shortTerm: { stance: "bullish", evidence: "moderate", drivers: [{ text: "d", refs: ["M1", "C1"] }], contrary: [], wouldChange: ["x"] },
    longTerm: { stance: "sideways", evidence: "certain", base: { summary: "b", conditions: [], signposts: [] }, bull: { summary: "u", conditions: [], signposts: [] }, bear: { summary: "e", conditions: [], signposts: [] }, contrary: [], wouldChange: [] },
    portfolio: [{ subject: "IREN", text: "Consider buying more on this dip.", action: "monitor", refs: ["U1"] }, { subject: "SPY", text: "Broad sell-off risk to watch; no action needed.", action: "monitor", refs: [] }], gaps: [] };
  const v = validateSynthesis(base, ctx);
  it("removes references to evidence that does not exist and reports uncited points", () => {
    expect(v.synthesis.summary[0].refs).toEqual(["S:^GSPC", "W2"]);
    expect(v.problems.some((p) => p.includes("Z9"))).toBe(true);
    expect(v.problems.some((p) => p.includes("cites no evidence"))).toBe(true);
    expect(v.synthesis.shortTerm.drivers[0].refs).toEqual(["M1", "C1"]);
  });
  it("never lets a portfolio note recommend a trade", () => {
    expect(v.synthesis.portfolio[0].action).toBe("review");
    expect(v.problems.some((p) => p.includes("trade language"))).toBe(true);
    expect(v.synthesis.portfolio[1].action).toBe("monitor"); // "sell-off" is not trade advice
  });
  it("falls back to cautious labels for invalid stances", () => {
    expect(v.synthesis.longTerm).toMatchObject({ stance: "mixed", evidence: "weak" });
  });
  it("merges calendars without duplicates", () => {
    expect(mergedCalendar([...ctx.desks, desk("markets", 0)])).toHaveLength(1);
  });
});
