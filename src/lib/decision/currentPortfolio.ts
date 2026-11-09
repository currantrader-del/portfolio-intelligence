/**
 * Current Portfolio decision: "Given what I own and the capital I could deploy, what is the best action right now?"
 *
 * It adds no new analysis. It runs the same deterministic new-capital engine (approved research, today's prices,
 * limits, exposure, reserve) on the money that actually exists, and decides HOW MUCH is worth deploying:
 *  - Brokerage cash already in the account that buys is the first source.
 *  - Savings above the protected reserve, capped by your standing transfer limit and net of transfers already
 *    planned, is only a maximum you authorised for evaluating opportunities. It is never buying power, and it is
 *    proposed only when a researched stock qualifies for more than the brokerage cash covers. A diversified ETF on
 *    its own is never a reason to move savings: that is a long-term allocation choice, shown as an alternative.
 *  - Nothing has to be invested. No allocation target is filled.
 * Hypothetical deposits and transfers live in the separate What-if mode.
 */
import type { PlannedTransfer, PortfolioView } from "@/lib/portfolio/engine";
import { newCapital, ruleRowsOf, type NewCapitalResult, type Option } from "@/lib/decision/newCapital";
import type { FilingsResult } from "@/lib/market/sec";
import type { Workspace } from "@/lib/workspace-core";

/** Your standing capital preference: the most you are willing to move from savings to the brokerage for a good opportunity. */
export type CapitalPreference = { maxTransfer: number; setAt: string; note: string | null };

/** Savings older than this are shown as needing an update before a transfer is sized on them. */
export const SAVINGS_FRESH_DAYS = 31;

export type Transferable = {
  /** Total recorded savings (all savings accounts), or null when never entered. */
  savings: number | null;
  savingsAsOf: string | null;
  reserve: number;
  aboveReserve: number;
  /** Your standing limit, or null when not set. */
  cap: number | null;
  /** Transfers out of savings you already planned (they count against both the balance and the limit). */
  alreadyPlanned: number;
  /** What could still be moved: min(limit, savings − reserve) minus transfers already planned, never below 0. */
  amount: number;
  /** The savings balance is your own dated entry or a statement within SAVINGS_FRESH_DAYS. */
  verified: boolean;
  detail: string;
};

const $ = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const $2 = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function transferableSavings(args: { portfolio: PortfolioView; transfers: PlannedTransfer[]; preference: CapitalPreference | null; now: Date }): Transferable {
  const cd = args.portfolio.cashDetail;
  const savingsIds = new Set((cd.accounts ?? []).filter((a) => a.use === "savings").map((a) => a.id));
  const alreadyPlanned = Math.round(args.transfers.filter((t) => savingsIds.has(t.fromAccountId)).reduce((a, t) => a + t.amount, 0) * 100) / 100;
  const reserve = cd.protectedReserve;
  const savings = cd.savings;
  const aboveReserve = savings === null ? 0 : Math.max(0, savings - reserve);
  const cap = args.preference ? Math.max(0, args.preference.maxTransfer) : null;
  const ageDays = cd.savingsAsOf ? Math.floor((args.now.getTime() - new Date(cd.savingsAsOf).getTime()) / 86_400_000) : null;
  const verified = savings !== null && ageDays !== null && ageDays <= SAVINGS_FRESH_DAYS;
  const amount = cap === null ? 0 : Math.max(0, Math.floor(Math.min(cap, aboveReserve) - alreadyPlanned));
  const multiple = savingsIds.size > 1 ? ` across ${savingsIds.size} savings accounts` : "";
  const detail = savings === null
    ? "No savings balance on file, so nothing from savings is counted. Enter it on Portfolio → Reconcile."
    : cap === null
      ? `Savings ${$2(savings)}${multiple}; ${$(aboveReserve)} is above your ${$(reserve)} protected reserve. You have not set a standing transfer limit, so none of it is considered.`
      : `min(${$(cap)} limit, ${$2(savings)} savings${multiple} − ${$(reserve)} reserve)${alreadyPlanned ? ` − ${$2(alreadyPlanned)} already planned` : ""} = ${$(amount)} you could move if an opportunity justifies it.${verified ? "" : ` The savings balance is from ${cd.savingsAsOf?.slice(0, 10) ?? "an unknown date"}; update it before moving money.`}`;
  return { savings, savingsAsOf: cd.savingsAsOf, reserve, aboveReserve, cap, alreadyPlanned, amount, verified, detail };
}

