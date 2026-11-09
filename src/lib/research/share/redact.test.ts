import { describe, expect, it } from "vitest";
import { findLeaks, makeRedactor, MARK_CLAUSE, MARK_SENTENCE, sentences } from "./redact";

const r = makeRedactor({ amounts: [912.4, 1740.5, 41230, 187.1, 2500, 9000, 4210.2], terms: ["Brokerage One", "Spare Change Later"] });

// Sentences copied from the saved MU, IREN, NVDA and NOW investigations (Nov 8, 2026).
const KEEP = [
  "FY26 revenue was $133.2B against $37.4B in FY25 (F1).",
  "Dec 2025: IREN sold 39,699,102 shares at $41.12 in a registered direct offering.",
  "Diluted share count was 24,100 shares millions (Aug 21, 2026).",
  "Nine-month net income $1,044M includes $367M of unrealized strategic-investment gains (F13).",
  "FY26 results included a $559M unrealized gain on capped calls and prepaid forwards.",
  "Contracts are multi-year reserved capacity, and some are structured as leases.",
  "The CHIPS dilution-only window ends Dec 9, 2026 and management plans to return excess cash (F43, F44).",
  "Probability-weighted value $684 vs $690 (bear $290 at 35%, base $759 at 45%, bull $1,202 at 20%).",
  "Free cash flow was about $59B (F12, F15) and net cash was $68.3B (F13).",
  "All sit below or at the low end of the VOO forecasts (Vanguard 4.8-6.8%, J.P. Morgan 7.5%) and cash.",
  "Plan reserve +38M shares, overhang 6.2%.",
  "Micron is third in HBM at about 18% (F30, secondary).",
];

const DROP = [
  "Deployable cash is $187 and the $2,500 reserve is never invested.",
  "The cost basis is about $1,740, so the position is about $828 under water.",
  "IREN is 37 shares, $912, at 2.8% of investable capital.",
  "Position cost basis $4,210 vs value $3,980 (unrealized -$230).",
  "Full harvest and swap into VOO (rebuy IREN after 31 days to avoid a wash sale, with Acorns not holding IREN) is a reasonable alternative.",
  "MU has no approved company limit, so under policy it gets no new money.",
  "NVDA look-through is about 12.1-12.6% against the 18% maximum.",
  "Trim the IREN position to the 3% floor (sell about 10 of 37 shares) and do not add.",
  "Allocation is 0% target and 0% max until a limit is approved.",
  "Investable capital is about $41.2K.",
  "The position is 37 shares, $912.40, in the taxable Schwab account.",
  "Funding ($187 deployable, protected $2,500 reserve) and unconfirmed NOW limits still force no-add.",
  "A $5,000 MU what-if would move all three into the review zone (31%, 34%, 49%).",
  "Hold the existing 37 shares and do not add.",
  "It is held in Brokerage One.",
];

describe("sentences", () => {
  it("does not split decimals or abbreviations", () => {
    expect(sentences("Revenue was $1.5B vs. $1.2B. J.P. Morgan says 7.5%. Next.")).toHaveLength(3);
  });
});

describe("redaction", () => {
  it.each(KEEP)("keeps company research: %s", (s) => {
    expect(r.text(s)).toBe(s);
  });
  it.each(DROP)("removes the owner's details: %s", (s) => {
    const out = r.text(s);
    expect(out).not.toBe(s);
    expect(findLeaks(r, [out])).toEqual([]);
  });

  it("keeps the general entry condition and removes only the personal condition", () => {
    const out = r.text("Watch. No new money now. Consider a small starter only below about $520, and only after the investor approves an MU limit and deployable cash is rebuilt toward 5%.");
    expect(out).toContain("Consider a small starter only below about $520");
    expect(out).toContain(MARK_CLAUSE);
    expect(out).not.toMatch(/deployable|investor/);
    expect(out.startsWith("Watch. No new money now.")).toBe(true);
  });

  it("keeps the head of a clause whose condition is personal", () => {
    const out = r.text("Below about $520, consider a small starter only if the investor first approves an MU limit and funds it from planned cash outside the reserve, and only after the FQ1 report.");
    expect(out).toContain("consider a small starter");
    expect(out).toContain("FQ1 report");
    expect(out).not.toMatch(/investor|reserve/);
  });

  it("removes a whole portfolio section from a phase body and keeps the rest", () => {
    const md = [
      "**Valuation (app).** Weighted value is $933 against $690.",
      "",
      "**Portfolio fit.** Investable capital is about $41.2K. The $2,500 USAA reserve is approved by the investor and is never invested.",
      "MU would also add to NVDA (12.4% against an 18% maximum).",
      "",
      "**Action and bands.** From $520 to $750, watch. Above $750, no add. Allocation is 0% target and 0% max until a limit is approved.",
      "",
      "### Portfolio and policy",
      "Semiconductors are about 19.5% of equities.",
      "### What would change it",
      "- Downgrade if the gross margin guide falls below 80%.",
      "- Blocked by policy: no investor-approved MU limit, only about $187 of free cash.",
      "| Item | Value |",
      "|---|---|",
      "| Cost basis | $1,740 |",
      "| Revenue | $133.2B |",
    ].join("\n");
    const out = r.markdown(md);
    expect(out).toContain("Weighted value is $933 against $690.");
    expect(out).toContain("From $520 to $750, watch.");
    expect(out).toContain("Downgrade if the gross margin guide falls below 80%.");
    expect(out).toContain("$133.2B");
    expect(out).toContain("[Section removed:");
    expect(out).not.toMatch(/41\.2K|USAA|12\.4%|19\.5%|1,740|\$187/);
    expect(findLeaks(r, [out])).toEqual([]);
  });

  it("uses the owner's own amounts from the database", () => {
    expect(r.text("The account holds about $9,000.")).toBe(MARK_SENTENCE + "");
    expect(r.text("Gross profit rose to $9,000M.")).toBe("Gross profit rose to $9,000M.");
  });

  it("logs what was removed", () => {
    const x = makeRedactor();
    x.text("Deployable cash is $187.");
    expect([...x.log.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });
});
