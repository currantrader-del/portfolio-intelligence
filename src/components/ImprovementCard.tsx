import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { shortDate } from "@/lib/format";
import { ETF_MIX, STRATEGY, type Assessment, type AssessmentStatus } from "@/lib/shadow/improve";
import type { CheckResult, Proposal } from "@/lib/shadow/proposals";
import type { ShadowReport } from "@/lib/shadow/shadow";
import { checkImprovementNow } from "@/app/(app)/plan/actions";

export type ImprovementItem = { p: Proposal & { id: string }; assessment: Assessment; report: ShadowReport | null; testClosed: boolean };

const usd = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(n)}`;
const pctS = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}%`;
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ""));
export const ASSESS_TONE: Record<AssessmentStatus, "gain" | "neutral" | "warn"> = { "Still attractive": "gain", "No longer attractive": "neutral", "More research needed": "warn" };

export function proposalLine(p: Proposal) {
  const sells = p.candidates.map((c) => `${c.sellPct >= 99.9 ? "Sell all" : "Trim"} ${qty(c.sellShares)} ${c.symbol} shares (${c.sellPct}% of the holding, about ${usd(c.sellValue)})`).join("; ");
  return `${sells}, and put the ${usd(p.proceeds)} into ${p.buys.map((b) => `${b.symbol} ${b.pct}%`).join(", ")}.`;
}

export function testLine(r: ShadowReport | null) {
  if (!r) return "Not started: the review did not find it worth a test.";
  if (r.status === "pending") return `Starts at the close on ${shortDate(r.startDate)}.`;
  if (!r.now) return "Running; no closing prices since the start yet.";
  return `${r.status === "closed" ? "Stopped" : "Running"} since ${shortDate(r.startDate)}. With the change ${signed(r.now.hypothetical.gain)} (${pctS(r.now.hypothetical.pct)}), your actual portfolio ${signed(r.now.actual.gain)} (${pctS(r.now.actual.pct)}), all VOO ${signed(r.now.voo.gain)} (${pctS(r.now.voo.pct)}), no change ${signed(r.now.original.gain)}.`;
}

/** The improvement strategy on Plan: the proposal, its reasons, the historical evidence, the forward test and today's view. */
export function ImprovementCard({ active, history, last }: { active: ImprovementItem[]; history: (Proposal & { id: string })[]; last: CheckResult | null }) {
  return (
    <Card labelledBy="pl-improve" className="!gap-2" id="improve">
      <CardHead id="pl-improve" title="Portfolio improvement" right={<Pill small>{STRATEGY.name}</Pill>} />
      <p className="t-xs">One fixed strategy: when a stock is above its policy line, or completed research says Trim or Exit, the app proposes moving the excess into {ETF_MIX.map((m) => `${m.symbol} ${m.pct}%`).join(", ")}. An AI review (about $0.10) decides whether it is worth your time; No change is a valid answer. Checked after each weekly plan. Nothing is traded.</p>
      {active.length === 0 && (
        <p className="t-sm"><span className="text-ink font-semibold">No change recommended right now.</span>{last ? ` Last checked ${shortDate(last.at)}: ${last.outcome}` : " Not checked yet."}</p>
      )}
      {active.map((it) => <ProposalView key={it.p.id} it={it} />)}
      <ActionForm action={checkImprovementNow} success="Check started; refresh in a minute" className="self-start">
        <SubmitButton className="btn btn-sm" pendingText="Starting…">Check now</SubmitButton>
      </ActionForm>
      {history.length > 0 && (
        <Disclose summary={<span className="t-sm">Earlier proposals · {history.length} (kept as history)</span>}>
          <ul className="flex flex-col gap-1.5 t-sm">
            {history.map((p) => (
              <li key={p.id}><span className="text-ink">{shortDate(p.at)}</span> · {p.review ? p.review.verdict : "Not reviewed"} · {proposalLine(p)}{p.review ? <span className="t-xs"> {p.review.reason}</span> : p.reviewSkipped ? <span className="t-xs"> ({p.reviewSkipped})</span> : null}</li>
            ))}
          </ul>
        </Disclose>
      )}
    </Card>
  );
}

