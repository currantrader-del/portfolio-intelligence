import { describe, expect, it } from "vitest";
import { estimateNextEarnings, factsFromConcept, findCik, padCik, parseSubmissions, summariseFacts } from "./sec";
import { decode, parseRss } from "./news";

describe("SEC parsing", () => {
  it("finds a CIK by ticker", () => {
    const body = { "0": { cik_str: 1234, ticker: "AAA", title: "Alpha Co" }, "1": { cik_str: 99, ticker: "BBB.A", title: "Beta" } };
    expect(findCik(body, "aaa")).toEqual({ cik: "0000001234", title: "Alpha Co" });
    expect(findCik(body, "BBB-A")?.cik).toBe("0000000099");
    expect(findCik(body, "ZZZ")).toBeNull();
    expect(padCik(5)).toBe("0000000005");
  });

  it("lists relevant filings and flags earnings 8-Ks", () => {
    const body = {
      cik: "1234", name: "Alpha Co",
      filings: { recent: {
        form: ["8-K", "4", "10-Q", "8-K"],
        filingDate: ["2026-10-30", "2026-10-29", "2026-10-29", "2026-09-01"],
        reportDate: ["2026-10-30", "", "2026-09-30", "2026-08-30"],
        accessionNumber: ["0001-26-000010", "0001-26-000009", "0001-26-000008", "0001-26-000007"],
        primaryDocument: ["a8k.htm", "f4.xml", "q3.htm", "b8k.htm"],
        primaryDocDescription: ["8-K", "4", "10-Q", "8-K"],
        items: ["2.02,9.01", "", "", "5.02"],
      } },
    };
    const { company, filings } = parseSubmissions(body);
    expect(company).toBe("Alpha Co");
    expect(filings.map((f) => f.form)).toEqual(["8-K", "10-Q", "8-K"]); // insider Form 4 skipped
    expect(filings[0]).toMatchObject({ isEarnings: true, description: "Earnings results", url: "https://www.sec.gov/Archives/edgar/data/1234/000126000010/a8k.htm" });
    expect(filings[1].description).toBe("Quarterly report");
    expect(filings[2]).toMatchObject({ isEarnings: false, description: "Executive or director change" });
  });

  it("estimates the next report about a quarter after the last one", () => {
    const last = { form: "8-K", filed: "2026-08-01", reportDate: null, description: "", items: ["2.02"], isEarnings: true, url: "" };
    expect(estimateNextEarnings(last, new Date("2026-08-15"))).toBe("2026-10-31");
    expect(estimateNextEarnings(last, new Date("2026-11-20"))).toBe("2027-01-30");
    expect(estimateNextEarnings(null)).toBeNull();
  });

  it("summarises quarterly, annual, year-over-year and trailing figures", () => {
    const f = (start: string, end: string, val: number, form = "10-Q", filed = end) => ({ start, end, val, form, filed });
    const facts = [
      f("2024-07-01", "2024-09-30", 80),
      f("2024-01-01", "2024-12-31", 360, "10-K"),
      f("2025-01-01", "2025-03-31", 90),
      f("2025-04-01", "2025-06-30", 95),
      f("2025-07-01", "2025-09-30", 100),
      f("2025-07-01", "2025-09-30", 100, "10-K", "2026-02-01"), // repeated in a later filing
      f("2025-01-01", "2025-12-31", 400, "10-K"),
      f("2026-01-01", "2026-03-31", 110),
      f("2026-04-01", "2026-06-30", 115),
      f("2026-07-01", "2026-09-30", 120),
      f("2026-01-01", "2026-09-30", 345), // nine-month figure ignored
    ];
    const s = summariseFacts(facts, "flow");
    expect(s.latestQuarter?.value).toBe(120);
    expect(s.yearAgoQuarter?.value).toBe(100);
    expect(s.yoy).toBeCloseTo(0.2);
    expect(s.latestAnnual?.value).toBe(400);
    // 400 + (110+115+120) - (90+95+100)
    expect(s.ttm).toBe(460);
  });

  it("reads the latest balance-sheet value and any unit", () => {
    expect(summariseFacts([{ end: "2026-06-30", val: 5 }, { end: "2026-09-30", val: 7 }], "instant").latest?.value).toBe(7);
    expect(factsFromConcept({ units: { "USD/shares": [{ end: "2026-09-30", val: 1.2 }] } })).toHaveLength(1);
    expect(factsFromConcept({})).toEqual([]);
  });
});

describe("RSS parsing", () => {
  it("decodes entities, CDATA and strips tags", () => {
    expect(decode("<![CDATA[Alpha &amp; Beta <b>up</b> 5&#37;]]>")).toBe("Alpha & Beta up 5%");
  });

  it("parses items, splits Google publishers, drops unsafe links and duplicates", () => {
    const xml = `<rss><channel>
      <item><title>Alpha beats estimates - Example Wire</title><link>https://news.example/a</link><pubDate>Thu, 05 Nov 2026 14:00:00 GMT</pubDate></item>
      <item><title>Alpha falls on guidance</title><link>https://news.example/b</link><source url="https://x">Other Daily</source><pubDate>Fri, 06 Nov 2026 09:00:00 GMT</pubDate></item>
      <item><title>Bad link</title><link>javascript:alert(1)</link></item>
      <item><title>Alpha beats estimates - Example Wire</title><link>https://news.example/c</link></item>
    </channel></rss>`;
    const h = parseRss(xml, "google");
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ title: "Alpha falls on guidance", publisher: "Other Daily" });
    expect(h[1]).toMatchObject({ title: "Alpha beats estimates", publisher: "Example Wire", publishedAt: "2026-11-05T14:00:00.000Z" });
  });
});
