import { describe, expect, it } from "vitest";
import { toResearchRecord, type VersionRow } from "@/lib/research/records";
import type { Alert } from "@/lib/alerts/rules";
import { decisionAlerts, formatDecisionPush, isBuyZone, isTrimZone, selectDecisionAlerts, type DecisionInputs } from "./decisionAlerts";

// Zones copied from the real Nov 8 NOW and IREN investigations; prices synthetic.
const now = new Date("2026-11-10T16:00:00Z");
const inv = (symbol: string, pf: { price_zone: string; action: string }[], ref: number, extra: Record<string, unknown> = {}, completeness = "complete"): VersionRow => ({
  id: `${symbol}-inv`, research_as_of: "2026-11-08", created_at: "2026-11-08T20:00:00Z", completeness, origin: "claude_full", is_current: false,
  conclusion: { research_type: "full_investigation", review_state: "awaiting_approval", action: "Hold / no add", thesis: `${symbol} thesis`, reference_price: String(ref), reference_date: "2026-11-08", price_framework: pf, ...extra },
});
const NOW_PF = [
  { price_zone: "< $80", action: "Add candidate only after a re-run of the model and with approved limits and funding." },
  { price_zone: "$80–$115", action: "Hold / no add." },
  { price_zone: "> $115", action: "Trim review: the weighted return is near zero around $110 and negative above." },
];
const IREN_PF = [
  { price_zone: "< $14", action: "Hold the ~54 shares; no add until the upgrade conditions are verified." },
  { price_zone: "$14–$22", action: "Hold at about 3% (~54 shares); no add." },
  { price_zone: "$22–$30", action: "Valuation-based trim zone: if the position is above 3%, trim to 3%." },
  { price_zone: "> $30", action: "Trim toward ~2% unless ARR and funding are verified." },
];
const screen: VersionRow = { id: "s", research_as_of: "2026-11-07", completeness: "complete", origin: "claude_full", is_current: true, conclusion: { generated_by: "ai-research@2", reference_price: "100", price_framework: [{ price_zone: "< $90", action: "Buy" }] } };

const q = (price: number, prevClose = price) => ({ price, prevClose, asOf: "2026-11-10T15:50:00Z" });
const base = (o: Partial<DecisionInputs> = {}): DecisionInputs => ({ research: [], holdings: [], quotes: new Map(), headroom: new Map(), marketDayPct: 0, events: [], now, ...o });

describe("which ranges are buy or trim ranges", () => {
  it("reads the research's own words", () => {
    const z = (action: string) => ({ low: 0, high: 1, label: "x", action });
    expect(isBuyZone(z(NOW_PF[0].action))).toBe(true);
    expect(isBuyZone(z(IREN_PF[0].action))).toBe(false); // "no add"
    expect(isBuyZone(z("Starter eligible (small, about 1-2%)"))).toBe(true);
    expect(isBuyZone(z("No new money. A lower price alone is not a reason to add."))).toBe(false);
    expect(isTrimZone(z(IREN_PF[2].action))).toBe(true);
  });
});

