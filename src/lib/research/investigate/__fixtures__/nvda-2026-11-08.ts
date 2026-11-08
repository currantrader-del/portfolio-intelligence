/**
 * Real inputs from the NVIDIA full investigation of 2026-11-08 (research version 14856bc6), copied from
 * the database: the scenario inputs the analyst set, the app's results, and the holdings on file
 * (latest statements plus the trade ledger). Used to reproduce the numbers independently.
 */
import type { ScenarioSpec } from "../valuationCalc";
import type { LedgerEntry, SnapshotInput } from "@/lib/portfolio/engine";

const e = "estimate: as stored in the research";
const src = { revenue: e, multiple: e, tax_rate: e, diluted_shares: e, net_other_income: e, operating_margin: e };
export const NVDA_SPECS: ScenarioSpec[] = [
  { name: "bear", probability: 0.3, method: "pe", inputs: { revenue: 460e9, multiple: 13, tax_rate: 0.17, diluted_shares: 24.0e9, net_other_income: 3e9, operating_margin: 0.55 }, sources: src, rationale: "As stored" },
  { name: "base", probability: 0.5, method: "pe", inputs: { revenue: 760e9, multiple: 17, tax_rate: 0.17, diluted_shares: 23.6e9, net_other_income: 3e9, operating_margin: 0.635 }, sources: src, rationale: "As stored" },
  { name: "bull", probability: 0.2, method: "pe", inputs: { revenue: 903e9, multiple: 21, tax_rate: 0.17, diluted_shares: 23.4e9, net_other_income: 5e9, operating_margin: 0.655 }, sources: src, rationale: "As stored" },
];
export const NVDA_RUN = { price: 186.64, today: "2026-11-08", horizon: "2028-12-31", bear: 115.09, base: 290.33, bull: 444.29, weighted: 268.55, annualized: 0.1847 };

const pos = (symbol: string, quantity: number, price: number, marketValue: number, costBasis: number | null) => ({ symbol, quantity, price, marketValue, costBasis });
export const SNAPSHOTS: SnapshotInput[] = [
  { accountId: "tos", accountName: "Schwab One (Thinkorswim)", accountRole: "taxable_brokerage", asOf: "2026-10-31T21:00:00Z", sourceKind: "statement", totalValue: 31458.3, cashValue: 82.2, positions: [
    pos("GOOGL", 7.0044, 279.84, 1960.11, 2431.93), pos("IONQ", 10, 30.04, 300.4, 563.9), pos("IREN", 64, 23.95, 1532.8, 2649.08), pos("NVDA", 29.0559, 204.64, 5946, 6136.38),
    pos("RDDT", 16, 91.73, 1467.68, 2500.84), pos("NOW", 20, 105.12, 2102.4, 1880.6), pos("AVUV", 17.0235, 123.43, 2101.21, 2093.6), pos("VWO", 44.1343, 55.51, 2449.89, 2552.01),
    pos("VHT", 2.0061, 342.33, 686.75, 614.18), pos("VOO", 14.0705, 694.81, 9776.32, 9527.77), pos("VXUS", 37.0589, 82.37, 3052.54, 3148.35)] },
  { accountId: "acorns", accountName: "Acorns Invest", accountRole: "taxable_brokerage", asOf: "2026-09-30T21:00:00Z", sourceKind: "statement", totalValue: 4127.97, cashValue: 5, positions: [
    pos("AGG", 6.0092, 94.54, 568.11, null), pos("IJH", 3.30201, 71.95, 237.58, null), pos("IJR", 1.11573, 136.04, 151.78, null), pos("ISTB", 5.079, 47.25, 239.98, null), pos("IXUS", 10.49964, 94.99, 997.36, null), pos("VOO", 2.75112, 700.86, 1928.15, null)] },
  { accountId: "usaa", accountName: "USAA Savings", accountRole: "cash", asOf: "2026-11-07T13:03:00Z", sourceKind: "manual", totalValue: 3000, cashValue: 3000, positions: [] },
  { accountId: "roth", accountName: "Acorns Later (Roth IRA)", accountRole: "retirement", asOf: "2026-09-30T21:00:00Z", sourceKind: "statement", totalValue: 2810.42, cashValue: 3.97, positions: [
    pos("IJH", 4.05658, 71.95, 291.87, null), pos("IJR", 1.17309, 136.04, 159.59, null), pos("IXUS", 8.71958, 94.99, 828.27, null), pos("VOO", 2.17836, 700.86, 1526.72, null)] },
];

