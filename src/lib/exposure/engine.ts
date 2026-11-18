/**
 * Portfolio exposure with ETF look-through. Pure and deterministic: the same holdings and reference
 * data always give the same numbers.
 *
 * How it avoids double counting:
 *  - Each dollar is counted once per dimension. An ETF's dollars are split across sectors, countries
 *    and companies by the fund's published weights; the ETF itself is never counted beside its parts.
 *  - Each dimension (asset class, sector, industry, country, market, region, size, style, cycle) adds
 *    up to 100% of its base on its own, with a "not itemized" line for what the sources don't break down.
 *  - Themes overlap by design (one company can be in several), so theme percentages are never summed.
 *  - Industries and themes come from classified companies only (direct holdings and the funds' largest
 *    holdings), so they are lower bounds. The engine also gives an upper bound: the part of each fund's
 *    sector weight that is not yet assigned to a known company could belong to that industry.
 *
 * Direct = shares owned. Indirect = through funds (economic exposure, not ownership).
 */
import { BENCHMARK, COMPANIES, COUNTRY, FUNDS, GICS_SECTORS, SUPER_SECTOR, THEMES, canonical, type FundProfile, type SourceRef, type ThemeKey } from "./reference";

export type HoldingIn = { symbol: string; value: number };
export type Contribution = { via: string; value: number }; // via = the holding's own symbol (direct) or the fund's
export type Line = {
  key: string;
  value: number;
  direct: number;
  indirect: number;
  pct: number; // of the dimension's base
  /** Largest value this line could have if every not-itemized dollar that could belong here did. */
  upper?: number;
  upperPct?: number;
  benchmarkPct?: number | null;
  contributors: Contribution[];
};
export type Dimension = {
  key: DimensionKey;
  label: string;
  base: "investable" | "equity";
  baseValue: number;
  lines: Line[];
  notItemized: number;
  notItemizedPct: number;
  additive: boolean;
  notes: string[];
};
export type DimensionKey = "asset" | "sector" | "industry" | "theme" | "country" | "market" | "region" | "size" | "style" | "cycle" | "company";

export type FundOverlap = { a: string; b: string; countryOverlap: number; holdingsOverlap: number; note: string };
export type SourceAge = { fund: string; what: string; source: SourceRef; ageDays: number; stale: boolean };

export type ExposureReport = {
  computedAt: string;
  investable: number;
  equity: number;
  bonds: number;
  cash: number;
  dims: Record<DimensionKey, Dimension>;
  overlaps: FundOverlap[];
  concentration: { top10Pct: number; top10: { symbol: string; pct: number }[]; benchmarkTop10: number };
  rates: { bondDollarDuration: number; bondValue: number; per1pt: number; growthEquityPct: number; smallCapPct: number; notes: string[] };
  sources: SourceAge[];
  gaps: string[];
  unclassified: string[];
};

export const STALE_DAYS = 75; // fund data older than this (about two monthly updates) is flagged

const add = (m: Map<string, Line>, key: string, v: number, via: string, direct: boolean) => {
  if (!v) return;
  const l = m.get(key) ?? { key, value: 0, direct: 0, indirect: 0, pct: 0, contributors: [] };
  l.value += v;
  if (direct) l.direct += v; else l.indirect += v;
  const c = l.contributors.find((x) => x.via === via);
  if (c) c.value += v; else l.contributors.push({ via, value: v });
  m.set(key, l);
};

const ageDays = (asOf: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(`${asOf}T00:00:00Z`).getTime()) / 86_400_000));

