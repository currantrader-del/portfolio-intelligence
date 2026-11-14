/**
 * The short list the overview leads with: where the portfolio is concentrated or exposed, and what to do
 * about each (review, maintain, reduce, research further). Pure and rule-based: every item states the
 * numbers it is based on. It never says "buy" to fill a gap, and being under a limit is never a reason to add.
 */
import type { CompanyExposure } from "@/lib/portfolio/engine";
import type { ExposureReport } from "./engine";
import type { LimitCheck } from "./limits";
import { BENCHMARK, SUPER_SECTOR, type Sector } from "./reference";

export type Action = "review" | "maintain" | "reduce" | "research" | "info";
export type Insight = { id: string; action: Action; severity: 1 | 2 | 3; title: string; detail: string; evidence: string[] };

const p = (x: number) => `${(x * 100).toFixed(1)}%`;

export function insights(r: ExposureReport, limits: LimitCheck[], companies: CompanyExposure[] = []): Insight[] {
  const out: Insight[] = [];
  const line = (k: keyof ExposureReport["dims"], key: string) => r.dims[k].lines.find((l) => l.key === key);
  const inv = (v: number) => (r.investable ? v / r.investable : 0);

  // Single companies at or over their own limit (limits include fund look-through).
  for (const c of companies) {
    if (c.total >= c.max * 0.9) {
      const over = c.total > c.max + 1e-9;
      out.push({
        id: `company-${c.symbol}`, action: over ? "reduce" : "maintain", severity: over ? 1 : 2,
        title: over ? `${c.symbol} is over its ${p(c.max)} maximum` : `${c.symbol} is at the top of its limit: don't add`,
        detail: `${c.symbol} is ${p(c.total)} of the invested portfolio: ${p(c.direct)} owned directly plus ${p(c.viaEtfs)} through your index funds. ${over ? "New money must not add to it, and a plan to bring it under the maximum is due." : `Only ${p(Math.max(0, c.max - c.total))} of room is left, so new money into it, or into funds that hold a lot of it, would breach the limit.`}`,
        evidence: ["Company limit from your approved policy", "Fund weights from the funds' published holdings (see sources)"],
      });
    }
  }

  // Exposure limits: approved ones drive actions; proposals are flagged as proposals.
  for (const c of limits) {
    if (c.state === "over_ceiling" || c.state === "review" || c.upperState === "review" || c.upperState === "over_ceiling") {
      const firm = c.state === "over_ceiling" || c.state === "review";
      out.push({
        id: `limit-${c.subject}`, action: c.state === "over_ceiling" && c.status === "approved" ? "reduce" : "review", severity: firm ? 1 : 2,
        title: `${c.label}: ${firm ? (c.state === "over_ceiling" ? "over the ceiling" : "above the review level") : "could be at the review level"}${c.status === "proposed" ? " (proposed limit)" : ""}`,
        detail: c.message,
        evidence: [c.status === "approved" ? "Approved exposure limit" : "Proposed exposure limit, not yet approved"],
      });
    }
  }

  // The AI cluster: one spending cycle behind several holdings.
  const ai = line("theme", "AI infrastructure");
  const semis = line("industry", "Semiconductors & Semiconductor Equipment");
  if (ai && inv(ai.value) >= 0.15 && !out.some((x) => x.id === "limit-exposure:theme:AI infrastructure")) {
    const names = ai.contributors.slice(0, 5).map((c) => c.via).join(", ");
    out.push({
      id: "cluster-ai", action: "review", severity: 2,
      title: `About ${p(inv(ai.value))} rides on AI data-center spending`,
      detail: `${names} all depend on the same driver: how much the big cloud companies spend on AI data centers. So they tend to move together when that outlook changes. Semiconductors alone are ${semis ? p(inv(semis.value)) : "n/a"} of the invested portfolio${semis?.upper ? ` (up to ${p(inv(semis.upper))} counting fund holdings not itemized)` : ""}.`,
      evidence: ["Look-through of direct holdings and fund top holdings", "Theme definition in the app (themes overlap)"],
    });
  }

  // Sector tilts versus the global market.
  for (const l of r.dims.sector.lines) {
    const b = BENCHMARK.sectors[l.key as Sector];
    if (b == null) continue;
    if (l.pct - b >= 0.08) out.push({ id: `tilt-${l.key}`, action: "info", severity: 3, title: `${l.key}: ${p(l.pct)} of your stocks vs ${p(b)} of the world market`, detail: `A deliberate tilt from your growth-stock holdings (${p(l.direct / r.equity)} direct). Not a problem by itself; it means this sector decides more of your result than it does for a global index fund.`, evidence: [`${BENCHMARK.source.label}, ${BENCHMARK.source.asOf}`] });
  }
  const under = r.dims.sector.lines.filter((l) => (BENCHMARK.sectors[l.key as Sector] ?? 0) - l.pct >= 0.05).map((l) => `${l.key} ${p(l.pct)} vs ${p(BENCHMARK.sectors[l.key as Sector])}`);
  if (under.length) out.push({ id: "under", action: "research", severity: 3, title: `Light in ${under.length} sector${under.length > 1 ? "s" : ""} versus the world market`, detail: `${under.join("; ")}. This is not a reason to buy them. It is only worth research if the sector's own prospects are good; the market analysis below checks that.`, evidence: [`${BENCHMARK.source.label}, ${BENCHMARK.source.asOf}`] });

  // Defensive share
  const def = r.dims.cycle.lines.find((l) => l.key === "Defensive");
  const benchDef = (Object.keys(SUPER_SECTOR) as Sector[]).filter((s) => SUPER_SECTOR[s] === "Defensive").reduce((a, s) => a + BENCHMARK.sectors[s], 0);
  if (def && benchDef - def.pct >= 0.04) out.push({ id: "defensive", action: "info", severity: 3, title: `Few defensive holdings: ${p(def.pct)} vs ${p(benchDef)} for the world market`, detail: "Consumer staples, health care and utilities usually fall less in recessions. With fewer of them, the portfolio will likely fall more than a global index in a downturn, and recover faster in a rebound.", evidence: ["Morningstar super-sector grouping", `${BENCHMARK.source.label}, ${BENCHMARK.source.asOf}`] });

  // Fund overlaps
  for (const o of r.overlaps.filter((x) => /no diversification/.test(x.note))) out.push({ id: `overlap-${o.a}-${o.b}`, action: "maintain", severity: 3, title: `${o.a} and ${o.b} are the same kind of fund`, detail: `${o.note} No action is needed; if you want fewer funds to track, new international money can go to one of them.`, evidence: ["Fund country and holdings weights (see sources)"] });

  // Rates
  if (r.rates.growthEquityPct >= 0.25) out.push({ id: "rates", action: "info", severity: 3, title: `${p(r.rates.growthEquityPct)} of your stocks are individual growth companies`, detail: `They are the part of the portfolio most sensitive to rising long-term interest rates. Your bond funds are small (${p(inv(r.bonds))} of the invested portfolio): ${r.rates.notes[0]}`, evidence: ["Issuer-published bond durations", "App style classification"] });

  if (r.gaps.length) out.push({ id: "gaps", action: "info", severity: 3, title: "What the numbers can't see yet", detail: r.gaps.join(" "), evidence: [] });

  return out.sort((a, b) => a.severity - b.severity);
}
