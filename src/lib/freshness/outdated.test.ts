import { describe, expect, it } from "vitest";
import { outdatedVerdict, reserveMentions, supersededMentions, type ContextEvent } from "./outdated";

// The Nov 6 morning briefing on Today, as stored (excerpt), and what changed after it.
const nov6 = "*Cash:* the $10,000 reserve stays untouched. The $91 brokerage cash is too small to matter.";
const writtenAt = "2026-11-06T22:02:51Z";
const events: ContextEvent[] = [
  { kind: "cash", at: "2026-11-07T13:03:18Z", label: "USAA Savings: balance as of 2026-11-07 added" },
  { kind: "policy", at: "2026-11-07T13:04:16Z", label: "Protected reserve set to $3,000" },
  { kind: "transactions", at: "2026-11-07T12:58:10Z", label: "Schwab One (Thinkorswim): trades or deposits recorded" },
  { kind: "transactions", at: "2026-11-07T12:50:46Z", label: "Schwab One (Thinkorswim): trades or deposits recorded" },
  { kind: "research", at: "2026-11-07T08:46:09Z", label: "New research on IREN" },
  { kind: "policy", at: "2026-11-05T12:00:00Z", label: "Old change before the briefing" },
];

describe("saved briefings after a policy change", () => {
  it("flags the Nov 6 briefing as outdated: reserve, cash, trades and research all changed after it", () => {
    const v = outdatedVerdict({ writtenAt, events, text: nov6, currentReserve: 3000 });
    expect(v.outdated).toBe(true);
    expect(v.contradictions).toEqual(["It uses a $10,000 reserve; the approved reserve is $3,000."]);
    expect(v.headline).toBe("Outdated: your policy, cash, recorded trades and deposits and research changed after it was written.");
    expect(v.changes.map((c) => c.label)).not.toContain("Old change before the briefing");
    // One line per subject, newest first.
    expect(v.changes.filter((c) => c.kind === "transactions")).toHaveLength(1);
    expect(v.changes[0].label).toBe("Protected reserve set to $3,000");
  });
  it("leaves a briefing written after every change as current", () => {
    const v = outdatedVerdict({ writtenAt: "2026-11-08T14:00:00Z", events, text: "Keep the $3,000 reserve in savings.", currentReserve: 3000 });
    expect(v).toMatchObject({ outdated: false, changes: [], contradictions: [] });
  });
  it("catches a contradiction even when no change was logged after it", () => {
    const v = outdatedVerdict({ writtenAt: "2026-11-08T14:00:00Z", events: [], text: nov6, currentReserve: 3000 });
    expect(v.outdated).toBe(true);
    expect(v.headline).toBe("Outdated: it contradicts your current policy.");
  });
  it("only counts the inputs a report depends on", () => {
    const v = outdatedVerdict({ writtenAt, events, kinds: ["policy"] });
    expect(v.changes.every((c) => c.kind === "policy")).toBe(true);
  });
});

describe("reserve amounts in text", () => {
  it("reads the usual phrasings", () => {
    expect(reserveMentions("the $10,000 reserve stays")).toEqual([10000]);
    expect(reserveMentions("keep a protected reserve of $3,000")).toEqual([3000]);
    expect(reserveMentions("$10k protected savings")).toEqual([10000]);
    expect(reserveMentions("$3,000 emergency reserve")).toEqual([3000]);
  });
  it("ignores other dollar amounts", () => {
    expect(reserveMentions("Buy $1,250 of VOO; $221 brokerage cash.")).toEqual([]);
  });
});

describe("superseded assumptions in an older plan", () => {
  // Excerpts of the stored 2026-11-07 portfolio plan.
  const facts = { approved: [{ symbol: "GOOGL", at: "2026-11-08T13:22:04Z" }, { symbol: "IREN", at: "2026-11-08T13:23:00Z" }], imported: ["US broad-market equity", "Deployable cash"] };
  const text = "Deployable cash is $221 (0.6%), well below the 5–15% policy range, so the first job is to rebuild it. Set aside new income until deployable cash reaches about 5% (roughly $1,950). VOO is the benchmark and would not push the US bucket past its 40% limit. Approve limits for GOOGL and IREN on the Policy page, and set your own ETF return and hurdle assumptions.";
  const perSymbol = [
    { symbol: "GOOGL", text: "Hold, no add. Expected return is about 3.1% a year, well below the hurdle. Your policy sources disagree on the limit (10% vs 15%), so approve one on the Policy page." },
    { symbol: "IREN", text: "Hold / no add. The 7% maximum is provisional and not approved." },
    { symbol: "NOW", text: "Below the 10% hurdle (VOO's assumed 7% plus 3 points)." },
  ];
  it("names each retired or resolved assumption the plan still relies on", () => {
    const m = supersededMentions(text, facts, perSymbol);
    expect(m.join(" ")).toMatch(/fixed return hurdle or a 7% ETF-return assumption/);
    expect(m.join(" ")).toMatch(/treats the GOOGL limit as undecided; you approved it on 2026-11-08/);
    expect(m.join(" ")).toMatch(/treats the IREN limit as undecided/);
    expect(m.join(" ")).toMatch(/5–15% deployable-cash range as a target/);
    expect(m.join(" ")).toMatch(/US broad-market range as a VOO limit/);
  });
  it("marks the plan outdated even when nothing else changed", () => {
    const v = outdatedVerdict({ writtenAt: "2026-11-07T23:29:37Z", events: [], text, policy: facts, perSymbol });
    expect(v.outdated).toBe(true);
    expect(v.headline).toBe("Outdated: it contradicts your current policy.");
  });
  it("says nothing about a plan written under today's policy", () => {
    expect(supersededMentions("Hold everything. VOO is the default for new money; the 5–15% cash range is only a guide.", facts)).toEqual([]);
  });
});