export function computeExposure(holdingsIn: HoldingIn[], cash: number, now: Date = new Date()): ExposureReport {
  // Merge share classes and duplicate rows (same company in several accounts).
  const merged = new Map<string, number>();
  for (const h of holdingsIn) if (h.value) merged.set(canonical(h.symbol), (merged.get(canonical(h.symbol)) ?? 0) + h.value);
  const holdings = [...merged.entries()].map(([symbol, value]) => ({ symbol, value }));

  const fundOf = (s: string): FundProfile | undefined => FUNDS[s];
  const bonds = holdings.filter((h) => fundOf(h.symbol)?.assetClass === "bond").reduce((a, h) => a + h.value, 0);
  const equityHoldings = holdings.filter((h) => fundOf(h.symbol)?.assetClass !== "bond");
  const equity = equityHoldings.reduce((a, h) => a + h.value, 0);
  const investable = equity + bonds + cash;
  const unclassified = equityHoldings.filter((h) => !fundOf(h.symbol) && !COMPANIES[h.symbol]).map((h) => h.symbol);

  const maps: Record<DimensionKey, Map<string, Line>> = { asset: new Map(), sector: new Map(), industry: new Map(), theme: new Map(), country: new Map(), market: new Map(), region: new Map(), size: new Map(), style: new Map(), cycle: new Map(), company: new Map() };
  const notIt: Record<DimensionKey, number> = { asset: 0, sector: 0, industry: 0, theme: 0, country: 0, market: 0, region: 0, size: 0, style: 0, cycle: 0, company: 0 };
  // Not-itemized dollars that could still belong to a given sector (for industry upper bounds).
  const sectorResidual = new Map<string, number>(); // sector or "*" (any sector)
  let intlCountryResidual = 0; // international fund dollars with no country itemized
  const countryRest: { fund: string; itemized: Set<string>; rest: number; cap: number }[] = [];

  add(maps.asset, "Stocks", equity, "stocks", true);
  if (bonds) add(maps.asset, "Bonds", bonds, "bonds", true);
  if (cash) add(maps.asset, "Cash", cash, "cash", true);

  for (const h of equityHoldings) {
    const f = fundOf(h.symbol);
    if (!f) {
      const co = COMPANIES[h.symbol];
      if (!co) {
        // Unknown company: it is still one company (company line), but every other split is not itemized.
        for (const k of Object.keys(notIt) as DimensionKey[]) if (k !== "asset" && k !== "company" && k !== "theme") notIt[k] += h.value;
        add(maps.company, h.symbol, h.value, h.symbol, true);
        sectorResidual.set("*", (sectorResidual.get("*") ?? 0) + h.value);
        continue;
      }
      classifyCompany(maps, h.symbol, h.value, h.symbol, true);
      add(maps.size, co.size, h.value, h.symbol, true);
      add(maps.style, co.style, h.value, h.symbol, true);
      add(maps.company, h.symbol, h.value, h.symbol, true);
      continue;
    }
    // Fund: sectors
    let sectorSum = 0;
    const published = GICS_SECTORS.reduce((a, s) => a + (f.sectors?.[s] ?? 0), 0);
    const scale = published > 1 ? 1 / published : 1; // fact sheets round to 0.1%, so a split can add up to 100.1%
    for (const s of GICS_SECTORS) {
      const w = (f.sectors?.[s] ?? 0) * scale;
      if (!w) continue;
      sectorSum += w;
      add(maps.sector, s, w * h.value, h.symbol, false);
      add(maps.cycle, SUPER_SECTOR[s], w * h.value, h.symbol, false);
    }
    // A fund without a published sector split: use its classified top holdings for sector, the rest is not itemized.
    const topSectorSum = new Map<string, number>();
    let topSum = 0;
    for (const t of f.top ?? []) {
      const sym = canonical(t.symbol);
      const co = COMPANIES[sym];
      const v = t.weight * h.value;
      topSum += t.weight;
      add(maps.company, sym, v, h.symbol, false);
      if (!co) continue;
      topSectorSum.set(co.sector, (topSectorSum.get(co.sector) ?? 0) + t.weight);
      add(maps.industry, co.industry, v, h.symbol, false);
      for (const th of co.themes ?? []) add(maps.theme, THEMES[th].label, v, h.symbol, false);
      if (!f.sectors) { add(maps.sector, co.sector, v, h.symbol, false); add(maps.cycle, SUPER_SECTOR[co.sector], v, h.symbol, false); }
    }
    notIt.company += (1 - topSum) * h.value;
    if (f.sectors) {
      notIt.sector += Math.max(0, 1 - sectorSum) * h.value;
      notIt.cycle += Math.max(0, 1 - sectorSum) * h.value;
      if (f.industries) {
        // A sector fund that publishes its industry split (VHT): use it instead of its top holdings, so nothing is counted twice.
        for (const t of f.top ?? []) { const co = COMPANIES[canonical(t.symbol)]; if (co) removeFrom(maps.industry, co.industry, t.weight * h.value, h.symbol); }
        let indSum = 0;
        for (const [ind, w] of Object.entries(f.industries)) { add(maps.industry, ind, w * h.value, h.symbol, false); indSum += w; }
        notIt.industry += Math.max(0, 1 - indSum) * h.value;
      } else {
        notIt.industry += (1 - [...topSectorSum.values()].reduce((a, b) => a + b, 0)) * h.value;
        for (const s of GICS_SECTORS) {
          const r = Math.max(0, (f.sectors[s] ?? 0) * scale - (topSectorSum.get(s) ?? 0)) * h.value;
          if (r) sectorResidual.set(s, (sectorResidual.get(s) ?? 0) + r);
        }
      }
    } else {
      const known = [...topSectorSum.values()].reduce((a, b) => a + b, 0);
      notIt.sector += (1 - known) * h.value;
      notIt.cycle += (1 - known) * h.value;
      notIt.industry += (1 - known) * h.value;
      sectorResidual.set("*", (sectorResidual.get("*") ?? 0) + (1 - known) * h.value);
    }
    // Countries, market, region
    let cSum = 0;
    for (const [country, w] of Object.entries(f.countries ?? {})) {
      cSum += w;
      const v = w * h.value;
      add(maps.country, country, v, h.symbol, false);
      const cm = COUNTRY[country];
      if (cm) { add(maps.market, cm.market, v, h.symbol, false); add(maps.region, cm.region, v, h.symbol, false); }
      else { notIt.market += v; notIt.region += v; }
    }
    const rest = Math.max(0, 1 - cSum) * h.value;
    if (rest > 0.005) {
      notIt.country += rest; notIt.market += rest; notIt.region += rest;
      intlCountryResidual += rest;
      // A country already itemized in this fund cannot get more of it, and any country left out is smaller than the smallest one shown.
      const shown = Object.values(f.countries ?? {});
      countryRest.push({ fund: f.symbol, itemized: new Set(Object.keys(f.countries ?? {})), rest, cap: shown.length ? Math.min(...shown) * h.value : rest });
    }
    // Size and style from the fund's mandate or published split
    let sSum = 0;
    for (const [sz, w] of Object.entries(f.size ?? {})) { add(maps.size, sz, (w ?? 0) * h.value, h.symbol, false); sSum += w ?? 0; }
    if (!f.size) add(maps.size, "Large/mid (international, not split)", h.value, h.symbol, false);
    else if (sSum < 1) notIt.size += (1 - sSum) * h.value;
    add(maps.style, f.style, h.value, h.symbol, false);
  }

  const dim = (key: DimensionKey, label: string, base: "investable" | "equity", additive: boolean, notes: string[] = [], bench?: Record<string, number>, upper?: (l: Line) => number | undefined): Dimension => {
    const baseValue = base === "investable" ? investable : equity;
    const lines = [...maps[key].values()]
      .map((l) => {
        const u = upper?.(l);
        return {
          ...l, value: r2(l.value), direct: r2(l.direct), indirect: r2(l.indirect), pct: baseValue ? l.value / baseValue : 0,
          ...(u !== undefined && u > l.value + 0.5 ? { upper: r2(u), upperPct: baseValue ? u / baseValue : 0 } : {}),
          benchmarkPct: bench ? bench[l.key] ?? null : undefined,
          contributors: l.contributors.map((c) => ({ ...c, value: r2(c.value) })).sort((a, b) => b.value - a.value),
        };
      })
      .filter((l) => l.value >= 0.005)
      .sort((a, b) => b.value - a.value);
    const ni = Math.max(0, notIt[key]);
    return { key, label, base, baseValue: r2(baseValue), lines, notItemized: r2(ni), notItemizedPct: baseValue ? ni / baseValue : 0, additive, notes };
  };

  const industrySector = (ind: string): string | null => Object.values(COMPANIES).find((c) => c.industry === ind)?.sector ?? (/health|pharma|biotech|life sciences|managed/i.test(ind) ? "Health Care" : null);
  const dims: Record<DimensionKey, Dimension> = {
    asset: dim("asset", "Asset class", "investable", true),
    sector: dim("sector", "Sector (GICS)", "equity", true, ["International funds report ICB sectors; they are mapped to GICS (approximate)."], BENCHMARK.sectors),
    industry: dim("industry", "Industry", "equity", true, ["From classified companies only (direct holdings and each fund's largest holdings). The range shows the most it could be if every unassigned dollar of the same sector belonged to it."], undefined,
      (l) => { const s = industrySector(l.key); return s ? l.value + (sectorResidual.get(s) ?? 0) + (sectorResidual.get("*") ?? 0) : undefined; }),
    theme: dim("theme", "Theme", "equity", false, ["Themes overlap (one company can be in several), so these percentages must not be added together.", "Lower bounds: only companies the app has classified are counted; see the range for the most it could be."], undefined,
      (l) => (l.key === THEMES.ai_infrastructure.label ? l.value + (sectorResidual.get("Information Technology") ?? 0) + (sectorResidual.get("*") ?? 0) : undefined)),
    country: dim("country", "Country", "equity", true, [], BENCHMARK.countries, (l) => (l.key === "United States" ? undefined : l.value + countryRest.filter((r) => !r.itemized.has(l.key)).reduce((a, r) => a + Math.min(r.rest, r.cap), 0))),
    market: dim("market", "US / developed / emerging", "equity", true, ["MSCI conventions: South Korea and Taiwan are emerging markets."], undefined, (l) => (l.key === "US" ? undefined : l.value + intlCountryResidual)),
    region: dim("region", "Region", "equity", true, [], undefined, (l) => (l.key === "North America" ? undefined : l.value + intlCountryResidual)),
    size: dim("size", "Company size", "equity", true, ["Fund sizes follow the index rules (S&P 500 = large, MidCap 400 = mid, SmallCap 600 = small) unless the issuer publishes a split."]),
    style: dim("style", "Growth vs value", "equity", true, ["Funds are labelled by their mandate (an S&P 500 fund is 'blend' even though its largest holdings are growth companies). Single stocks are the app's judgement from growth and valuation."]),
    cycle: dim("cycle", "Economic-cycle sensitivity", "equity", true, ["Morningstar super-sectors: Cyclical (materials, consumer discretionary, financials, real estate), Sensitive (communication, energy, industrials, technology), Defensive (staples, health care, utilities)."]),
    company: dim("company", "Company", "equity", true, ["Companies outside each fund's largest holdings are not itemized; a held company's fund exposure can be slightly higher than shown."]),
  };

  // Directly held companies that sit in a fund's index but outside its listed top holdings.
  for (const h of equityHoldings.filter((x) => COMPANIES[x.symbol] && !fundOf(x.symbol))) {
    for (const fh of equityHoldings.filter((x) => fundOf(x.symbol)?.top?.length)) {
      const f = fundOf(fh.symbol)!;
      const co = COMPANIES[h.symbol];
      const inTop = f.top!.some((t) => canonical(t.symbol) === h.symbol);
      const plausible = f.countries?.["United States"] === 1 ? co.country === "United States" && (f.size?.Large ? co.size === "Large" : true) && (!f.sectors || (f.sectors[co.sector] ?? 0) > 0) : co.country !== "United States";
      if (!inTop && plausible && f.symbol === "VOO" && co.size === "Large") {
        const minW = Math.min(...f.top!.map((t) => t.weight));
        const line = dims.company.lines.find((l) => l.key === h.symbol);
        if (line) { line.upper = r2(line.value + minW * fh.value); line.upperPct = equity ? line.upper / equity : 0; }
      }
    }
  }

  // Fund overlap
  const eqFunds = equityHoldings.filter((h) => fundOf(h.symbol));
  const overlaps: FundOverlap[] = [];
  for (let i = 0; i < eqFunds.length; i++) for (let j = i + 1; j < eqFunds.length; j++) {
    const A = fundOf(eqFunds[i].symbol)!, B = fundOf(eqFunds[j].symbol)!;
    const ca = A.countries ?? {}, cb = B.countries ?? {};
    // Country overlap only means something between international funds (every US fund is "100% US").
    const countryOverlap = Object.keys(ca).filter((k) => k !== "United States").reduce((a, k) => a + Math.min(ca[k], cb[k] ?? 0), 0);
    const tb = new Map((B.top ?? []).map((t) => [canonical(t.symbol), t.weight]));
    const holdingsOverlap = (A.top ?? []).reduce((a, t) => a + Math.min(t.weight, tb.get(canonical(t.symbol)) ?? 0), 0);
    const market = (m: string) => m.split("(")[0].trim();
    const same = market(A.mandate) === market(B.mandate);
    if (same || countryOverlap >= 0.15 || holdingsOverlap >= 0.03) overlaps.push({
      a: A.symbol, b: B.symbol, countryOverlap, holdingsOverlap,
      note: same ? `${A.symbol} and ${B.symbol} both hold ${market(A.mandate).charAt(0).toLowerCase() + market(A.mandate).slice(1)}: holding both adds no diversification, only a second fund to track.`
        : countryOverlap >= 0.15 ? `${B.symbol} repeats part of ${A.symbol}: at least ${Math.round(countryOverlap * 100)}% of their country weights and ${(holdingsOverlap * 100).toFixed(1)}% of their largest holdings are the same.`
        : `${(holdingsOverlap * 100).toFixed(1)}% of ${A.symbol} and ${B.symbol} is the same largest companies.`,
    });
  }

  // Concentration in the largest companies (look-through)
  const top10 = dims.company.lines.slice(0, 10).map((l) => ({ symbol: l.key, pct: l.pct }));
  const top10Pct = top10.reduce((a, x) => a + x.pct, 0);

  // Interest-rate sensitivity
  let dd = 0;
  for (const h of holdings) { const f = fundOf(h.symbol); if (f?.bond) dd += f.bond.duration * h.value; }
  const growth = dims.style.lines.find((l) => l.key === "Growth")?.value ?? 0;
  const small = dims.size.lines.find((l) => l.key === "Small")?.value ?? 0;

  // Source ages
  const sources: SourceAge[] = [];
  for (const h of holdings) {
    const f = fundOf(h.symbol);
    if (!f) continue;
    const refs: [string, SourceRef | undefined][] = [["sectors", f.sectorsSource], ["countries", f.countriesSource], ["largest holdings", f.topSource], ["bond data", f.bond?.source]];
    for (const [what, s] of refs) if (s) { const a = ageDays(s.asOf, now); sources.push({ fund: f.symbol, what, source: s, ageDays: a, stale: a > STALE_DAYS }); }
  }

  const gaps: string[] = [];
  if (unclassified.length) gaps.push(`Not classified yet: ${unclassified.join(", ")} (counted as not itemized).`);
  for (const h of equityHoldings) { const f = fundOf(h.symbol); if (f && !f.sectors) gaps.push(`${f.symbol}: no published sector split found; only its ${f.top?.length ?? 0} largest holdings are classified.`); }
  for (const h of equityHoldings) { const f = fundOf(h.symbol); if (f?.countriesNote && /not itemized/.test(f.countriesNote)) gaps.push(`${f.symbol}: ${f.countriesNote}`); }
  const stale = sources.filter((s) => s.stale);
  if (stale.length) gaps.push(`Older than ${STALE_DAYS} days: ${stale.map((s) => `${s.fund} ${s.what} (${s.source.asOf})`).join("; ")}.`);

  return {
    computedAt: now.toISOString(),
    investable: r2(investable), equity: r2(equity), bonds: r2(bonds), cash: r2(cash),
    dims, overlaps,
    concentration: { top10Pct, top10, benchmarkTop10: BENCHMARK.top10 },
    rates: {
      bondDollarDuration: r2(dd), bondValue: r2(bonds), per1pt: r2(dd / 100),
      growthEquityPct: equity ? growth / equity : 0, smallCapPct: equity ? small / equity : 0,
      notes: [
        bonds ? `A 1-point rise in interest rates would lower the bond funds by about $${Math.round(dd / 100).toLocaleString("en-US")} (effective duration, issuer data). Falling rates do the opposite.` : "No bond funds.",
        "Growth stocks and small companies are usually the most sensitive equities to rising rates: growth because more of the value is far in the future, small companies because more of their debt is floating-rate.",
      ],
    },
    sources, gaps, unclassified,
  };
}

