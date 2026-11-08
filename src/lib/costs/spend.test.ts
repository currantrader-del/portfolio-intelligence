import { describe, expect, it } from "vitest";
import { budgetGate, modelFamily, summarizeSpend, type CostRow } from "./spend";

const now = new Date("2026-11-10T12:00:00Z");
const rows: CostRow[] = [
  { at: "2026-11-06T13:05:00Z", feature: "market_briefing", cost: 0.36, model: "claude-sonnet-5-5" },
  { at: "2026-11-07T13:05:00Z", feature: "assistant_answer", cost: 0.1, model: "claude-haiku-5-5" },
  { at: "2026-11-08T21:30:00Z", feature: "full_investigation", cost: 3.2, model: "claude-sonnet-5-5", runId: "r1" },
  { at: "2026-11-08T21:50:00Z", feature: "full_investigation", cost: 1.76, model: "claude-opus-5-5", runId: "r1" },
  { at: "2026-10-30T13:05:00Z", feature: "market_briefing", cost: 0.4, model: "claude-sonnet-5-5" },
];

describe("spending by feature, model and budget", () => {
  const s = summarizeSpend(rows, now);
  it("totals this month by feature (one investigation counted once) and by model", () => {
    expect(s.total).toBe(5.42);
    expect(s.byFeature[0]).toMatchObject({ label: "Full investigations", cost: 4.96, runs: 1, cls: "research" });
    expect(s.byModel.map((m) => m.model)).toEqual(["Sonnet", "Opus", "Haiku"]);
  });
  it("keeps everyday AI and research in separate budgets, projecting everyday at its daily pace", () => {
    expect(s.classes.everyday).toMatchObject({ spent: 0.46, budget: 20 });
    expect(s.classes.everyday.projected).toBeCloseTo((0.46 / 9.5) * 30, 1);
    expect(s.classes.research).toMatchObject({ spent: 4.96, budget: 25, projected: 4.96, left: 20.04, over: false });
  });
  it("asks before a job above the approval threshold or past the budget", () => {
    expect(budgetGate(s, "research", 2.5, false)).toEqual({ ok: true });
    expect(budgetGate(s, "research", 6, false)).toMatchObject({ ok: false, message: expect.stringMatching(/above your \$3 approval threshold/) });
    expect(budgetGate(s, "research", 6, true)).toEqual({ ok: true });
    const tight = summarizeSpend(rows, now, { everydayMonthly: 20, researchMonthly: 6, approveAbove: 3 });
    expect(budgetGate(tight, "research", 2.5, false)).toMatchObject({ ok: false, message: expect.stringMatching(/over its \$6 for the month/) });
    // The full-investigation checkbox covers the approval threshold, never the monthly budget.
    expect(budgetGate(s, "research", 6, false, true)).toEqual({ ok: true });
    expect(budgetGate(tight, "research", 6, false, true)).toMatchObject({ ok: false, needsConfirm: true, message: expect.stringMatching(/over its \$6 for the month/) });
  });
  it("names model families", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("Opus");
    expect(modelFamily(null)).toBe("Not recorded");
  });
});