const t = (accountId: string, tradeDate: string, kind: LedgerEntry["kind"], symbol: string | null, quantity: number | null, price: number | null, amount: number) => ({ accountId, tradeDate, kind, symbol, quantity, price, amount }) as LedgerEntry;
export const LEDGER: LedgerEntry[] = [
  t("acorns", "2026-10-26", "deposit", null, null, null, 6.45), t("acorns", "2026-10-26", "buy", "VOO", 0.009181, 702.57, -6.45), t("acorns", "2026-10-26", "deposit", null, null, null, 5.01), t("acorns", "2026-10-26", "buy", "VOO", 0.007131, 702.57, -5.01),
  t("acorns", "2026-10-26", "deposit", null, null, null, 30), t("acorns", "2026-10-26", "buy", "VOO", 0.0427, 702.57, -30), t("acorns", "2026-11-03", "deposit", null, null, null, 6.06), t("acorns", "2026-11-03", "buy", "VOO", 0.008727, 694.37, -6.06),
  t("acorns", "2026-10-14", "deposit", null, null, null, 6.57), t("acorns", "2026-10-14", "buy", "VOO", 0.00925, 710.3, -6.57), t("acorns", "2026-10-13", "deposit", null, null, null, 30), t("acorns", "2026-10-13", "buy", "IXUS", 0.317696, 94.43, -30),
  t("acorns", "2026-10-13", "deposit", null, null, null, 8.07), t("acorns", "2026-10-13", "buy", "IXUS", 0.08546, 94.43, -8.07), t("acorns", "2026-10-19", "deposit", null, null, null, 30), t("acorns", "2026-10-19", "buy", "VOO", 0.042481, 706.2, -30),
  t("acorns", "2026-10-19", "deposit", null, null, null, 12.39), t("acorns", "2026-10-19", "buy", "VOO", 0.017545, 706.2, -12.39), t("acorns", "2026-10-05", "deposit", null, null, null, 30), t("acorns", "2026-10-05", "buy", "AGG", 0.31881, 94.1, -30),
  t("acorns", "2026-10-01", "buy", "VOO", 0.007143, 700.01, -5), t("acorns", "2026-10-07", "deposit", null, null, null, 6.99), t("acorns", "2026-10-07", "buy", "ISTB", 0.148102, 47.2, -6.99), t("acorns", "2026-10-07", "dividend", "ISTB", null, null, 0.88),
  t("acorns", "2026-10-07", "buy", "ISTB", 0.018645, 47.2, -0.88), t("acorns", "2026-10-07", "dividend", "AGG", null, null, 2), t("acorns", "2026-10-07", "buy", "AGG", 0.021227, 94.22, -2), t("acorns", "2026-11-02", "deposit", null, null, null, 30),
  t("acorns", "2026-11-02", "buy", "IXUS", 0.32144, 93.33, -30), t("acorns", "2026-10-23", "deposit", null, null, null, 7.65), t("acorns", "2026-10-23", "buy", "IJH", 0.106265, 71.99, -7.65),
  t("tos", "2026-11-05", "deposit", null, null, null, 1250), t("tos", "2026-11-05", "buy", "VXUS", 1, 82.085, -82.09), t("tos", "2026-11-05", "buy", "VXUS", 8, 82.06, -656.48), t("tos", "2026-11-05", "buy", "AVUV", 3, 124.13, -372.39),
  t("roth", "2026-10-01", "buy", "VOO", 0.005671, 700.01, -3.97), t("roth", "2026-10-05", "deposit", null, null, null, 30), t("roth", "2026-10-05", "buy", "IXUS", 0.312728, 95.93, -30), t("roth", "2026-10-13", "deposit", null, null, null, 30),
  t("roth", "2026-10-13", "buy", "VOO", 0.041943, 715.26, -30), t("roth", "2026-10-19", "deposit", null, null, null, 30), t("roth", "2026-10-19", "buy", "IXUS", 0.320513, 93.6, -30), t("roth", "2026-10-22", "deposit", null, null, null, 200),
  t("roth", "2026-10-22", "buy", "IJH", 0.192031, 72.28, -13.88), t("roth", "2026-10-22", "buy", "IXUS", 0.584108, 92.5, -54.03), t("roth", "2026-10-22", "buy", "VOO", 0.188467, 700.87, -132.09), t("roth", "2026-10-26", "deposit", null, null, null, 30),
  t("roth", "2026-10-26", "buy", "IXUS", 0.324359, 92.49, -30), t("roth", "2026-11-02", "deposit", null, null, null, 30), t("roth", "2026-11-02", "buy", "VOO", 0.042876, 699.69, -30),
];