function classifyCompany(maps: Record<DimensionKey, Map<string, Line>>, sym: string, v: number, via: string, direct: boolean) {
  const co = COMPANIES[sym];
  add(maps.sector, co.sector, v, via, direct);
  add(maps.cycle, SUPER_SECTOR[co.sector], v, via, direct);
  add(maps.industry, co.industry, v, via, direct);
  for (const th of co.themes ?? []) add(maps.theme, THEMES[th as ThemeKey].label, v, via, direct);
  add(maps.country, co.country, v, via, direct);
  const cm = COUNTRY[co.country];
  if (cm) { add(maps.market, cm.market, v, via, direct); add(maps.region, cm.region, v, via, direct); }
}

function removeFrom(m: Map<string, Line>, key: string, v: number, via: string) {
  const l = m.get(key);
  if (!l) return;
  l.value -= v; l.indirect -= v;
  const c = l.contributors.find((x) => x.via === via);
  if (c) c.value -= v;
  l.contributors = l.contributors.filter((x) => x.value > 0.004);
  if (l.value <= 0.004) m.delete(key);
}

function r2(n: number) { return Math.round(n * 100) / 100; }

/** Looks up any symbol the app knows: a fund profile, a company profile, or nothing. */
export function describeSecurity(symbol: string) {
  const s = canonical(symbol);
  if (FUNDS[s]) return { kind: "fund" as const, symbol: s, profile: FUNDS[s] };
  if (COMPANIES[s]) return { kind: "company" as const, symbol: s, profile: COMPANIES[s] };
  return null;
}

