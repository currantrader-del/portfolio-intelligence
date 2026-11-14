"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { startImprovementCheck } from "@/lib/shadow/proposals";
import { automatedAllowed } from "@/lib/costs/spend";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspace } from "@/lib/workspace-core";
import { fail, type ActionResult } from "@/lib/action-result";
import { checkOwnTrades, MAX_OWN_ACTIVE, type ShadowTrade, type TradeUnit } from "@/lib/shadow/shadow";
import { closeShadowTest, createShadowTest, loadShadowTests } from "@/lib/shadow/store";

const UNITS: TradeUnit[] = ["usd", "pct_holding", "pct_proceeds"];

/** Your own shadow test: a hypothetical change tracked forward from the next market close. It never trades. */
export async function createOwnShadowTest(formData: FormData): Promise<ActionResult> {
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  const rationale = String(formData.get("rationale") ?? "").trim().slice(0, 900);
  if (!name) return fail("Give the test a short name.");
  const trades: ShadowTrade[] = [];
  for (let i = 0; i < 6; i++) {
    const symbol = String(formData.get(`symbol${i}`) ?? "").trim().toUpperCase();
    const raw = String(formData.get(`amount${i}`) ?? "").replace(/[^0-9.]/g, "");
    if (!symbol && !raw) continue;
    const side = formData.get(`side${i}`) === "buy" ? "buy" : "sell";
    const unit = UNITS.find((u) => u === formData.get(`unit${i}`)) ?? "usd";
    trades.push({ side, symbol, amount: Number(raw), unit });
  }
  const db = await createClient();
  const ws = await buildWorkspace(db);
  const problem = checkOwnTrades(trades, new Set(ws.portfolio.holdings.map((h) => h.symbol)));
  if (problem) return fail(problem);
  const active = (await loadShadowTests(db)).filter((e) => !e.close && e.test.origin === "you").length;
  if (active >= MAX_OWN_ACTIVE) return fail(`You already track ${active} of your own tests. Stop one first, so the comparison stays readable.`);
  await createShadowTest(db, ws, { name, origin: "you", rationale, source: { planAt: null, researchVersionId: null, researchAsOf: null, action: null }, trades });
  revalidatePath("/plan");
}

/** Stops tracking a test. Its record and results up to today are kept as history. */
export async function stopShadowTest(formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return fail("Missing test.");
  const db = await createClient();
  const entry = (await loadShadowTests(db)).find((e) => e.test.id === id);
  if (!entry) return fail("That test was not found.");
  if (entry.close) return;
  await closeShadowTest(db, id, "stopped by you");
  revalidatePath("/plan");
}

/** Runs the improvement check now (in the background). The AI review runs only if a trigger holds (about $0.10). */
export async function checkImprovementNow(): Promise<ActionResult> {
  const db = await createClient();
  const { data: s } = await db.auth.getSession();
  if (!s.session?.access_token) return fail("Sign in first.");
  const gate = await automatedAllowed(db, "shadow_proposal");
  if (!gate.ok) return fail(`Not started: ${gate.reason.replace(/^skipped: /, "")}.`);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  try { await startImprovementCheck(db, origin, s.session.access_token); } catch (e) { return fail(`Could not start the check: ${(e as Error).message.slice(0, 160)}`); }
  revalidatePath("/plan");
}