function ProposalView({ it }: { it: ImprovementItem }) {
  const { p, assessment: a } = it;
  const r = p.review!;
  const bull = p.candidates.map((c) => ({ c, u: p.upside[c.symbol] })).filter((x) => x.u?.bullUsd !== null && x.u?.bullUsd !== undefined);
  const rows: [string, React.ReactNode][] = [
    ["Proposal", proposalLine(p)],
    ["Reason", `${r.reason} ${r.riskEffect}`.trim()],
    ["Upside given up", <>{r.upsideGivenUp}{bull.length ? <span className="t-xs"> From the research scenarios: {bull.map((x) => `${x.c.symbol} bull case ${signed(x.u.bullUsd!)}${x.u.baseUsd !== null ? `, base case ${signed(x.u.baseUsd)}` : ""} on the sold shares`).join("; ")}.</span> : null}</>],
    ["Would be wrong if", r.invalidation],
    ["Historical evidence", <>{p.evidence.summary} <Disclose summary={<span className="t-xs">Details and limits</span>}><Evidence p={p} /></Disclose></>],
    ["Forward shadow test", testLine(it.report)],
    ["Current assessment", <><Pill small tone={ASSESS_TONE[a.status]}>{a.status}</Pill> <span className="t-xs">{a.reasons.join("; ")}. From today&apos;s weights, research and plan, not from the test&apos;s results.</span></>],
  ];
  return (
    <div className="border-t border-line pt-2 flex flex-col gap-1">
      <p className="t-xs">Proposed {shortDate(p.at)} · review confidence {r.confidence}</p>
      <dl className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 sm:gap-y-1.5 t-sm">
        {rows.map(([k, v]) => <div key={k} className="contents"><dt className="t-xs pt-1.5 sm:pt-0.5">{k}</dt><dd className="min-w-0">{v}</dd></div>)}
      </dl>
    </div>
  );
}

function Evidence({ p }: { p: Proposal }) {
  return (
    <div className="flex flex-col gap-1.5 t-xs">
      <p>Rule tested: each month, if the stock is more than 25% above its cap, sell it back to the cap at the next close and buy the ETF mix; 0.05% cost per trade; dividends included.</p>
      <ul className="flex flex-col gap-1">
        {p.evidence.tested.map((b) => b.ok ? (
          <li key={b.symbol}><span className="text-ink">{b.symbol}</span> {b.from.slice(0, 4)}–{b.to.slice(0, 4)}, cap {b.capPct}%: yearly {b.rule.cagr}% with the rule vs {b.noChange.cagr}% no change, {b.voo.cagr}% VOO, {b.mix.cagr}% ETF mix; worst drop {b.rule.maxDrawdown}% vs {b.noChange.maxDrawdown}%; return per unit of risk {b.rule.returnPerRisk ?? "—"} vs {b.noChange.returnPerRisk ?? "—"}; {b.trims} trims, turnover {b.turnoverPerYear}% a year; better or equal in {b.windowsBetter}% of {b.windows} 12-month windows.</li>
        ) : <li key={b.symbol}><span className="text-ink">{b.symbol}</span>: not tested, {b.why}.</li>)}
      </ul>
      <ul className="list-disc pl-4">{p.evidence.limits.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}

/** The short version on Today, only while a proposal is being tracked. */
export function ImprovementTeaser({ items }: { items: ImprovementItem[] }) {
  if (!items.length) return null;
  return (
    <Card labelledBy="td-improve" className="!gap-1.5">
      <CardHead id="td-improve" title="Portfolio improvement opportunity" right={<Link href="/plan#improve" className="t-sm">Plan</Link>} />
      {items.map((it) => (
        <div key={it.p.id} className="flex flex-col gap-1 t-sm">
          <p><span className="text-ink font-semibold">Proposal:</span> {proposalLine(it.p)}</p>
          <p><span className="text-ink font-semibold">Reason:</span> {it.p.review?.reason}</p>
          <p><span className="text-ink font-semibold">Historical evidence:</span> {it.p.evidence.summary} <span className="t-xs">{it.p.evidence.limits[0]}</span></p>
          <p><span className="text-ink font-semibold">Forward shadow test:</span> {testLine(it.report)}</p>
          <p><span className="text-ink font-semibold">Current assessment:</span> <Pill small tone={ASSESS_TONE[it.assessment.status]}>{it.assessment.status}</Pill></p>
        </div>
      ))}
    </Card>
  );
}