/** Plain-language answer lines for one dimension line, used by the page and the assistant. */
export function explainLine(d: Dimension, l: Line): string {
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  const parts = l.contributors.slice(0, 6).map((c) => `${c.via} $${Math.round(c.value).toLocaleString("en-US")}`);
  const range = l.upperPct !== undefined ? ` (could be up to ${p(l.upperPct)} counting not-itemized fund holdings)` : "";
  return `${l.key}: ${p(l.pct)} of ${d.base === "equity" ? "stocks" : "the invested portfolio"}${range}; $${Math.round(l.direct).toLocaleString("en-US")} direct, $${Math.round(l.indirect).toLocaleString("en-US")} through funds. From: ${parts.join(", ")}.`;
}

export type ExposureQuery = { country?: string; market?: string; sector?: string; industry?: string; theme?: string; company?: string };
export type QueryResult = {
  value: number; pctOfEquity: number; pctOfInvestable: number; direct: number; indirect: number;
  method: string[]; approximate: boolean; contributors: Contribution[];
};

/**
 * One combined question, e.g. "US technology" = country United States AND sector Information Technology.
 * Direct holdings are exact. For funds the engine multiplies the fund's country weight by its sector
 * weight when it has no joint split; that assumes the two are independent inside the fund, so the result
 * is labelled approximate unless the fund is single-country (all US funds are).
 */
