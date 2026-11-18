import { describe, expect, it } from "vitest";
import { runTool } from "@/lib/assistant/tools";
import type { Workspace } from "@/lib/workspace-core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeExposure } from "./engine";
import { checkLimits, PROPOSALS } from "./limits";
import { REAL_CASH, REAL_HOLDINGS } from "./__fixtures__/portfolio-2026-11-07";

const NOW = new Date("2026-11-08T12:00:00Z");
const exposure = computeExposure(REAL_HOLDINGS, REAL_CASH, NOW);
const rules = PROPOSALS.map((p) => ({ scope: "portfolio" as const, subject: p.subject, approval: "proposed" as const, normal_low: p.normal?.low ?? null, normal_high: p.normal?.high ?? null, value: p.review, hard_max: p.ceiling }));
const ws = {
  now: NOW, portfolio: { holdings: REAL_HOLDINGS, cash: REAL_CASH, quality: { status: "estimated" } }, policy: null,
  exposure, exposureLimits: checkLimits(exposure, rules),
} as unknown as Workspace;
const call = (input: Record<string, unknown>) => runTool("get_exposure", { dimension: "all", country: "", market: "", sector: "", industry: "", theme: "", company: "", what_if_symbol: "", what_if_dollars: 0, ...input }, ws, {} as SupabaseClient) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("assistant get_exposure tool on the real portfolio", () => {
  it("answers 'What percentage of my portfolio is invested in U.S. technology?'", async () => {
    const r = await call({ country: "United States", sector: "Information Technology" });
    expect(r.filter_result.pctOfEquity).toBeGreaterThan(0.35);
    expect(r.filter_result.contributors[0].via).toBe("NVDA");
    expect(r.sources.length).toBeGreaterThan(5);
  });

  it("answers 'What is my actual exposure to China, Taiwan and Japan?' with fund contributors", async () => {
    for (const c of ["China", "Taiwan", "Japan"]) {
      const r = await call({ dimension: "country", country: c });
      expect(r.filter_result.value).toBeGreaterThan(0);
      expect(r.filter_result.direct).toBe(0); // all through funds
    }
  });

  it("tests a purchase before recommending it: $1,000 more NVIDIA pushes semiconductors toward review", async () => {
    const r = await call({ what_if_symbol: "NVDA", what_if_dollars: 1000 });
    const semis = r.what_if.limits_after.find((c: { subject: string }) => c.subject.includes("Semiconductors"));
    expect(semis.value).toBeGreaterThan(0.24);
    const unknown = await call({ what_if_symbol: "SMH", what_if_dollars: 1000 });
    expect(unknown.what_if.purchase.classified).toBe(false); // the tool says so instead of guessing
  });
});
