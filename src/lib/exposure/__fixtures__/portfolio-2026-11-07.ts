/**
 * Brendan's holdings as of the latest statements plus recorded trades (Acorns statements 2026-09-30 + ledger to 2026-11-03;
 * Schwab statement 2026-10-31 + the 2026-11-05 VXUS/AVUV buys), valued at statement or trade prices (no live quotes).
 * Read from the app database on 2026-11-08. Used to validate the exposure engine on the real portfolio.
 */
export const REAL_HOLDINGS = [
  { symbol: "VOO", value: 13495.36 },
  { symbol: "NVDA", value: 5946.0 },
  { symbol: "VXUS", value: 3779.59 },
  { symbol: "AVUV", value: 2485.52 },
  { symbol: "VWO", value: 2449.89 },
  { symbol: "NOW", value: 2102.4 },
  { symbol: "IXUS", value: 2040.91 },
  { symbol: "GOOGL", value: 1960.11 },
  { symbol: "IREN", value: 1532.8 },
  { symbol: "RDDT", value: 1467.68 },
  { symbol: "VHT", value: 686.75 },
  { symbol: "AGG", value: 600.26 },
  { symbol: "IJH", value: 550.91 },
  { symbol: "IJR", value: 311.37 },
  { symbol: "IONQ", value: 300.4 },
  { symbol: "ISTB", value: 247.86 },
];
/** Brokerage cash after the 2026-11-05 buys; USAA savings ($3,000) is the protected reserve and is excluded. */
export const REAL_CASH = 221.24;