export function queryExposure(holdingsIn: HoldingIn[], cash: number, q: ExposureQuery): QueryResult {
  const merged = new Map<string, number>();
  for (const h of holdingsIn) if (h.value) merged.set(canonical(h.symbol), (merged.get(canonical(h.symbol)) ?? 0) + h.value);
  const themeKey = q.theme ? (Object.entries(THEMES).find(([k, t]) => k === q.theme || t.label.toLowerCase() === q.theme!.toLowerCase())?.[0] as ThemeKey | undefined) : undefined;
  const lc = (s?: string) => s?.toLowerCase();
  const matchCo = (sym: string, co: (typeof COMPANIES)[string], checkGeo: boolean) =>
    (!q.company || canonical(q.company) === sym) && (!q.sector || lc(co.sector) === lc(q.sector)) && (!q.industry || lc(co.industry) === lc(q.industry)) &&
    (!q.theme || (themeKey ? co.themes?.includes(themeKey) : false)) &&
    (!checkGeo || ((!q.country || lc(co.country) === lc(q.country)) && (!q.market || lc(COUNTRY[co.country]?.market) === lc(q.market))));
  let value = 0, direct = 0, indirect = 0, equity = 0, investable = cash, approximate = false;
  const contributors: Contribution[] = [];
  const method = new Set<string>();
  for (const [symbol, v] of merged) {
    const f = FUNDS[symbol];
    investable += v;
    if (f?.assetClass === "bond") continue;
    equity += v;
    if (!f) {
      const co = COMPANIES[symbol];
      if (co && matchCo(symbol, co, true)) { value += v; direct += v; contributors.push({ via: symbol, value: v }); }
      if (!co) method.add(`${symbol} is not classified, so it is left out.`);
      continue;
    }
    // Geography share of the fund
    let geo = 1;
    if (q.country) geo = f.countries?.[q.country] ?? Object.entries(f.countries ?? {}).find(([k]) => lc(k) === lc(q.country))?.[1] ?? 0;
    if (q.market) geo = Object.entries(f.countries ?? {}).filter(([k]) => lc(COUNTRY[k]?.market) === lc(q.market)).reduce((a, [, w]) => a + w, 0);
    const singleCountry = Object.keys(f.countries ?? {}).length === 1;
    // Business share of the fund
    let biz = 1;
    if (q.company || q.industry || q.theme) {
      // From classified top holdings only (and the published industry split for a sector fund).
      biz = (q.industry && f.industries ? Object.entries(f.industries).find(([k]) => lc(k) === lc(q.industry))?.[1] ?? 0 : null)
        ?? (f.top ?? []).filter((t) => { const co = COMPANIES[canonical(t.symbol)]; return co && matchCo(canonical(t.symbol), co, false); }).reduce((a, t) => a + t.weight, 0);
      if (!f.industries || !q.industry) method.add(`${f.symbol}: only its listed largest holdings are classified, so its share is a lower bound.`);
      // Geography of the matched top holdings is known exactly from the company record.
      if ((q.country || q.market) && !singleCountry) {
        biz = (f.top ?? []).filter((t) => { const co = COMPANIES[canonical(t.symbol)]; return co && matchCo(canonical(t.symbol), co, true); }).reduce((a, t) => a + t.weight, 0);
        geo = 1;
      }
    } else if (q.sector) {
      biz = f.sectors ? Object.entries(f.sectors).find(([k]) => lc(k) === lc(q.sector))?.[1] ?? 0 : (f.top ?? []).filter((t) => lc(COMPANIES[canonical(t.symbol)]?.sector) === lc(q.sector)).reduce((a, t) => a + t.weight, 0);
      if (!f.sectors) method.add(`${f.symbol}: no published sector split; only its largest holdings are counted.`);
      if ((q.country || q.market) && !singleCountry && geo > 0) { approximate = true; method.add(`${f.symbol}: country weight x sector weight (assumes they are independent inside the fund).`); }
    }
    const share = geo * biz * v;
    if (share > 0.005) { value += share; indirect += share; contributors.push({ via: f.symbol, value: Math.round(share * 100) / 100 }); }
  }
  contributors.sort((a, b) => b.value - a.value);
  return { value: r2(value), pctOfEquity: equity ? value / equity : 0, pctOfInvestable: investable ? value / investable : 0, direct: r2(direct), indirect: r2(indirect), method: [...method], approximate, contributors };
}
