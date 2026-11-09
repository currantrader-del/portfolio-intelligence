"use server";

import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { fail, type ActionResult } from "@/lib/action-result";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspace } from "@/lib/workspace";
import { CODE_VERSION, dbStatus, newCapital, parseSource, ruleRowsOf } from "@/lib/decision/newCapital";
import { reviewPosition, REVIEW_CODE_VERSION } from "@/lib/decision/review";
import { loadDecisionFilings } from "@/lib/alerts/events";
import { currentDecisionFor } from "@/lib/decision/currentPortfolio";

const ACTIONS = ["followed", "partially_followed", "declined", "deferred", "dismissed"] as const;
type UserAction = (typeof ACTIONS)[number];

function snapshotPrices(ws: Awaited<ReturnType<typeof buildWorkspace>>, symbols: string[]) {
  const out: Record<string, number> = {};
  for (const s of [...symbols, "SPY"]) {
    const q = ws.quotes.get(s);
    const h = ws.portfolio.holdings.find((x) => x.symbol === s);
    const price = q?.price ?? h?.price;
    if (price) out[s] = price;
  }
  return out;
}

async function saveRun(db: Awaited<ReturnType<typeof createClient>>, kind: string, codeVersion: string, inputs: unknown, outputs: unknown) {
  const json = JSON.stringify(inputs);
  const { data, error } = await db
    .from("model_runs")
    .insert({ kind, code_version: codeVersion, inputs, inputs_sha256: createHash("sha256").update(json).digest("hex"), outputs })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Re-runs the calculation on the server (never trusts numbers from the form) and records what the person chose. */
export async function recordNewCapital(formData: FormData): Promise<ActionResult> {
  const mode = formData.get("mode") === "current" ? "current" : "what_if";
  const amount = mode === "current" ? 1 : Number(formData.get("amount"));
  const source = parseSource(formData.get("source"));
  const holdingsConfirmed = formData.get("confirmed") === "1";
  const action = String(formData.get("user_action")) as UserAction;
  const note = String(formData.get("note") ?? "").slice(0, 2000) || null;
  const execution = String(formData.get("execution") ?? "").trim().slice(0, 500);
  if (!(amount > 0) || !ACTIONS.includes(action)) return fail("Choose what you decided first.");

  const db = await createClient();
  const ws = await buildWorkspace(db);
  const filings = await loadDecisionFilings(ws);
  // Current Portfolio mode: the amount and funding come from your accounts and standing limit, never from the form.
  const current = mode === "current" ? currentDecisionFor(ws, filings, holdingsConfirmed) : null;
  const result = current ? current.result : newCapital({ amount, source, holdingsConfirmed, transfers: ws.transfers, portfolio: ws.portfolio, research: ws.research, policy: ws.policy, now: ws.now, quotes: ws.quotes, filings, yields: ws.yields, rules: ruleRowsOf(ws.policy) });
  const symbols = result.options.map((o) => o.symbol).filter((s) => s !== "CASH");
  // Everything the result depended on, with timestamps and sources, so the decision can be audited later.
  const inputs = {
    mode, amount: current ? result.amount : amount, source: current ? "current_portfolio" : source, holdings_confirmed_by_you: holdingsConfirmed, at: ws.now.toISOString(),
    capital_preference: ws.capitalPreference, transferable_savings: current?.money.transferable ?? null,
    holdings: ws.portfolio.holdings.map((h) => ({ s: h.symbol, q: h.quantity, p: h.price, src: h.priceSource, price_as_of: h.priceAsOf, holdings_as_of: h.holdingsAsOf })),
    accounts: ws.portfolio.accounts.map((a) => ({ name: a.name, as_of: a.asOf, source: a.sourceKind, trades_after: a.tradesAfter })),
    cash: ws.portfolio.cashDetail, data_quality: ws.portfolio.quality.status,
    policy: ws.policy?.version ?? null,
    limits: Object.values(ws.policy?.companies ?? {}).map((c) => ({ s: c.symbol, max: c.hardMax, status: c.status ?? null, source: c.source ?? null })),
    assumptions: result.assumptions,
    research: ws.research.filter((r) => r.current).map((r) => ({ s: r.symbol, v: r.current!.id, as_of: r.current!.research_as_of, completeness: r.current!.completeness })),
  };
  const runId = await saveRun(db, "new_capital", CODE_VERSION, inputs, result);
  const topStock = result.recommendation.allocations.find((a) => a.symbol !== "CASH" && symbols.includes(a.symbol));
  const rv = ws.research.find((r) => r.symbol === topStock?.symbol)?.current?.id ?? null;
  const { error } = await db.from("decisions").insert({
    kind: "new_capital",
    symbol: null,
    status: dbStatus(result.status),
    recommendation: { action: current ? `Current portfolio: ${current.headline}` : `New cash ${"$" + amount.toLocaleString()}: ${result.recommendation.headline}`, mode, status: result.status,
      ...(current ? { headline: current.headline, why: current.why, funding: current.funding, projected: current.projected, alternatives_summary: current.alternatives.map((a) => ({ title: a.title, status: a.status })), confirm: current.confirm } : {}), funds: result.funds, exposure: result.exposure, summary: result.recommendation.rationale.join(" "), allocations: current ? current.allocations : result.recommendation.allocations, illustrative: result.recommendation.illustrative, confidence: result.recommendation.confidence, would_change: result.recommendation.wouldChange, gates: result.gates, to_verify: result.toVerify, assumptions: result.assumptions, prices_at_decision: snapshotPrices(ws, symbols) },
    alternatives: result.options.map((o) => ({ symbol: o.symbol, kind: o.kind, label: o.label, expected_return: o.expectedReturn, eligible: o.eligible, notes: o.notes })),
    execution: execution ? { description: execution, recorded_at: new Date().toISOString() } : null,
    model_run_id: runId,
    research_version_id: rv,
    user_action: action,
    user_action_at: new Date().toISOString(),
    user_note: note,
  });
  if (error) throw error;
  revalidatePath("/decisions");
  redirect("/decisions?saved=1");
}

export async function recordReview(formData: FormData): Promise<ActionResult> {
  const symbol = String(formData.get("symbol") ?? "").toUpperCase();
  const chosen = String(formData.get("chosen") ?? "");
  const note = String(formData.get("note") ?? "").slice(0, 2000) || null;
  const db = await createClient();
  const ws = await buildWorkspace(db);
  const review = reviewPosition(ws, symbol, (await loadDecisionFilings({ ...ws, research: [] , portfolio: { holdings: [{ symbol }] } })).get(symbol) ?? null);
  if (!review) return fail(`${symbol || "This position"} is no longer in your portfolio. Reload the page.`);
  const option = review.options.find((o) => o.key === chosen);
  if (!option) return fail("Choose one of the options first.");
  const inputs = { symbol, price: review.price, priceSource: review.priceSource, weight: review.weight, research: review.researchVersionId, at: ws.now.toISOString() };
  const runId = await saveRun(db, "position_review", REVIEW_CODE_VERSION, inputs, review);
  const { error } = await db.from("decisions").insert({
    kind: "alert_review",
    symbol,
    recommendation: { action: `${symbol}: ${review.suggestion.label}`, summary: review.suggestion.reason, suggested: review.suggestion.key, chosen: option.key, chosen_label: option.label, prices_at_decision: snapshotPrices(ws, [symbol]) },
    alternatives: review.options,
    model_run_id: runId,
    research_version_id: review.researchVersionId,
    user_action: option.key === review.suggestion.key ? "followed" : "declined",
    user_action_at: new Date().toISOString(),
    user_note: note,
  });
  if (error) throw error;
  revalidatePath("/decisions");
  redirect("/decisions?saved=1");
}

/**
 * Records a transfer between your own accounts as planned (it moves no money). New-money decisions may then use it,
 * as conditional money, until the receiving account's records show it. Never from the protected reserve.
 */
export async function planTransfer(formData: FormData): Promise<ActionResult> {
  const amount = Math.round(Number(String(formData.get("amount") ?? "").replace(/[$,\s]/g, "")) * 100) / 100;
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "");
  const date = String(formData.get("date") ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (!(amount > 0)) return fail("Enter the amount you plan to transfer.");
  if (!from || !to || from === to) return fail("Choose two different accounts.");
  const ws = await buildWorkspace(await createClient());
  const src = ws.portfolio.cashDetail.accounts.find((a) => a.id === from);
  const dst = ws.portfolio.cashDetail.accounts.find((a) => a.id === to);
  if (!src || !dst) return fail("One of those accounts is not on file.");
  if (!dst.canBuyChosen) return fail(`${dst.name} cannot buy a chosen stock or ETF, so a transfer there does not fund a decision.`);
  if (src.use === "retirement_managed") return fail("Money cannot be taken out of a retirement account for this.");
  const already = ws.transfers.filter((t) => t.fromAccountId === from).reduce((a, t) => a + t.amount, 0);
  const available = src.use === "savings" ? ws.portfolio.cashDetail.deployableSavings - already : src.cash - already;
  if (amount > available + 0.005) return fail(src.use === "savings" ? `Only $${Math.max(0, available).toLocaleString()} of ${src.name} is above your $${ws.portfolio.cashDetail.protectedReserve.toLocaleString()} protected reserve (after transfers already planned).` : `${src.name} holds only $${Math.max(0, available).toLocaleString()} of cash.`);
  const db = await createClient();
  await saveRun(db, "planned_transfer", "transfer@1", { from_account_id: from, to_account_id: to, amount, date, note: String(formData.get("note") ?? "").slice(0, 200) || null }, { from: src.name, to: dst.name });
  revalidatePath("/decisions");
  return;
}

export async function cancelTransfer(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return fail("Missing transfer.");
  const db = await createClient();
  await saveRun(db, "planned_transfer_cancel", "transfer@1", { transfer_id: id }, {});
  revalidatePath("/decisions");
  return;
}

/**
 * Saves your standing capital preference: the most you would move from savings to the brokerage if an opportunity
 * justifies it. A maximum for evaluating opportunities only; it creates no deposit or transfer and is never buying
 * power. A new row each time; earlier ones stay as history.
 */
export async function saveCapitalPreference(formData: FormData): Promise<ActionResult> {
  const clear = formData.get("clear") === "1";
  const raw = String(formData.get("max_transfer") ?? "").replace(/[$,\s]/g, "");
  const max = Math.round(Number(raw));
  if (!clear && !(raw !== "" && max >= 0 && max <= 1_000_000)) return fail("Enter the most you would move from savings, for example 10000.");
  const db = await createClient();
  await saveRun(db, "capital_preference", "capital-preference@1", { max_transfer: clear ? null : max, at: new Date().toISOString() },
    clear ? { cleared: true } : { max_transfer: max, note: "Maximum I am willing to transfer from savings to the brokerage if a sufficiently attractive opportunity is identified. Not buying power; not an instruction to invest." });
  revalidatePath("/", "layout");
}
