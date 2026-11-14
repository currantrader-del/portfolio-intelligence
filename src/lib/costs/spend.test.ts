import { describe, expect, it } from "vitest";
import { automatedGate, budgetGate, DEFAULT_COST_SETTINGS, manualGate, modelFamily, runEstimate, settingsFrom, summarizeSpend, type CostRow } from "./spend";

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
    const tight = summarizeSpend(rows, now, { ...DEFAULT_COST_SETTINGS, researchMonthly: 6 });
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

describe("monthly limits on automated and manual jobs", () => {
  const nearly = summarizeSpend([...rows, { at: "2026-11-09T13:05:00Z", feature: "market_briefing", cost: 19.2, model: "claude-sonnet-5-5" }], now);
  it("an automated job starts only when the month has room for its usual cost", () => {
    expect(automatedGate(summarizeSpend(rows, now), "market_briefing")).toEqual({ ok: true });
    // $19.66 of $20 spent: a briefing (about $0.60) is skipped, a watch summary (about $0.05) still fits.
    expect(automatedGate(nearly, "market_briefing")).toMatchObject({ ok: false, reason: expect.stringMatching(/everyday AI budget has \$0\.34 left of \$20/) });
    expect(automatedGate(nearly, "watch_run")).toEqual({ ok: true });
  });
  it("research jobs are held to the research budget, not the everyday one", () => {
    const research = summarizeSpend(rows, now, { ...DEFAULT_COST_SETTINGS, researchMonthly: 5 });
    expect(automatedGate(research, "research_result")).toMatchObject({ ok: false });
    expect(automatedGate(research, "portfolio_plan")).toEqual({ ok: true });
  });
  it("estimates a run from this month's average once there are two runs", () => {
    const s = summarizeSpend(rows, now);
    expect(runEstimate(s, "assistant_answer")).toBe(0.15);
    expect(runEstimate(nearly, "market_briefing")).toBeCloseTo((0.36 + 19.2) / 2, 2);
  });
  it("a manual job past the budget is a warning you confirm, not a silent start", () => {
    expect(manualGate(nearly, "portfolio_plan", false)).toMatchObject({ ok: false, needsConfirm: true, message: expect.stringMatching(/everyday AI budget over its \$20/) });
    expect(manualGate(nearly, "portfolio_plan", true)).toEqual({ ok: true });
    expect(manualGate(summarizeSpend(rows, now), "assistant_answer", false)).toEqual({ ok: true });
  });
});

describe("the 30-day test ceiling", () => {
  const settings = { ...DEFAULT_COST_SETTINGS, evalStart: "2026-11-07T00:00:00Z" };
  const s = summarizeSpend([...rows, { at: "2026-11-09T13:20:00Z", feature: "morning_answer", cost: 0.14, model: "claude-sonnet-5-5" }, { at: "2026-11-09T14:02:00Z", feature: "watch_run", cost: 0.004, model: "claude-haiku-5-5" }], now, settings);
  it("counts only spending since the start, in five categories, with the morning answer under briefings", () => {
    const e = s.evaluation!;
    expect(e).toMatchObject({ active: true, day: 4, ceiling: 25, warnAt: 20, spent: 5.2, warn: false, over: false });
    const by = Object.fromEntries(e.byCategory.map((c) => [c.key, c.cost]));
    expect(by).toEqual({ briefings: 0.14, research_updates: 4.96, company_analysis: 0, questions: 0.1, monitoring: 0 });
  });
  it("automated jobs stop at the ceiling and say why; a manual job asks first", () => {
    const near = summarizeSpend([...rows, { at: "2026-11-09T13:05:00Z", feature: "full_investigation", cost: 19.6, model: "claude-opus-5-5", runId: "r2" }], now, { ...settings, researchMonthly: 100 });
    expect(near.evaluation).toMatchObject({ warn: true, over: false });
    expect(automatedGate(near, "market_briefing")).toMatchObject({ ok: false, reason: expect.stringMatching(/30-day test has \$0\.\d\d left of its \$25 AI ceiling/) });
    expect(automatedGate(near, "watch_run")).toEqual({ ok: true });
    expect(budgetGate(near, "everyday", 0.6, false)).toMatchObject({ ok: false, needsConfirm: true, message: expect.stringMatching(/past its \$25 AI ceiling/) });
  });
  it("no test until a start date is saved; a bad date is ignored", () => {
    expect(summarizeSpend(rows, now).evaluation).toBeNull();
    expect(settingsFrom({ evalStart: "soon", evalCeiling: 20 }).evalStart).toBeNull();
    expect(settingsFrom({ evalStart: "2026-11-11T14:00:00Z", everydayMonthly: 30 })).toMatchObject({ evalStart: "2026-11-11T14:00:00Z", everydayMonthly: 30, evalWarnAt: 20 });
  });
});
