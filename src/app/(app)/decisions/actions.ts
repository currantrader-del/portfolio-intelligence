"use server";

import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspace } from "@/lib/workspace";
import { CODE_VERSION, newCapital } from "@/lib/decision/newCapital";
import { reviewPosition, REVIEW_CODE_VERSION } from "@/lib/decision/review";

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
export async function recordNewCapital(formData: FormData) {
  const amount = Number(formData.get("amount"));
  const action = String(formData.get("user_action")) as UserAction;
  const note = String(formData.get("note") ?? "").slice(0, 2000) || null;
  if (!(amount > 0) || !ACTIONS.includes(action)) throw new Error("Invalid decision");

  const db = await createClient();
  const ws = await buildWorkspace(db);
  const result = newCapital({ amount, portfolio: ws.portfolio, research: ws.research, policy: ws.policy, now: ws.now });
  const symbols = result.options.map((o) => o.symbol).filter((s) => s !== "CASH");
  const inputs = { amount, holdings: ws.portfolio.holdings.map((h) => ({ s: h.symbol, q: h.quantity, p: h.price, src: h.priceSource })), cash: ws.portfolio.cash, policy: ws.policy?.version ?? null, research: ws.research.filter((r) => r.current).map((r) => ({ s: r.symbol, v: r.current!.id })), at: ws.now.toISOString() };
  const runId = await saveRun(db, "new_capital", CODE_VERSION, inputs, result);
  const topStock = result.recommendation.allocations.find((a) => a.symbol !== "CASH" && symbols.includes(a.symbol));
  const rv = ws.research.find((r) => r.symbol === topStock?.symbol)?.current?.id ?? null;
  const { error } = await db.from("decisions").insert({
    kind: "new_capital",
    symbol: null,
    recommendation: { action: `New cash ${"$" + amount.toLocaleString()}: ${result.recommendation.headline}`, summary: result.recommendation.rationale.join(" "), allocations: result.recommendation.allocations, confidence: result.recommendation.confidence, would_change: result.recommendation.wouldChange, prices_at_decision: snapshotPrices(ws, symbols) },
    alternatives: result.options.map((o) => ({ symbol: o.symbol, kind: o.kind, expected_return: o.expectedReturn, eligible: o.eligible, notes: o.notes })),
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

export async function recordReview(formData: FormData) {
  const symbol = String(formData.get("symbol") ?? "").toUpperCase();
  const chosen = String(formData.get("chosen") ?? "");
  const note = String(formData.get("note") ?? "").slice(0, 2000) || null;
  const db = await createClient();
  const ws = await buildWorkspace(db);
  const review = reviewPosition(ws, symbol);
  if (!review) throw new Error("Position not found");
  const option = review.options.find((o) => o.key === chosen);
  if (!option) throw new Error("Invalid option");
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