describe("decision alerts", () => {
  const nowRec = toResearchRecord("NOW", "ServiceNow", "held", [inv("NOW", NOW_PF, 90)], undefined, null, now);
  it("a completed investigation inside its buy range with room, fresh quote and no pending filing: buy opportunity", () => {
    const a = decisionAlerts(base({ research: [nowRec], quotes: new Map([["NOW", q(78)]]), headroom: new Map([["NOW", 1200]]) }));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ category: "buy_opportunity", symbol: "NOW", priority: "high" });
    expect(a[0].action).toMatch(/up to \$1,200\.00 of room/);
    expect(a[0].verified).toMatch(/delayed quote .* ET; research 2026-11-08/);
  });
  it("inside the range but no limit set or a stale quote: not actionable, says why", () => {
    const a = decisionAlerts(base({ research: [nowRec], quotes: new Map([["NOW", { ...q(78), asOf: "2026-11-10T13:00:00Z" }]]) }));
    expect(a[0]).toMatchObject({ category: "approaching", priority: "default" });
    expect(a[0].action).toMatch(/No buy yet: no position limit is set for it; the quote is not current/);
  });
  it("open questions keep it from being a buy opportunity", () => {
    const open = toResearchRecord("NOW", "ServiceNow", "held", [inv("NOW", NOW_PF, 90, { completion: { complete: false, reasons: ["Q1"] } }, "partial")], undefined, null, now);
    const a = decisionAlerts(base({ research: [open], quotes: new Map([["NOW", q(78)]]), headroom: new Map([["NOW", 1200]]) }));
    expect(a[0].category).toBe("approaching");
    expect(a[0].action).toMatch(/open questions/);
  });
  it("within 5% above a buy range: opportunity approaching", () => {
    const a = decisionAlerts(base({ research: [nowRec], quotes: new Map([["NOW", q(83)]]) }));
    expect(a[0]).toMatchObject({ category: "approaching" });
    expect(a[0].title).toMatch(/3\.8% above its buy range/);
  });
  it("a held stock in its trim range: trim review; a preliminary screen never alerts on price", () => {
    const iren = toResearchRecord("IREN", "IREN", "held", [inv("IREN", IREN_PF, 21.64)], undefined, null, now);
    const pre = toResearchRecord("ACME", null, "watch", [screen], undefined, null, now);
    const a = decisionAlerts(base({ research: [iren, pre], holdings: [{ symbol: "IREN", price: 25, priceSource: "quote", dayPct: 0.01, weight: 0.04 }], quotes: new Map([["IREN", q(25)], ["ACME", q(80)]]) }));
    expect(a.map((x) => [x.symbol, x.category])).toEqual([["IREN", "position_review"]]);
  });
  it("ordinary moves are not alerts; a 10% fall against the market is urgent", () => {
    const h = (dayPct: number) => ({ symbol: "RDDT", price: 100, priceSource: "quote" as const, dayPct, weight: 0.05 });
    expect(decisionAlerts(base({ holdings: [h(0.056)] }))).toEqual([]);
    expect(decisionAlerts(base({ holdings: [h(-0.06)] }))).toEqual([]);
    expect(decisionAlerts(base({ holdings: [h(-0.11)] }))[0]).toMatchObject({ category: "urgent_risk", priority: "high" });
  });
  it("results and financing filings for owned or researched companies are material developments; one alert per company", () => {
    const ev = (sev: Alert["severity"], filed = "2026-11-10"): Alert => ({ id: `ev-results-NOW-${filed}`, severity: sev, symbol: "NOW", kind: "event", timing: "recent", title: "NOW announced results", detail: "8-K filed.", href: "/research/NOW", source: { form: "8-K", filed, url: "u" } });
    const a = decisionAlerts(base({ research: [nowRec], quotes: new Map([["NOW", q(83)]]), events: [ev("medium"), ev("low", "2026-11-09")] }));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ category: "thesis_change", repeatAfterDays: 0 });
    expect(a[0].uncertain).toMatch(/not been read/);
  });
});

describe("repeats and the notification text", () => {
  const nowRec = toResearchRecord("NOW", "ServiceNow", "held", [inv("NOW", NOW_PF, 90)], undefined, null, now);
  const a = decisionAlerts(base({ research: [nowRec], quotes: new Map([["NOW", q(83)]]) }));
  it("holds a repeat back for a week; a filing is sent once", () => {
    expect(selectDecisionAlerts(a, new Map([[a[0].id, "2026-11-09T16:00:00Z"]]), now)).toEqual([]);
    expect(selectDecisionAlerts(a, new Map([[a[0].id, "2026-11-03T15:00:00Z"]]), now)).toHaveLength(1);
  });
  it("one alert reads as what changed, why, action, uncertain, verified", () => {
    const m = formatDecisionPush(a);
    expect(m.title).toMatch(/^Opportunity approaching: NOW/);
    expect(m.body.split("\n").map((l) => l.split(":")[0])).toEqual(["What changed", "Why it matters", "Action", "Uncertain", "Verified"]);
  });
});
