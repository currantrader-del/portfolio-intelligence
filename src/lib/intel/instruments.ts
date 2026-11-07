/**
 * The fixed market panel the daily briefing reads. Free Yahoo chart data: index levels are
 * delayed (often 15 minutes for some exchanges), futures are front-month continuous contracts.
 * Rates are CBOE yield indices quoted in percent, so their change is shown in basis points.
 */
export type Group = "us_equity" | "intl_equity" | "rates" | "fx" | "commodities" | "volatility" | "credit" | "crypto" | "sector";
export type Instrument = { symbol: string; label: string; group: Group; kind: "price" | "yield" };

export const INSTRUMENTS: Instrument[] = [
  { symbol: "^GSPC", label: "S&P 500", group: "us_equity", kind: "price" },
  { symbol: "^IXIC", label: "Nasdaq Composite", group: "us_equity", kind: "price" },
  { symbol: "^DJI", label: "Dow Jones Industrial", group: "us_equity", kind: "price" },
  { symbol: "^RUT", label: "Russell 2000", group: "us_equity", kind: "price" },
  { symbol: "RSP", label: "S&P 500 equal weight (ETF)", group: "us_equity", kind: "price" },
  { symbol: "SPY", label: "S&P 500 (ETF)", group: "us_equity", kind: "price" },
  { symbol: "^STOXX50E", label: "Euro Stoxx 50", group: "intl_equity", kind: "price" },
  { symbol: "^FTSE", label: "FTSE 100", group: "intl_equity", kind: "price" },
  { symbol: "^GDAXI", label: "DAX", group: "intl_equity", kind: "price" },
  { symbol: "^N225", label: "Nikkei 225", group: "intl_equity", kind: "price" },
  { symbol: "^HSI", label: "Hang Seng", group: "intl_equity", kind: "price" },
  { symbol: "000001.SS", label: "Shanghai Composite", group: "intl_equity", kind: "price" },
  { symbol: "EEM", label: "Emerging markets (ETF)", group: "intl_equity", kind: "price" },
  { symbol: "^IRX", label: "US 13-week T-bill yield", group: "rates", kind: "yield" },
  { symbol: "^FVX", label: "US 5-year yield", group: "rates", kind: "yield" },
  { symbol: "^TNX", label: "US 10-year yield", group: "rates", kind: "yield" },
  { symbol: "^TYX", label: "US 30-year yield", group: "rates", kind: "yield" },
  { symbol: "DX-Y.NYB", label: "US dollar index", group: "fx", kind: "price" },
  { symbol: "EURUSD=X", label: "EUR/USD", group: "fx", kind: "price" },
  { symbol: "JPY=X", label: "USD/JPY", group: "fx", kind: "price" },
  { symbol: "CNY=X", label: "USD/CNY", group: "fx", kind: "price" },
  { symbol: "CL=F", label: "WTI crude oil", group: "commodities", kind: "price" },
  { symbol: "BZ=F", label: "Brent crude oil", group: "commodities", kind: "price" },
  { symbol: "NG=F", label: "US natural gas", group: "commodities", kind: "price" },
  { symbol: "GC=F", label: "Gold", group: "commodities", kind: "price" },
  { symbol: "HG=F", label: "Copper", group: "commodities", kind: "price" },
  { symbol: "^VIX", label: "VIX (S&P 500 implied volatility)", group: "volatility", kind: "price" },
  { symbol: "^MOVE", label: "MOVE (Treasury implied volatility)", group: "volatility", kind: "price" },
  { symbol: "HYG", label: "High-yield corporate bonds (ETF)", group: "credit", kind: "price" },
  { symbol: "LQD", label: "Investment-grade corporate bonds (ETF)", group: "credit", kind: "price" },
  { symbol: "TLT", label: "20+ year Treasuries (ETF)", group: "credit", kind: "price" },
  { symbol: "BTC-USD", label: "Bitcoin", group: "crypto", kind: "price" },
  { symbol: "XLK", label: "Technology", group: "sector", kind: "price" },
  { symbol: "XLC", label: "Communication services", group: "sector", kind: "price" },
  { symbol: "XLY", label: "Consumer discretionary", group: "sector", kind: "price" },
  { symbol: "XLP", label: "Consumer staples", group: "sector", kind: "price" },
  { symbol: "XLE", label: "Energy", group: "sector", kind: "price" },
  { symbol: "XLF", label: "Financials", group: "sector", kind: "price" },
  { symbol: "XLV", label: "Health care", group: "sector", kind: "price" },
  { symbol: "XLI", label: "Industrials", group: "sector", kind: "price" },
  { symbol: "XLB", label: "Materials", group: "sector", kind: "price" },
  { symbol: "XLRE", label: "Real estate", group: "sector", kind: "price" },
  { symbol: "XLU", label: "Utilities", group: "sector", kind: "price" },
  { symbol: "SMH", label: "Semiconductors (industry ETF)", group: "sector", kind: "price" },
];

export const GROUP_LABEL: Record<Group, string> = {
  us_equity: "US equities", intl_equity: "International equities", rates: "Treasury yields", fx: "Currencies",
  commodities: "Commodities", volatility: "Volatility", credit: "Bonds and credit", crypto: "Crypto", sector: "US sectors and industries",
};

/** US macro series from FRED (public CSV endpoint, no key). Each carries its own release lag. */
export type MacroSpec = { id: string; label: string; transform: "level" | "yoy" | "mom_change" | "qoq_saar"; unit: "%" | "pts" | "k" | "index" | "bp" };
export const MACRO: MacroSpec[] = [
  { id: "DFF", label: "Effective federal funds rate", transform: "level", unit: "%" },
  { id: "DGS2", label: "2-year Treasury yield (daily close)", transform: "level", unit: "%" },
  { id: "DGS10", label: "10-year Treasury yield (daily close)", transform: "level", unit: "%" },
  { id: "T10Y2Y", label: "10-year minus 2-year spread", transform: "level", unit: "%" },
  { id: "T5YIE", label: "5-year breakeven inflation", transform: "level", unit: "%" },
  { id: "BAMLH0A0HYM2", label: "High-yield option-adjusted spread", transform: "level", unit: "%" },
  { id: "NFCI", label: "Chicago Fed financial conditions (NFCI, below 0 = looser than average)", transform: "level", unit: "index" },
  { id: "CPIAUCSL", label: "CPI inflation, year over year", transform: "yoy", unit: "%" },
  { id: "CPILFESL", label: "Core CPI inflation, year over year", transform: "yoy", unit: "%" },
  { id: "PCEPILFE", label: "Core PCE inflation, year over year", transform: "yoy", unit: "%" },
  { id: "UNRATE", label: "Unemployment rate", transform: "level", unit: "%" },
  { id: "PAYEMS", label: "Nonfarm payrolls, monthly change", transform: "mom_change", unit: "k" },
  { id: "ICSA", label: "Initial jobless claims (weekly)", transform: "level", unit: "k" },
  { id: "GDPC1", label: "Real GDP growth, quarter annualized", transform: "qoq_saar", unit: "%" },
  { id: "UMCSENT", label: "University of Michigan consumer sentiment", transform: "level", unit: "index" },
];
