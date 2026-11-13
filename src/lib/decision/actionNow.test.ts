import { describe, expect, it } from "vitest";
import { actionNow } from "./actionNow";
import { parseConclusion } from "@/lib/research/valuation";

// The shape of the Nov 10 investigation's price framework (illustrative values, not holdings).
const pc = parseConclusion({
  reference_price: "166.8",
  price_framework: [
    { price_zone: "< $135", action: "No add by default. Consider an add only after the results and the probe are clean; this is a review point, not a buy signal." },
    { price_zone: "$135–$170", action: "Hold. Look-through weight is about 15% at $167." },
    { price_zone: "> $170", action: "Trim back to 15% look-through whenever the weight exceeds 15%." },
  ],
  would_change: ["A thesis-breaker (guide cut, CEO leaving): reduce toward ~12% look-through."],
});
const research = { pc, asOf: "2026-11-10", openQuestions: 1 };

describe("one plain action at today's price, with its levels", () => {
  it("a fall into the hold band says hold, and names the prices that would change it", () => {
    const a = actionNow({ symbol: "NVDA", price: 148, research, unreadFiling: null, trim: null, held: true });
    expect(a.verb).toBe("Hold");
    expect(a.headline).toMatch(/^Hold at \$148\.00: the Nov 10 research says for \$135–\$170: hold/);
    expect(a.levels).toMatch(/Hold while \$135–\$170 \(price \$148\.00\)\. Below \$135: no add by default.*Above \$170: trim back to 15%/);
    expect(a.watch[0]).toMatch(/CEO leaving/);
    expect(a.zones.find((z) => z.current)?.label).toBe("$135–$170");
  });

  it("a filing the research has not read comes first, and the levels still show", () => {
    const a = actionNow({ symbol: "NVDA", price: 148, research, unreadFiling: "8-K filed 2026-11-12", trim: null, held: true });
    expect(a.verb).toBe("Reassess first");
    expect(a.headline).toMatch(/hold until it is done: 8-K filed 2026-11-12 has not been read/);
    expect(a.levels).toMatch(/Below \$135/);
  });

  it("a conditional add zone is never a buy", () => {
    expect(actionNow({ symbol: "NVDA", price: 120, research: { ...research, openQuestions: 0 }, unreadFiling: null, trim: null, held: true }).verb).toBe("Hold");
  });

  it("a plain buy zone says buy more only with no open questions", () => {
    const buy = parseConclusion({ price_framework: [{ price_zone: "< $50", action: "Buy" }, { price_zone: "$50–$80", action: "Hold" }] });
    expect(actionNow({ symbol: "X", price: 45, research: { pc: buy, asOf: "2026-11-01", openQuestions: 0 }, unreadFiling: null, trim: null, held: true }).verb).toBe("Buy more");
    expect(actionNow({ symbol: "X", price: 45, research: { pc: buy, asOf: "2026-11-01", openQuestions: 2 }, unreadFiling: null, trim: null, held: true }).verb).toBe("Hold");
  });

  it("above the research weight level: trim with the size", () => {
    const a = actionNow({ symbol: "NVDA", price: 175, research, unreadFiling: null, trim: { dollars: 96, toPct: 15, why: "above 15%." }, held: true });
    expect(a.verb).toBe("Trim");
    expect(a.headline).toMatch(/^Trim about \$96 at \$175\.00/);
  });

  it("no researched levels: says so, never invents one", () => {
    const a = actionNow({ symbol: "ZZZ", price: 10, research: null, unreadFiling: null, trim: null, held: true });
    expect(a.verb).toBe("Hold");
    expect(a.headline).toMatch(/no researched price levels yet/);
  });
});

describe("is this a good price to buy: the research's own numbers at today's price", () => {
  const val = parseConclusion({
    valuation: { bear_value: 86.32, bear_probability: 0.3, base_value: 193.59, base_probability: 0.5, bull_value: 289.55, bull_probability: 0.2, terminal_date: "2029-06-30" },
    price_framework: [{ price_zone: "< $135", action: "Review an add" }, { price_zone: "$135–$170", action: "Hold" }, { price_zone: "> $170", action: "Trim" }],
    investment_summary: { risks: ["Capex durability (F52): the growth is only a preliminary expectation.", "CEO probe (F34, F46): outcome unknown."] },
  });
  it("gives the yearly return from today's price and from the buy level, the bear case and the risks", () => {
    const a = actionNow({ symbol: "NVDA", price: 160, now: new Date("2026-11-12T15:00:00Z"), research: { pc: val, asOf: "2026-11-10", openQuestions: 1 }, unreadFiling: null, trim: null, held: true });
    expect(a.priceAnswer).toMatch(/^From \$160\.00, the research's weighted value of \$180\.60 by 2029 works out to about 4\.\d% a year\. From \$135 \(where it starts to review an add\) it would be about 11\.\d% a year\./);
    expect(a.downside).toBe("Its bear case is $86.32 (-46% from here), given a 30% chance.");
    expect(a.risks[0]).toBe("Capex durability: the growth is only a preliminary expectation.");
  });
});
