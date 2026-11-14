/**
 * Running and reading the recovery-odds calibration check, and computing odds for one stock.
 * Code only: free daily prices, no AI. The check runs in the background (about 40 stocks x 5 years),
 * weekly on Mondays in the morning run and on demand; the result is saved (model_runs "recovery_calibration").
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { save, dispatchJob } from "@/lib/intel/jobs";
import { getHistories, getHistory } from "@/lib/market/history";
import { UNIVERSE } from "@/lib/market/universe";
import { calibrate, CALIBRATION_VERSION, type Calibration } from "./calibrate";
import { HORIZONS, LOOKBACK_DAYS, recoveryOdds, windowReturns, type Odds } from "./sim";

/** A calibration older than this no longer unlocks the odds; the Monday run renews it. */
export const CALIBRATION_FRESH_DAYS = 10;
const CAL_COUNT = 40;

/** A spread of large US companies: every n-th name of the S&P 500 list, so all sectors appear. */
export function calibrationSymbols(n = CAL_COUNT): string[] {
  const step = Math.max(1, Math.floor(UNIVERSE.length / n));
  return UNIVERSE.filter((_, i) => i % step === 0).slice(0, n).map(([s]) => s);
}

export async function startCalibration(db: SupabaseClient, origin: string, token: string, trigger: "manual" | "schedule"): Promise<string> {
  const requestId = await save(db, "recovery_calibration_request", CALIBRATION_VERSION, { trigger, at: new Date().toISOString() }, {});
  await dispatchJob(origin, { job: "recovery", requestId, token });
  return requestId;
}

export async function runCalibrationJob(db: SupabaseClient): Promise<Calibration> {
  const symbols = calibrationSymbols();
  const hist = await getHistories(symbols, "5y");
  const series = [...hist.values()].filter((h) => h.adjusted && h.bars.length > LOOKBACK_DAYS + 120).map((h) => ({ symbol: h.symbol, closes: h.bars.map((b) => b.close) }));
  const result = calibrate(series);
  await save(db, "recovery_calibration", CALIBRATION_VERSION, { symbols: series.map((s) => s.symbol) }, result);
  return result;
}

export async function latestCalibration(db: SupabaseClient): Promise<(Calibration & { fresh: boolean }) | null> {
  const { data } = await db.from("model_runs").select("outputs, computed_at").eq("kind", "recovery_calibration").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const c = data.outputs as Calibration;
  return { ...c, fresh: Date.now() - Date.parse(data.computed_at as string) < CALIBRATION_FRESH_DAYS * 86_400_000 };
}

export type StockOdds = { price: number; priceAsOf: string; odds: Odds[]; historyDays: number; high52: number; low52: number };

/** Odds for one stock at today's price, from its own last two years of adjusted closes. */
export async function oddsFor(symbol: string, pick: (price: number, high52: number) => number[], price: number | null, priceAsOf: string | null): Promise<(StockOdds & { targets: number[] }) | null> {
  const h = await getHistory(symbol, "5y");
  if (!h || !h.adjusted || h.bars.length < LOOKBACK_DAYS / 2) return null;
  const closes = h.bars.map((b) => b.close);
  const p = price ?? closes[closes.length - 1];
  const last = closes.slice(-252);
  const targets = pick(p, Math.max(...last));
  return {
    targets,
    price: p, priceAsOf: priceAsOf ?? h.bars[h.bars.length - 1].date, historyDays: Math.min(LOOKBACK_DAYS, closes.length - 1),
    odds: recoveryOdds({ price: p, returns: windowReturns(closes, closes.length), targets, horizons: HORIZONS, paths: 4000, seed: symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 0) }),
    high52: Math.max(...last), low52: Math.min(...last),
  };
}

/** Default prices to ask about: the 52-week high, and +10%, +25%, +50% from today, rounded. */
export function defaultTargets(price: number, high52: number): number[] {
  const round = (x: number) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
  const xs = [price * 1.1, price * 1.25, price * 1.5, high52].map(round).filter((x) => x > price * 1.02);
  return [...new Set(xs)].sort((a, b) => a - b).slice(0, 5);
}

/** "120, 150, 170" from the page's form; at most 6 prices, each within 0.2x-5x of today. */
export function parseTargets(raw: string | undefined, price: number): number[] | null {
  if (!raw) return null;
  const xs = raw.split(/[ ,;]+/).map((s) => Number(s.replace(/[$]/g, ""))).filter((x) => Number.isFinite(x) && x > price * 0.2 && x < price * 5);
  return xs.length ? [...new Set(xs)].sort((a, b) => a - b).slice(0, 6) : null;
}
