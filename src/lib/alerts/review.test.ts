import { describe, expect, it } from "vitest";
import { eventAlerts } from "./events";
import { accKey, buildItems, classifyOffering, type ReviewState } from "./review";
import type { FilingsResult, Filing } from "@/lib/market/sec";
import { classifyFiling } from "@/lib/market/filingClass";

const now = new Date("2026-11-09T15:00:00Z");
const f = (form: string, filed: string, acc: string, items: string[] = []): Filing => ({
  form, filed, reportDate: null, description: form, items, isEarnings: items.includes("2.02"), ...classifyFiling(form, items), accession: acc,
  url: `https://www.sec.gov/Archives/edgar/data/1/${acc.replace(/-/g, "")}/doc.htm`,
});
const res = (filings: Filing[]): FilingsResult => ({ cik: "1", company: "X", filings, lastEarnings: null, nextEarningsEstimate: null, source: "", fetchedAt: "" });
const empty = (): ReviewState => ({ covered: new Map(), reviewed: new Set(), offerings: new Map() });

describe("filing review items", () => {
  const alerts = eventAlerts(new Map([
    ["AAA", res([f("10-Q", "2026-11-05", "0000000001-26-000066"), f("8-K", "2026-11-05", "0000000001-26-000065", ["2.02"])])],
    ["BBB", res([f("424B2", "2026-11-04", "0000000002-26-000010"), f("424B5", "2026-11-02", "0000000002-26-000009")])],
  ]), now);

  it("groups a same-day 10-Q and results 8-K into one item, and several prospectuses into one", () => {
    const items = buildItems(alerts, empty());
    expect(items.map((i) => i.title).sort()).toEqual(["AAA reported quarterly results", "BBB: 2 offering documents"]);
    expect(items.every((i) => i.status === "to_review")).toBe(true);
  });

  it("marks an item covered only when the research read every filing in it", () => {
    const s = empty();
    s.covered.set(accKey("0000000001-26-000066"), "your Nov 8 investigation");
    expect(buildItems(alerts, s).find((i) => i.symbol === "AAA")!.status).toBe("to_review");
    s.covered.set(accKey("0000000001-26-000065"), "your Nov 8 investigation");
    const a = buildItems(alerts, s).find((i) => i.symbol === "AAA")!;
    expect(a.status).toBe("covered");
    expect(a.coveredBy).toBe("your Nov 8 investigation");
  });

  it("clears an item the investor marked reviewed, and puts open items first", () => {
    const s = empty();
    s.reviewed.add(accKey("0000000001-26-000066")); s.reviewed.add(accKey("0000000001-26-000065"));
    const items = buildItems(alerts, s);
    expect(items[0].symbol).toBe("BBB");
    expect(items[1].status).toBe("reviewed");
  });

  it("labels a debt-only offering group as debt with low priority", () => {
    const s = empty();
    s.offerings.set(accKey("0000000002-26-000010"), "debt"); s.offerings.set(accKey("0000000002-26-000009"), "debt");
    const b = buildItems(alerts, s).find((i) => i.symbol === "BBB")!;
    expect(b.title).toBe("BBB: 2 offering documents (debt)");
    expect(b.severity).toBe("low");
    expect(b.couldChange).toMatch(/adds no shares/);
  });
});

describe("offering cover page", () => {
  it("reads debt, convertible and share offerings, checking debt first", () => {
    expect(classifyOffering("<p>$1,250,000,000 4.500% Notes due 2036</p><p>shares of common stock</p>")).toBe("debt");
    expect(classifyOffering("$500,000,000 0.25% Convertible Senior Notes due 2031")).toBe("convertible");
    expect(classifyOffering("10,000,000 Shares of Class A Common Stock")).toBe("shares");
    expect(classifyOffering("Prospectus Supplement")).toBe("unclear");
  });
});
