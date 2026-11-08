/**
 * What a purchase does to the whole portfolio's exposure, with ETF look-through.
 *
 * For each way of using the money (a diversified ETF, an existing holding, or keeping cash) it reports the
 * concentrations that matter for this portfolio before and after: NVIDIA including what the funds hold,
 * technology, semiconductors, AI infrastructure, the US share and emerging markets. Each is checked against
 * the exposure levels on file (approved, or proposed and labelled so). It only describes; it does not score.
 */
import { computeExposure, type ExposureReport, type HoldingIn } from "@/lib/exposure/engine";
import { checkLimits, PROPOSALS, type LimitCheck } from "@/lib/exposure/limits";
import type { PolicyRuleRow } from "@/lib/policy/rules";

export const WATCHED: { key: string; label: string; dim: "company" | "sector" | "industry" | "theme" | "country" | "market"; line: string }[] = [
  { key: "nvda", label: "NVIDIA (incl. through funds)", dim: "company", line: "NVDA" },
  { key: "tech", label: "Information Technology", dim: "sector", line: "Information Technology" },
  { key: "semis", label: "Semiconductors", dim: "industry", line: "Semiconductors & Semiconductor Equipment" },
  { key: "ai", label: "AI infrastructure", dim: "theme", line: "AI infrastructure" },
  { key: "us", label: "United States", dim: "country", line: "United States" },
  { key: "em", label: "Emerging markets", dim: "market", line: "Emerging" },
];

export type ExposureRow = { key: string; label: string; before: number; after: number; level: { value: number; kind: string; status: "approved" | "proposed" | "imported" } | null; crosses: boolean };
export type ExposureImpact = { symbol: string; label: string; rows: ExposureRow[]; summary: string };

type Rule = Pick<PolicyRuleRow, "scope" | "subject" | "approval" | "normal_low" | "normal_high" | "value" | "hard_max">;

const pctOf = (rep: ExposureReport, dim: (typeof WATCHED)[number]["dim"], line: string) => {
  const l = rep.dims[dim]?.lines.find((x) => x.key === line);
  return l && rep.investable ? l.value / rep.investable : 0;
};
const f1 = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Exposure levels to compare against: rules on file, else the app's drafted proposals (shown as proposed). */
export function exposureRules(onFile: Rule[]): Rule[] {
  if (onFile.some((r) => r.scope === "portfolio" && r.subject.startsWith("exposure:"))) return onFile;
  return PROPOSALS.map((x) => ({ scope: "portfolio" as const, subject: x.subject, approval: "proposed" as const, normal_low: x.normal?.low ?? null, normal_high: x.normal?.high ?? null, value: x.review, hard_max: x.ceiling }));
}

export function exposureImpact(args: {
  holdings: HoldingIn[];
  cash: number;
  amount: number;
  /** new: the money is added on top of today's capital; existing: it comes out of cash already counted. */
  source: "new" | "existing";
  options: { symbol: string; label: string }[];
  rules: Rule[];
  nvdaMax?: { value: number; status: "approved" | "imported" } | null;
  now: Date;
}): { before: ExposureReport; impacts: ExposureImpact[] } {
  const { holdings, cash, amount, source, rules, now } = args;
  const before = computeExposure(holdings, cash, now);
  const limitsFor = (rep: ExposureReport) => checkLimits(rep, rules);
  const beforeLimits = limitsFor(before);
  const impacts = args.options.map(({ symbol, label }) => {
    const isCash = symbol === "CASH";
    const afterHoldings = isCash ? holdings : [...holdings, { symbol, value: amount }];
    const afterCash = isCash ? (source === "new" ? cash + amount : cash) : source === "new" ? cash : Math.max(0, cash - amount);
    const after = computeExposure(afterHoldings, afterCash, now);
    const afterLimits = limitsFor(after);
    const rows: ExposureRow[] = WATCHED.map((w) => {
      const lim: LimitCheck | undefined = afterLimits.find((c) => c.subject === `exposure:${w.dim}:${w.line}`);
      const b = pctOf(before, w.dim, w.line), a = pctOf(after, w.dim, w.line);
      const level = w.key === "nvda" && args.nvdaMax ? { value: args.nvdaMax.value, kind: "maximum", status: args.nvdaMax.status }
        : lim && (lim.review ?? lim.ceiling) != null ? { value: (lim.review ?? lim.ceiling)!, kind: lim.review != null ? "review level" : "ceiling", status: lim.status } : null;
      return { key: w.key, label: w.label, before: b, after: a, level, crosses: !!level && a > level.value && b <= level.value };
    });
    const moved = rows.filter((r) => Math.abs(r.after - r.before) >= 0.001);
    const up = moved.filter((r) => r.after > r.before && r.key !== "us").map((r) => `${r.label} ${f1(r.before)} → ${f1(r.after)}`);
    const down = moved.filter((r) => r.after < r.before && r.key !== "us").map((r) => `${r.label} ${f1(r.before)} → ${f1(r.after)}`);
    const crossed = rows.filter((r) => r.crosses).map((r) => `${r.label} would pass its ${r.level!.status} ${r.level!.kind} of ${f1(r.level!.value)}`);
    const newlyOver = afterLimits.filter((c) => (c.state === "review" || c.state === "over_ceiling") && beforeLimits.find((x) => x.subject === c.subject)?.state !== c.state).map((c) => c.message);
    const summary = [
      crossed.length ? `${crossed.join("; ")}.` : "",
      up.length ? `Raises ${up.join(", ")}.` : "",
      down.length ? `Lowers ${down.join(", ")}.` : "",
      !up.length && !down.length ? "Leaves these concentrations essentially unchanged." : "",
      newlyOver.length && !crossed.length ? newlyOver.join(" ") : "",
    ].filter(Boolean).join(" ");
    return { symbol, label, rows, summary };
  });
  return { before, impacts };
}
