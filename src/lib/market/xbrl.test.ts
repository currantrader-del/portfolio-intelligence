import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { documentPeriodEnd, factAt, parseXbrlInstance } from "./xbrl";

const xml = readFileSync(join(__dirname, "__fixtures__/iren-10q-2026-09-30-subset.xml"), "utf8");

describe("parseXbrlInstance", () => {
  const facts = parseXbrlInstance(xml);
  it("reads numeric facts with their period and unit, skipping text and nil facts", () => {
    expect(facts.find((f) => f.concept === "dei:DocumentType")).toBeUndefined();
    expect(facts.find((f) => f.concept === "us-gaap:LiabilitiesAndStockholdersEquity")).toBeUndefined();
    expect(factAt(facts, "us-gaap:CashAndCashEquivalentsAtCarryingValue", "2026-09-30", "instant")).toMatchObject({ value: 3_522_000_000, unit: "usd", decimals: "-6" });
    expect(factAt(facts, "us-gaap:NetIncomeLoss", "2026-09-30", "duration", 80, 100)?.value).toBe(-263_000_000);
  });
  it("never returns a segment value as the company total", () => {
    expect(facts.some((f) => f.concept === "us-gaap:Revenues" && f.dimensional && f.value === 28_000_000)).toBe(true);
    expect(factAt(facts, "us-gaap:Revenues", "2026-09-30", "duration", 80, 100)?.value).toBe(228_000_000);
  });
  it("accepts repeated identical facts but refuses conflicting ones", () => {
    expect(factAt(facts, "us-gaap:CashAndCashEquivalentsAtCarryingValue", "2026-09-30", "instant")).not.toBeNull();
    const conflict = xml.replace("<!-- the same fact repeated", "<us-gaap:Assets contextRef=\"c-i-2026-09-30\" unitRef=\"usd\" decimals=\"-6\">1</us-gaap:Assets><!--");
    expect(factAt(parseXbrlInstance(conflict), "us-gaap:Assets", "2026-09-30", "instant")).toBeNull();
  });
  it("respects the duration window (a quarter is not a year-to-date or annual figure)", () => {
    expect(factAt(facts, "us-gaap:Revenues", "2026-09-30", "duration", 300, 400)).toBeNull();
  });
  it("reads the document period", () => {
    expect(documentPeriodEnd(xml)).toBe("2026-09-30");
    expect(documentPeriodEnd("<dei:DocumentPeriodEndDate contextRef=\"x\">September 30, 2026</dei:DocumentPeriodEndDate>")).toBe("2026-09-30");
    expect(documentPeriodEnd("<x/>")).toBeNull();
  });
});
