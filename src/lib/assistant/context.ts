/**
 * The investor context every assistant question starts with, so the assistant never has to be told
 * who it is working for: portfolio, accounts, cash and reserve, policy limits, every research record
 * (approved and newer versions, with age), the pipeline, recent decisions and the latest briefing.
 * It is compact text (a few thousand tokens) and is cached between questions by the API.
 */
import { VOO } from "@/lib/policy/evidence";
import { AGE_REMINDER_DAYS } from "@/lib/policy/limits";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "@/lib/workspace-core";
import { researchAgeDays } from "@/lib/research/records";
import { AUTHORITY_LABEL } from "@/lib/research/standing";
import type { Briefing } from "@/lib/intel/jobs";
import { loadProfile } from "@/lib/profile";

const pct = (x: number | null | undefined, d = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(d)}%`);
const usd = (x: number | null | undefined) => (x == null ? "not entered" : `$${Math.round(x).toLocaleString("en-US")}`);

export async function investorContext(ws: Workspace, db: SupabaseClient): Promise<{ text: string; briefingId: string | null }> {
  const p = ws.portfolio;
  const [{ data: decisions }, { data: brief }, profile] = await Promise.all([
    db.from("decisions").select("kind, symbol, decided_at, status, user_action, recommendation").order("decided_at", { ascending: false }).limit(8),
    db.from("model_runs").select("id, computed_at, outputs").eq("kind", "market_briefing").order("computed_at", { ascending: false }).limit(1).maybeSingle(),
    loadProfile(db),
  ]);
  const c = p.cashDetail;
  const lines: string[] = [];
  lines.push(`Now: ${ws.now.toISOString()} (US market ${ws.marketOpen ? "open" : "closed"}).`);
  if (profile.text) lines.push(`\nINVESTOR PROFILE AND GOALS (their own words; judge every recommendation against these)\n${profile.text.slice(0, 3000)}`);
  lines.push(`\nPORTFOLIO (${p.quality.status === "verified" ? "verified holdings" : `ESTIMATED: ${p.quality.headline}`})`);
  lines.push(`Investable capital ${usd(p.total)}. Cash BY ACCOUNT (cash never moves between accounts by itself): ${(c.accounts ?? []).map((a) => `${a.name} ${usd(a.cash)} (${a.note}; ${a.basis ? (a.basis.confirmed ? `confirmed: ${a.basis.detail}` : `NOT CONFIRMED: ${a.basis.detail}${a.basis.checks.length ? ` ${a.basis.checks.join(" ")}` : ""}`) : "source unknown"})`).join("; ")}. Treat any cash marked NOT CONFIRMED as an estimate and tell the investor to check the broker's app before acting on it. Cash that can buy a chosen stock or ETF today: ${usd(c.spendableNow)} in ${c.investingAccount?.name ?? "no self-directed account"}. Savings above the reserve (${usd(c.deployableSavings)}) can be invested only after a transfer the investor plans; planned transfers not yet arrived: ${ws.transfers.length ? ws.transfers.map((t) => `${usd(t.amount)} on ${t.date}`).join(", ") : "none"}. Never suggest buying with Acorns or Roth cash, and never move money between accounts in a recommendation unless a planned transfer exists. Protected reserve ${usd(c.protectedReserve)} (never invest it; excluded from percentages). Today ${pct(p.dayPct, 2)} (${usd(p.dayDollar)}).`);
  lines.push(`Accounts: ${p.accounts.map((a) => `${a.name} (${a.role ?? "role not set"}; statement ${a.asOf}, ${a.ageDays} days old${a.tradesAfter ? `, ${a.tradesAfter} trades recorded since` : ""})`).join("; ")}.`);
  lines.push("Holdings (symbol: weight, value, today, bucket, unrealized):");
  for (const h of [...p.holdings].sort((a, b) => b.weight - a.weight)) lines.push(`- ${h.symbol}: ${pct(h.weight)}, ${usd(h.value)}, today ${pct(h.dayPct, 2)}, ${h.bucket}${h.unrealized != null ? `, unrealized ${usd(h.unrealized)}` : ""}`);
  lines.push(`Buckets vs policy: ${p.buckets.map((b) => `${b.bucket} ${pct(b.weight)}${b.normal ? ` (normal ${pct(b.normal.low, 0)}-${pct(b.normal.high, 0)})` : ""}${b.hardMax != null ? ` max ${pct(b.hardMax, 0)}` : ""}${b.status !== "within" && b.status !== "no_limit" ? ` [${b.status}]` : ""}`).join("; ")}.`);
  const exp = p.exposures.filter((e) => e.total > 0.01).slice(0, 12);
  lines.push(`Single-company exposure incl. ETF look-through: ${exp.map((e) => `${e.symbol} ${pct(e.total)}${e.max != null ? ` (max ${pct(e.max, 0)}, ${ws.policy?.companies[e.symbol]?.status ?? "no limit"})` : ""}`).join("; ")}.`);

  const ex = ws.exposure;
  const top = (k: "sector" | "industry" | "theme" | "country" | "market", n: number) => ex.dims[k].lines.slice(0, n).map((l) => `${l.key} ${pct(l.pct)}${l.upperPct !== undefined ? ` (up to ${pct(l.upperPct)})` : ""}`).join("; ");
  lines.push(`Look-through exposure, % of stocks (use get_exposure for detail): sectors ${top("sector", 4)}. Industries ${top("industry", 3)}. Themes (overlap) ${top("theme", 3)}. Markets ${top("market", 3)}. Countries ${top("country", 4)}.`);
  if (ws.exposureLimits.length) lines.push(`Exposure limits: ${ws.exposureLimits.map((c) => `${c.label} ${pct(c.value)} of investable (${c.status}, ${c.state.replace(/_/g, " ")})`).join("; ")}.`);
  lines.push("\nRESEARCH RECORDS (stored; historical, check the age)");
  const fresh = AGE_REMINDER_DAYS;
  for (const r of ws.research) {
    const cur = r.current, last = r.latest;
    const age = researchAgeDays(r, ws.now);
    const newer = cur && last && last.id !== cur.id && last.research_as_of > cur.research_as_of ? last : null;
    const v = cur ?? last;
    const held = p.holdings.some((h) => h.symbol === r.symbol);
    lines.push(`- ${r.symbol}${r.name ? ` (${r.name})` : ""}${held ? " [held]" : ` [${r.pipeline.stage}]`}: ${v ? `${r.authoritative ? `APPROVED${r.approval === "provisional" ? " (provisionally)" : ""}` : `NOT APPROVED (${r.authority ? AUTHORITY_LABEL[r.authority].toLowerCase() : "unapproved"}; context only, no adds, buy zones or targets from it)`} ${v.completeness} research dated ${v.research_as_of} (${age} days${age != null && age > fresh ? ", old: check filings since" : ""})${v.parsed.action ? `, call ${v.parsed.action}` : ""}${v.parsed.referencePrice ? `, reference price ${v.parsed.referencePrice}` : ""}` : "no research"}${newer ? `; NEWER VERSION IN PROGRESS dated ${newer.research_as_of} (${newer.parsed.action ?? newer.completeness}): an investigation awaits the investor's approval and is not used until approved` : ""}`);
  }
  const noResearch = p.holdings.filter((h) => !ws.research.some((r) => r.symbol === h.symbol) && !/ETF|fund|broad|International|Bonds|Small\/mid/i.test(h.bucket)).map((h) => h.symbol);
  if (noResearch.length) lines.push(`Held single companies with no research record: ${noResearch.join(", ")}.`);

  if (ws.policy) {
    const lim = Object.values(ws.policy.companies).filter((x) => x.hardMax != null).map((x) => `${x.symbol} max ${pct(x.hardMax, 1)}${x.normal ? ` normal ${pct(x.normal.low, 1)}-${pct(x.normal.high, 1)}` : ""} (${x.provisional ? "provisional" : x.authority === "you" ? "approved by the investor" : x.authority === "imported" ? "imported from old archive, not confirmed" : x.status})`);
    lines.push(`Return comparison: no fixed cutoff. Each stock's research scenarios, re-priced at today's price, are compared with VOO's published forecasts shown separately (${VOO.forecasts.map((f) => `${f.firm} ${f.kind === "range" ? `${pct(f.low, 1)}-${pct(f.high, 1)}` : pct(f.low, 1)}, ${f.horizonYears[0] === f.horizonYears[1] ? f.horizonYears[0] : f.horizonYears.join("-")} years, as of ${f.asOf}`).join("; ")}), with a Treasury for the same horizon${ws.yields?.y10 ? ` (10-year ${ws.yields.y10.value.toFixed(2)}%, 2-year ${ws.yields.y2?.value.toFixed(2) ?? "n/a"}%)` : ""}, and with downside, valuation uncertainty and concentration. A favourable modeled return is NOT a buy recommendation: the completed research's own conclusion at today's price (its price zone, else its action) decides whether to add, and a stock can be HOLD / NO ADD despite an attractive model because of valuation uncertainty, downside, concentration, missing evidence or thesis conditions. Never override a research conclusion because a number looks good; say plainly when the model and the research disagree. But research guides, it does not freeze: when price, valuation, results, filings, financing or other material facts changed since it was written, reassess, and if the reassessment is incomplete say clearly what the old conclusion was and what you recommend now. Re-price expected returns at today's price. A few-year stock case and a 10-15 year index forecast are not equivalent: compare totals over the same span, say the comparison is approximate, and never treat it as a pass/fail. Scenario probabilities are the research's subjective assumptions, never statistical confidence. Conditions are mandatory: a conditional add ('only if', 'only after', 're-check first') is not an add until the condition is confirmed; IREN's high-conviction range requires meaningful de-risking first; a limit the investor has not approved, an unresolved financing or a thesis-changing event blocks new money, not just a warning. Separate ANALYSIS from EXECUTION: always give a useful opinion (what the research says, what looks best, what would change it), but call a dollar-specific recommendation ready to execute only when the money is verified (planned money that has not been deposited is a plan, never an order; cash already held is limited to what is deployable after the reserve), holdings and balances are verified by a recent statement, sync or the user's own check (recorded trades alone do not reconcile an account), and no material company development is unresolved; otherwise label it conditional and list exactly what must be confirmed. Before recommending VOO or any ETF, say what it does to total exposure (NVIDIA look-through, technology, semiconductors, AI infrastructure, geography) compared with the other core ETFs, existing holdings and keeping cash. Research needs a refresh when events happen (new results, financing, material 8-K, price moving into another zone of the research), not because of age. New cash does not have to be invested immediately; holding cash is always an option.`);
  }
  if (decisions?.length) {
    lines.push("\nRECENT DECISIONS");
    for (const d of decisions) lines.push(`- ${d.decided_at.slice(0, 10)} ${d.symbol ?? ""} ${d.kind}: ${(d.recommendation as { summary?: string; action?: string } | null)?.summary ?? (d.recommendation as { action?: string } | null)?.action ?? ""}${d.user_action ? ` (you: ${d.user_action})` : ""}`);
  }
  const alerts = ws.alerts.slice(0, 8);
  if (alerts.length) lines.push(`\nOPEN ALERTS: ${alerts.map((a) => a.title).join("; ")}.`);

  let briefingId: string | null = null;
  if (brief) {
    const b = brief.outputs as Briefing;
    briefingId = brief.id as string;
    lines.push(`\nLATEST MARKET BRIEFING (written ${brief.computed_at}; use get_briefing for the evidence)`);
    lines.push(`Headline: ${b.synthesis.headline}`);
    for (const s of b.synthesis.summary.slice(0, 5)) lines.push(`- ${s.text}`);
    lines.push(`Short-term stance ${b.synthesis.shortTerm.stance} (${b.synthesis.shortTerm.evidence} evidence); long-term ${b.synthesis.longTerm.stance} (${b.synthesis.longTerm.evidence}).`);
    const cal = (b.calendar ?? []).filter((e) => e.date >= ws.now.toISOString().slice(0, 10)).slice(0, 10);
    if (cal.length) lines.push(`Calendar: ${cal.map((e) => `${e.date} ${e.event} (${e.status})`).join("; ")}.`);
  }
  return { text: lines.join("\n"), briefingId };
}
