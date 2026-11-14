"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { save } from "@/lib/intel/jobs";
import { fail, type ActionResult } from "@/lib/action-result";
import { loadSpend } from "@/lib/costs/spend";

/** Saves the monthly budgets and the approval threshold (a new settings row; earlier ones stay as history). The test settings are kept. */
export async function saveCostSettings(formData: FormData): Promise<ActionResult> {
  const n = (k: string) => Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, ""));
  const next = { everydayMonthly: n("everyday"), researchMonthly: n("research"), approveAbove: n("approve") };
  if (!(next.everydayMonthly >= 1 && next.everydayMonthly <= 500)) return fail("Everyday budget: enter $1 to $500 a month.");
  if (!(next.researchMonthly >= 0 && next.researchMonthly <= 1000)) return fail("Research budget: enter $0 to $1,000 a month.");
  if (!(next.approveAbove >= 0.5 && next.approveAbove <= 100)) return fail("Approval threshold: enter $0.50 to $100.");
  const db = await createClient();
  const before = (await loadSpend(db)).settings;
  await save(db, "cost_settings", "costs@1", { before }, { ...before, ...next });
  revalidatePath("/costs");
}

/**
 * Starts the 30-day test now (your click): from this moment all AI spending counts against one ceiling,
 * with a phone warning at the warning level. Starting again restarts the window.
 */
export async function startEvaluation(formData: FormData): Promise<ActionResult> {
  const n = (k: string) => Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, ""));
  const ceiling = n("ceiling"), warnAt = n("warn");
  if (!(ceiling >= 5 && ceiling <= 200)) return fail("Test ceiling: enter $5 to $200.");
  if (!(warnAt > 0 && warnAt < ceiling)) return fail("Warning level: enter an amount below the ceiling.");
  const db = await createClient();
  const before = (await loadSpend(db)).settings;
  await save(db, "cost_settings", "costs@1", { before, action: "start_evaluation" }, { ...before, evalStart: new Date().toISOString(), evalCeiling: ceiling, evalWarnAt: warnAt });
  revalidatePath("/costs");
  revalidatePath("/");
}
