"use server";

import { provisionalItems } from "@/lib/research/review";
import type { ValidationReport } from "@/lib/research/validate";
import { AGE_REMINDER_DAYS } from "@/lib/policy/limits";
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFilings, getFundamentals } from "@/lib/market/sec";
import { getQuote } from "@/lib/market/quotes";
import { isStage, screenCompany, STAGES } from "@/lib/research/screen";
import { buildWorkspace } from "@/lib/workspace";
import { runFilingCheck } from "@/lib/research/runFilingCheck";
import { FILING_CHECK_VERSION } from "@/lib/research/filingCheck";
import { fail, type ActionResult } from "@/lib/action-result";
import { save } from "@/lib/intel/jobs";
import { authorityOf, isAuthoritative } from "@/lib/research/standing";
import type { VersionRow } from "@/lib/research/records";

const cleanSymbol = (v: FormDataEntryValue | null) => String(v ?? "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);

/** Adds a ticker to the pipeline as an idea. Existing companies are left as they are. */
export async function addToPipeline(formData: FormData): Promise<ActionResult> {
  const symbol = cleanSymbol(formData.get("symbol"));
  if (!symbol) return fail("Enter a ticker, for example MSFT.");
  const db = await createClient();
  const { data: existing } = await db.from("companies").select("symbol").eq("symbol", symbol).maybeSingle();
  if (!existing) {
    const note = String(formData.get("note") ?? "").trim().slice(0, 300) || null;
    const at = new Date().toISOString();
    const { error } = await db.from("companies").insert({
      symbol, name: null, watchlist_status: "watch", pipeline_stage: "idea", pipeline_note: note, stage_updated_at: at,
      stage_history: [{ stage: "idea", at, note: note ?? "Added in the app" }],
    });
    if (error) throw error;
  }
  revalidatePath("/research");
  redirect(`/research/${symbol}`);
}

/**
 * Moves a company to another stage and appends to its history. Passing needs a reason, and
 * "Ready for decision" needs complete research marked current.
 */
export async function setStage(formData: FormData): Promise<ActionResult> {
  const symbol = cleanSymbol(formData.get("symbol"));
  const stage = String(formData.get("stage") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  if (!isStage(stage)) return fail("Choose a stage.");
  if (stage === "passed" && !note) return fail("Add a short reason before passing on a company.");
  const db = await createClient();
  const { data: c } = await db.from("companies").select("id, stage_history, research_versions(id, research_as_of, created_at, origin, completeness, is_current, conclusion)").eq("symbol", symbol).single();
  if (!c) return fail(`${symbol} isn't in your list yet. Add it first.`);
  if (stage === "ready" && !(c.research_versions ?? []).some((v: VersionRow) => v.is_current && isAuthoritative(authorityOf(v)))) {
    return fail("Ready for decision needs research you approved. Run a full investigation and approve it first.");
  }
  const at = new Date().toISOString();
  const label = STAGES.find((s) => s.key === stage)!.label;
  const history = [...((c.stage_history as unknown[]) ?? []), { stage, at, note: note || `Moved to ${label}` }];
  const { error } = await db.from("companies").update({ pipeline_stage: stage, pipeline_note: note || null, stage_updated_at: at, stage_history: history }).eq("id", c.id);
  if (error) throw error;
  revalidatePath("/research");
  revalidatePath(`/research/${symbol}`);
  redirect(`/research/${symbol}?saved=stage`);
}

/** Runs the deterministic screen and stores the dated result on the company. An idea moves to Screening. */
export async function runScreen(formData: FormData): Promise<ActionResult> {
  const symbol = cleanSymbol(formData.get("symbol"));
  const [fundamentals, filings, quote] = await Promise.all([getFundamentals(symbol), getFilings(symbol), getQuote(symbol)]);
  const result = screenCompany({ symbol, fundamentals, filings: "error" in filings ? null : filings, price: quote?.price ?? null, priceAsOf: quote?.asOf ?? null });
  const db = await createClient();
  const { data: c } = await db.from("companies").select("id, name, pipeline_stage, stage_history").eq("symbol", symbol).single();
  if (!c) return fail(`${symbol} isn't in your list yet. Add it first.`);
  const update: Record<string, unknown> = { screen: result, screened_at: result.computedAt };
  if (!c.name && !("error" in fundamentals) && fundamentals.company) update.name = fundamentals.company;
  if (c.pipeline_stage === "idea") {
    update.pipeline_stage = "screening";
    update.stage_updated_at = result.computedAt;
    update.stage_history = [...((c.stage_history as unknown[]) ?? []), { stage: "screening", at: result.computedAt, note: `Screened: ${result.verdict}` }];
  }
  const { error } = await db.from("companies").update(update).eq("id", c.id);
  if (error) throw error;
  revalidatePath("/research");
  revalidatePath(`/research/${symbol}`);
  redirect(`/research/${symbol}?saved=screen`);
}

/**
 * Reads the newest 10-Q/10-K filed after the stored research from SEC EDGAR, compares it with that
 * research and stores the dated result (inputs, hash and output) in model_runs. Never writes research.
 */
export async function checkLatestFiling(formData: FormData): Promise<ActionResult> {
  const symbol = cleanSymbol(formData.get("symbol"));
  const db = await createClient();
  const ws = await buildWorkspace(db);
  const record = ws.research.find((r) => r.symbol === symbol);
  if (!record || !(record.current ?? record.latest)) return fail("There is no stored research to check a filing against.");
  const q = ws.quotes.get(symbol);
  const h = ws.portfolio.holdings.find((x) => x.symbol === symbol);
  const price = q?.price ?? h?.price ?? null;
  const priceAsOf = q?.asOf ?? h?.priceAsOf ?? null;
  const freshDays = AGE_REMINDER_DAYS;
  const { check, basis } = await runFilingCheck({ record: record!, price, priceAsOf, now: ws.now, freshDays });
  const inputs = { symbol, at: ws.now.toISOString(), research_version: basis.versionId, research_as_of: basis.researchAsOf, price, price_as_of: priceAsOf, price_source: q ? q.provider : h ? h.priceSource : null, fresh_days: freshDays, sources: check.sources.map((s) => s.url) };
  const { error } = await db.from("model_runs").insert({ kind: "research_filing_check", code_version: FILING_CHECK_VERSION, inputs, inputs_sha256: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"), outputs: check });
  if (error) throw error;
  revalidatePath(`/research/${symbol}`);
  redirect(`/research/${symbol}?saved=filing`);
}

/**
 * Makes an investigation the research in use, only at the investor's request. A complete investigation
 * is approved in full. An incomplete one can only be approved provisionally, with the investor
 * acknowledging its open items: they stay listed on the record and keep new money off the company until
 * they are resolved. The research it replaces stays on file unchanged (only its "current" flag moves),
 * and the decision is logged (model_runs "research_adoption") with what it replaced.
 */
export async function adoptResearch(formData: FormData): Promise<ActionResult> {
  const symbol = cleanSymbol(formData.get("symbol"));
  const versionId = String(formData.get("versionId") ?? "");
  const db = await createClient();
  const { data: v } = await db.from("research_versions").select("id, company_id, conclusion, completeness, is_current").eq("id", versionId).maybeSingle();
  if (!v) return fail("That research record was not found.");
  const c = (v.conclusion ?? {}) as Record<string, unknown>;
  if (v.is_current) return fail("This research is already the one in use.");
  if (c.review_state !== "awaiting_approval") return fail("Only a finished investigation waiting for your decision can be approved.");
  // A complete record can still be approved provisionally: its reviewer caveats become the open items.
  const complete = v.completeness === "complete" && formData.get("mode") !== "provisional";
  let open = Array.isArray((c.completion as { reasons?: unknown } | undefined)?.reasons) ? ((c.completion as { reasons: unknown[] }).reasons.map(String)) : [];
  if (!complete) {
    if (formData.get("acknowledge") !== "yes") return fail(v.completeness === "complete" ? "Tick the box to confirm you have read the reviewer caveats before approving provisionally." : "This investigation is incomplete. Tick the box to confirm you have read its open items before approving it provisionally.");
    const { data: val } = await db.from("model_runs").select("outputs").eq("kind", "research_validation").eq("inputs->>version_id", v.id).order("computed_at", { ascending: false }).limit(1).maybeSingle();
    open = [...open, ...provisionalItems((val?.outputs ?? null) as ValidationReport | null)];
    if (!open.length) open = ["Approved provisionally by you, pending your own review."];
  }
  const { data: prior } = await db.from("research_versions").select("id, research_as_of").eq("company_id", v.company_id).eq("is_current", true).maybeSingle();
  const at = new Date().toISOString();
  const mode = complete ? "full" : "provisional";
  const { error: e1 } = await db.from("research_versions").update({ is_current: false }).eq("company_id", v.company_id).eq("is_current", true);
  if (e1) return fail(`Could not retire the research in use: ${e1.message}`);
  const { error: e2 } = await db.from("research_versions").update({ is_current: true, conclusion: { ...c, review_state: complete ? "adopted" : "adopted_provisional", adopted_at: at, adoption: { mode, at, open_items: open, replaced: prior?.id ?? null, recommendation_approved: false } } }).eq("id", v.id);
  if (e2) {
    // Put the earlier record back in use rather than leave the company with none.
    if (prior) await db.from("research_versions").update({ is_current: true }).eq("id", prior.id);
    return fail(`Could not approve it: ${e2.message}`);
  }
  await save(db, "research_adoption", "adoption@1", { symbol, version_id: v.id, mode, at }, { replaced: prior ? { id: prior.id, research_as_of: prior.research_as_of } : null, open_items: open, action: c.action ?? null }).catch(() => null);
  revalidatePath("/research");
  revalidatePath(`/research/${symbol}`);
  revalidatePath("/");
  redirect(`/research/${symbol}?saved=${complete ? "adopted" : "provisional"}`);
}

/**
 * Keeps the research in use and sets a finished investigation aside, at the investor's request. The
 * investigation stays on file (marked "set aside"); nothing else changes. Logged like an approval.
 */
export async function setAsideResearch(formData: FormData): Promise<ActionResult> {
  const symbol = cleanSymbol(formData.get("symbol"));
  const versionId = String(formData.get("versionId") ?? "");
  const db = await createClient();
  const { data: v } = await db.from("research_versions").select("id, conclusion, is_current").eq("id", versionId).maybeSingle();
  if (!v) return fail("That research record was not found.");
  const c = (v.conclusion ?? {}) as Record<string, unknown>;
  if (v.is_current || c.review_state !== "awaiting_approval") return fail("Only an investigation waiting for your decision can be set aside.");
  const at = new Date().toISOString();
  const { error } = await db.from("research_versions").update({ conclusion: { ...c, review_state: "set_aside", set_aside_at: at } }).eq("id", v.id);
  if (error) return fail(`Could not set it aside: ${error.message}`);
  await save(db, "research_adoption", "adoption@1", { symbol, version_id: v.id, mode: "set_aside", at }, {}).catch(() => null);
  revalidatePath("/research");
  revalidatePath(`/research/${symbol}`);
  revalidatePath("/");
  redirect(`/research/${symbol}?saved=set_aside`);
}
