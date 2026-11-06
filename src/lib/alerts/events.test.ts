import { describe, expect, it } from "vitest";
import { eventAlerts } from "./events";
import type { FilingsResult, Filing } from "@/lib/market/sec";

const f = (o: Partial<Filing>): Filing => ({ form: "8-K", filed: "2026-11-05", reportDate: null, description: "", items: [], isEarnings: false, url: "", ...o });
const res = (filings: Filing[], next: string | null = null): FilingsResult => ({ cik: "1", company: "Alpha", filings, lastEarnings: null, nextEarningsEstimate: next, source: "", fetchedAt: "" });
const now = new Date("2026-11-06T15:00:00Z");

describe("eventAlerts", () => {
  it("flags fresh results, offerings and material 8-Ks", () => {
    const a = eventAlerts(new Map([["AAA", res([f({ isEarnings: true, items: ["2.02"], description: "Earnings results" }), f({ form: "424B5", filed: "2026-11-04" }), f({ items: ["5.02"], description: "Executive or director change" })])]]), now);
    expect(a.map((x) => x.id)).toEqual(["ev-results-AAA", "ev-offering-AAA", "ev-8k-AAA-2026-11-05"]);
    expect(a.find((x) => x.id === "ev-offering-AAA")?.severity).toBe("high");
  });
  it("mentions an estimated report only when it is close, and ignores old filings", () => {
    expect(eventAlerts(new Map([["AAA", res([f({ filed: "2026-09-01", items: ["2.02"], isEarnings: true })], "2026-11-12")]]), now).map((x) => x.title)).toEqual(["AAA results expected around 2026-11-12"]);
    expect(eventAlerts(new Map([["AAA", res([], "2026-12-30")]]), now)).toEqual([]);
  });
});
