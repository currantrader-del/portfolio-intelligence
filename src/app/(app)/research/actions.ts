"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFilings, getFundamentals } from "@/lib/market/sec";
import { getQuote } from "@/lib/market/quotes";
import { isStage, screenCompany, STAGES } from "@/lib/research/screen";

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