export type Alternative = { key: "add" | "new" | "etf" | "cash"; title: string; status: string; detail: string; symbol: string | null; href: string | null };

export type CurrentDecision = {
  /** One plain answer to "what should I do now?" */
  headline: string;
  /** Why, in two or three sentences. */
  why: string;
  /** The split that makes sense (possibly nothing). */
  allocations: { symbol: string; amount: number }[];
  /** Where the money comes from. Savings appear only when a researched stock needs them. */
  funding: { brokerage: number; fromSavings: number; detail: string };
  status: NewCapitalResult["status"];
  alternatives: Alternative[];
  /** Before acting: the open checks, then the transfer and trade steps you would take yourself. */
  confirm: string[];
  money: { brokerageCash: number; brokerageConfirmed: boolean; plannedIn: number; transferable: Transferable };
  /** The engine result the recommendation is sized on (exposure, gates, options), for the detail cards and the record. */
  result: NewCapitalResult;
  /** What the same engine says if every dollar you authorised were available: which stocks qualify and their room. */
  capacity: NewCapitalResult;
};

type EngineArgs = Omit<Parameters<typeof newCapital>[0], "amount" | "source" | "authorizedSavings">;

const isStock = (o: Option | undefined) => o?.kind === "stock" || o?.kind === "new_stock";

