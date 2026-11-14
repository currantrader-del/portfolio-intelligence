import { describe, expect, it } from "vitest";
import { eventAlerts, resultsDateFromResearch } from "./events";
import { classifyFiling } from "@/lib/market/filingClass";
import { parseSubmissions, type FilingsResult, type Filing } from "@/lib/market/sec";
import iren from "@/lib/market/__fixtures__/iren-submissions-2026-11-06.json";

const f = (o: Partial<Filing> & { form?: string; items?: string[] }): Filing => {
  const form = o.form ?? "8-K", items = o.items ?? [];
  return { form, filed: "2026-11-05", reportDate: null, description: "", items, isEarnings: items.includes("2.02"), url: "", ...classifyFiling(form, items), ...o };
};
const res = (filings: Filing[], next: string | null = null): FilingsResult => ({ cik: "1", company: "Alpha", filings, lastEarnings: null, nextEarningsEstimate: next, source: "", fetchedAt: "" });
const now = new Date("2026-11-06T15:00:00Z");

describe("classifyFiling", () => {
  it("never treats a form type as proof of dilution", () => {
    for (const [form, items] of [["424B5", []], ["S-3", []], ["424B7", []], ["8-K", ["3.02"]], ["8-K", ["2.03"]], ["D", []], ["S-8", []]] as const) {
      expect(classifyFiling(form, [...items]).note).not.toMatch(/dilute existing|new shares dilute/i);
    }
  });
  it("separates a shelf registration, a prospectus supplement and a resale", () => {
    expect(classifyFiling("S-3", []).category).toBe("registration");
    expect(classifyFiling("S-3", []).note).toMatch(/not a sale/);
    expect(classifyFiling("424B5", []).category).toBe("financing");
    expect(classifyFiling("424B5", []).note).toMatch(/not reviewed/i);
    expect(classifyFiling("424B7", []).category).toBe("resale");
  });
  it("reads an 8-K by its item codes, not as an offering", () => {
    expect(classifyFiling("8-K", ["7.01", "9.01"]).category).toBe("other_event");
    expect(classifyFiling("8-K", ["5.02"]).category).toBe("material_event");
    expect(classifyFiling("8-K", ["1.01", "2.03"]).category).toBe("financing");
    expect(classifyFiling("8-K", ["2.02", "9.01"]).category).toBe("results");
    expect(classifyFiling("8-K", ["2.02", "2.03"]).note).toMatch(/2\.03 \(financing\)/);
  });
});

describe("eventAlerts", () => {
  it("lists already-filed documents as recent, never as upcoming", () => {
    const a = eventAlerts(new Map([["AAA", res([f({ items: ["2.02"], description: "Earnings results" }), f({ form: "424B5", filed: "2026-11-04", description: "Prospectus supplement" }), f({ items: ["5.02"], description: "Executive or director change" })], "2026-11-10")]]), now);
    expect(a.every((x) => x.timing === "recent")).toBe(true); // results just filed, so no estimate is shown
    expect(a.map((x) => x.title)).toEqual(["AAA announced results", "AAA filed a prospectus supplement", "AAA: Executive or director change"]);
  });
  it("caps form-type alerts at medium severity and says the terms are not reviewed", () => {
    const a = eventAlerts(new Map([["AAA", res([f({ form: "424B5", description: "Prospectus supplement" }), f({ items: ["3.02"], description: "Unregistered sale of equity securities" })])]]), now);
    expect(a.map((x) => x.severity)).toEqual(["medium", "medium"]);
    for (const x of a) expect(x.detail).toMatch(/not reviewed|unknown until the filing is read/i);
  });
  it("shows an estimated report only when close, labelled as an estimate, and ignores old filings", () => {
    const a = eventAlerts(new Map([["AAA", res([f({ filed: "2026-09-01", items: ["2.02"] })], "2026-11-12")]]), now);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ timing: "upcoming", title: "AAA results expected around 2026-11-12 (estimated)" });
    expect(eventAlerts(new Map([["AAA", res([], "2026-12-30")]]), now)).toEqual([]);
  });
  it("ignores filings dated after now", () => {
    expect(eventAlerts(new Map([["AAA", res([f({ filed: "2026-11-09", form: "10-Q" })])]]), now)).toEqual([]);
  });
});

describe("real IREN submissions (SEC, retrieved 2026-11-06)", () => {
  const { company, filings } = parseSubmissions(iren);
  const by = (acc: string) => filings.find((x) => x.accession === acc)!;
  it("parses the company and classifies each 2026 filing by form and items", () => {
    expect(company).toBe("IREN Ltd");
    expect(by("0001878848-26-000052")).toMatchObject({ form: "10-K", category: "periodic" });
    expect(by("0001878848-26-000051")).toMatchObject({ category: "results", isEarnings: true });
    expect(by("0001140361-26-031055")).toMatchObject({ form: "424B7", category: "resale" });
    expect(by("0001140361-26-031053")).toMatchObject({ category: "other_event", description: "Regulation FD disclosure, Other events" });
    expect(by("0001140361-26-023427")).toMatchObject({ category: "financing", description: "Material agreement, New financial obligation" });
    expect(by("0001140361-26-027201")).toMatchObject({ form: "S-8", category: "employee_plan" });
  });
  it("leaves out 13G, Form 4 and proxy add-ons", () => {
    expect(filings.some((x) => ["SCHEDULE 13G", "4", "DEFA14A", "ARS"].includes(x.form))).toBe(false);
  });
  it("on 2026-11-06 reports nothing as recently filed, and no past filing as coming up", () => {
    const fr: FilingsResult = { cik: "1878848", company, filings, lastEarnings: filings.find((x) => x.isEarnings) ?? null, nextEarningsEstimate: null, source: "", fetchedAt: "" };
    expect(eventAlerts(new Map([["IREN", fr]]), now)).toEqual([]);
  });
});

describe("results dates from the research (audit 2026-11-11: Nov 17 vs an estimated Nov 25)", () => {
  it("reads a company-announced date next to a results word, on or after the research date", () => {
    expect(resultsDateFromResearch(["Hold, no add. Re-assess after the Nov 17 results and the probe findings."], "2026-11-10")).toBe("2026-11-17");
    expect(resultsDateFromResearch(["Nov 17: Q3 revenue at or above ~$106B"], "2026-11-10")).toBe("2026-11-17");
    expect(resultsDateFromResearch(["Bought on Nov 3, then held."], "2026-11-10")).toBeNull();
    expect(resultsDateFromResearch(["Feb 25 results"], "2026-11-10")).toBe("2027-02-25");
  });
  it("prefers the research's date over the filing-cadence estimate, and labels it", () => {
    const fr = res([f({ filed: "2026-08-27", items: ["2.02"], description: "Earnings results" })], "2026-11-25");
    const a = eventAlerts(new Map([["AAA", fr]]), new Date("2026-11-12T15:00:00Z"), new Map([["AAA", { date: "2026-11-17", asOf: "2026-11-10" }]]));
    const up = a.find((x) => x.timing === "upcoming")!;
    expect(up.title).toBe("AAA results on 2026-11-17 (from the research)");
    expect(up.detail).toMatch(/filing-cadence estimate \(2026-11-25\) is not used/);
  });
});
