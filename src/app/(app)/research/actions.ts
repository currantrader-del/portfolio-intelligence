"use server";

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

const cleanSymbol = (v: FormDataEntryValue | null) => String(v ?? "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);

/** Adds a ticker to the pipeline as an idea. Existing companies are left as they are. */
export async function addToPipeline(formData: FormData) {
  const symbol = cleanSymbol(formData.get("symbol"));
  if (!symbol) redirect("/research?error=symbol");
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
export async function setStage(formData: FormData) {
  const symbol = cleanSymbol(formData.get("symbol"));
  const stage = String(formData.get("stage") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  if (!isStage(stage)) throw new Error("Unknown stage");
  if (stage === "passed" && !note) redirect(`/research/${symbol}?error=reason`);
  const db = await createClient();
  const { data: c } = await db.from("companies").select("id, stage_history, research_versions(completeness, is_current)").eq("symbol", symbol).single();
  if (!c) throw new Error("Company not found");
  if (stage === "ready" && !(c.research_versions ?? []).some((v: { completeness: string; is_current: boolean }) => v.is_current && v.completeness === "complete")) {
    redirect(`/research/${symbol}?error=ready`);
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
export async function runScreen(formData: FormData) {
  const symbol = cleanSymbol(formData.get("symbol"));
  const [fundamentals, filings, quote] = await Promise.all([getFundamentals(symbol), getFilings(symbol), getQuote(symbol)]);
  const result = screenCompany({ symbol, fundamentals, filings: "error" in filings ? null : filings, price: quote?.price ?? null, priceAsOf: quote?.asOf ?? null });
  const db = await createClient();
  const { data: c } = await db.from("companies").select("id, name, pipeline_stage, stage_history").eq("symbol", symbol).single();
  if (!c) throw new Error("Company not found");
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
export async function checkLatestFiling(formData: FormData) {
  const symbol = cleanSymbol(formData.get("symbol"));
  const db = await createClient();
  const ws = await buildWorkspace(db);
  const record = ws.research.find((r) => r.symbol === symbol);
  if (!record || !(record.current ?? record.latest)) redirect(`/research/${symbol}?error=nofiling`);
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