export function currentPortfolioDecision(args: EngineArgs & { preference: CapitalPreference | null }): CurrentDecision {
  const { portfolio, preference, ...rest } = args;
  const transfers = args.transfers ?? [];
  const cd = portfolio.cashDetail;
  const inv = cd.investingAccount ?? null;
  const invName = inv?.name ?? "your brokerage account";
  const invAsOf = portfolio.accounts.find((a) => a.id === inv?.id)?.asOf ?? null;
  const brokerageCash = Math.max(0, Math.floor((cd.spendableNow ?? 0) * 100) / 100);
  const plannedIn = Math.round(transfers.filter((t) => inv && t.toAccountId === inv.id && (!invAsOf || t.createdAt > invAsOf)).reduce((a, t) => a + t.amount, 0) * 100) / 100;
  const tr = transferableSavings({ portfolio, transfers, preference, now: args.now });
  const here = Math.round((brokerageCash + plannedIn) * 100) / 100;
  const run = (amount: number, authorizedSavings: number) => newCapital({ ...rest, portfolio, amount: Math.max(1, amount), source: "existing", authorizedSavings });

  // 1. What qualifies if every authorised dollar were available.
  const capacity = run(here + tr.amount, tr.amount);
  const kindOf = (r: NewCapitalResult, s: string) => r.options.find((o) => o.symbol === s);
  const stockNeed = capacity.recommendation.allocations.filter((a) => isStock(kindOf(capacity, a.symbol))).reduce((a, x) => a + x.amount, 0);
  // 2. Size on what is worth deploying: brokerage cash first; savings only for the stock adds that need them.
  const fromSavings = stockNeed > here ? Math.min(tr.amount, Math.ceil(stockNeed - here)) : 0;
  const total = here + fromSavings;
  const result = total >= 1 ? run(total, fromSavings) : capacity;
  const allocations = total >= 1 ? result.recommendation.allocations : [];
  const stockAllocs = allocations.filter((a) => isStock(kindOf(result, a.symbol)));
  const etfAlloc = allocations.find((a) => kindOf(result, a.symbol)?.kind === "etf");
  const etfSym = result.exposure.choice !== "CASH" ? result.exposure.choice : "VOO";
  const words = (xs: { symbol: string; amount: number }[]) => xs.map((x) => `${$(x.amount)} ${x.symbol}`).join(" and ");
  const once = result.status === "ready" ? "" : " once the checks below are done";

  let headline: string;
  let why: string;
  if (stockAllocs.length) {
    headline = `Add ${words(stockAllocs)}${etfAlloc ? `; the other ${$(etfAlloc.amount)} to ${etfAlloc.symbol} or keep it as cash` : ""}${once}`;
    const lead = stockAllocs.map((a) => kindOf(result, a.symbol)!).map((o) => `${o.symbol}: approved research supports adding at today's price${o.assessment ? ` (${o.assessment.summary.replace(/\.\s*$/, "")})` : ""}, and it has room under the limit you approved`).join(". ");
    why = `${lead}. ${fromSavings ? `That needs ${$(fromSavings)} more than the ${$2(here)} in ${invName}, so it uses part of the ${$(tr.amount)} you authorised from savings; the rest stays in savings.` : tr.amount ? `The cash already in ${invName} covers it, so nothing needs to move from savings.` : ""}`.trim();
  } else {
    const noStock = "No researched stock qualifies for new money right now";
    const savingsLine = tr.amount >= 1 ? ` Keep your savings where they are: nothing justifies a transfer.` : "";
    if (here >= 1) {
      headline = `No transfer from savings. The ${$2(here)} in ${invName}: ${etfAlloc?.symbol ?? etfSym} or keep it as cash`;
      why = `${noStock}, so there is no opportunity that calls for more money.${savingsLine} For the cash already in ${invName}, ${etfAlloc?.symbol ?? etfSym} is the diversified choice (${result.exposure.reasons[0]?.replace(/^[A-Z]+ \(chosen\): /, "").split(". ")[0] ?? "the default diversified fund"}); keeping it as cash is equally valid.`;
    } else {
      headline = tr.amount >= 1 ? "Do nothing now: keep your savings, no transfer" : "Do nothing now";
      why = `${noStock}, and there is no cash in ${invName}.${savingsLine}`;
    }
  }

  // Alternatives: best of each kind, from the same engine run on all authorised money.
  const opt = capacity.options;
  const held = opt.filter((o) => o.kind === "stock")[0];
  const fresh = opt.filter((o) => o.kind === "new_stock").sort((x, y) => Number(y.eligible) - Number(x.eligible))[0];
  const etf = opt.find((o) => o.kind === "etf" && o.symbol === etfSym) ?? opt.find((o) => o.kind === "etf");
  const statusOf = (o: Option) => (o.eligible ? (o.headroomDollars ? `Qualifies · room ${$(o.headroomDollars)}` : "Qualifies") : o.label);
  const reasonOf = (o: Option) => (o.reassessment && o.reassessment.status !== "current" ? o.reassessment.current : o.verdicts ? [o.verdicts.valuation.detail, o.verdicts.limit.detail].join(" ") : o.notes[0] ?? "");
  const others = (k: Option["kind"], first: Option | undefined) => opt.filter((o) => o.kind === k && o !== first).slice(0, 4).map((o) => `${o.symbol} (${o.eligible ? "qualifies" : o.label.toLowerCase()})`);
  const alternatives: Alternative[] = [];
  if (held) alternatives.push({ key: "add", title: `Add to ${held.symbol}`, status: statusOf(held), symbol: held.symbol, href: `/research/${held.symbol}`,
    detail: `${reasonOf(held)}${others("stock", held).length ? ` Other holdings: ${others("stock", held).join(", ")}.` : ""}` });
  if (fresh) alternatives.push({ key: "new", title: `Start ${fresh.symbol}`, status: statusOf(fresh), symbol: fresh.symbol, href: `/research/${fresh.symbol}`,
    detail: `${reasonOf(fresh)}${others("new_stock", fresh).length ? ` Other researched ideas: ${others("new_stock", fresh).join(", ")}.` : ""}` });
  else alternatives.push({ key: "new", title: "Start a new researched position", status: "None ready", symbol: null, href: "/research", detail: "No researched company outside your holdings has approved research and a limit yet." });
  if (etf) alternatives.push({ key: "etf", title: `Buy ${etf.symbol}`, status: etfAlloc ? "In the recommendation" : "Valid option", symbol: etf.symbol, href: `/research/${etf.symbol}`,
    detail: `${etf.notes[0] ?? ""}. ${etf.notes[1] ?? ""}. Moving savings into it is a long-term allocation choice for money you will not need for 10+ years, not an opportunity the app is calling${tr.amount >= 1 ? `; you could move up to ${$(tr.amount)}` : ""}.` });
  alternatives.push({ key: "cash", title: "Keep it in savings or brokerage cash", status: "Always valid", symbol: null, href: null,
    detail: `${opt.find((o) => o.kind === "cash")?.notes[2] ?? "Earns a savings or Treasury rate"}. No stock risk; the right choice for money you may need within a few years. Your ${$(tr.reserve)} reserve is never touched.` });

  const confirm = [
    ...result.gates.filter((g) => !g.ok).map((g) => `${g.label}: ${g.detail}`),
    ...result.toVerify.filter((t) => !result.gates.some((g) => g.detail === t)).slice(0, 4),
    ...(fromSavings ? [`Transfer ${$(fromSavings)} from savings to ${invName} yourself (the app moves no money), and wait until it shows as cash before buying.`] : []),
    ...(fromSavings && !tr.verified ? ["Update your savings balance first; the one on file is old."] : []),
    ...(allocations.length ? ["Check the live price and your buying power in the broker's app before placing any order; the app never trades."] : []),
  ].filter((x, i, a) => a.indexOf(x) === i);

  return {
    headline, why, allocations, status: result.status, alternatives, confirm, result, capacity,
    funding: { brokerage: Math.min(here, allocations.reduce((a, x) => a + x.amount, 0)), fromSavings,
      detail: !allocations.length ? "Nothing to fund." : fromSavings ? `${$2(Math.min(here, total))} already in ${invName}${plannedIn ? ` (including ${$2(plannedIn)} you planned to transfer)` : ""} + ${$(fromSavings)} from savings, of the ${$(tr.amount)} you authorised.` : `Cash already in ${invName}${plannedIn ? ` (including ${$2(plannedIn)} you planned to transfer)` : ""}. Savings untouched.` },
    money: { brokerageCash, brokerageConfirmed: inv?.confirmed ?? true, plannedIn, transferable: tr },
  };
}

/** Reads the newest standing capital preference (model_runs kind "capital_preference"). Earlier rows stay as history. */
export function preferenceFromRow(row: { outputs: unknown; computed_at: string } | null | undefined): CapitalPreference | null {
  const o = (row?.outputs ?? null) as { max_transfer?: unknown; note?: unknown; cleared?: unknown } | null;
  if (!o || o.cleared) return null;
  const n = Number(o.max_transfer);
  return Number.isFinite(n) && n >= 0 ? { maxTransfer: n, setAt: row!.computed_at, note: typeof o.note === "string" ? o.note : null } : null;
}

/** The Current Portfolio decision from a workspace: the one call every page uses, so they cannot disagree. */
export function currentDecisionFor(ws: Workspace, filings: Map<string, FilingsResult>, holdingsConfirmed = false): CurrentDecision {
  return currentPortfolioDecision({
    portfolio: ws.portfolio, research: ws.research, policy: ws.policy, now: ws.now, quotes: ws.quotes, filings, yields: ws.yields,
    rules: ruleRowsOf(ws.policy), transfers: ws.transfers, holdingsConfirmed, preference: ws.capitalPreference,
  });
}
