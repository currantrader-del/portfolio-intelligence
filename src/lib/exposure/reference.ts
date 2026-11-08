/**
 * Reference data for exposure look-through: what each fund holds, and how each company is classified.
 *
 * Every fund figure below was read from a published page on the date shown, and each fund keeps its
 * source URL and "as of" date so the app can say how old it is. Nothing here is live: refresh it when
 * issuers publish new fact sheets (Vanguard and iShares update monthly or daily). Gaps are left as
 * gaps: a sector or country the source did not show is NOT filled in; the engine reports it as
 * "not itemized" and gives a range instead of a single number.
 *
 * Company classifications are the app's GICS-style labels (sector > industry > sub-industry), plus
 * home market, size, style and themes. Themes are the app's own definitions (see THEMES) and are
 * NOT additive: one company can be in several themes.
 */

export const GICS_SECTORS = [
  "Information Technology", "Financials", "Communication Services", "Health Care", "Consumer Discretionary",
  "Industrials", "Consumer Staples", "Energy", "Utilities", "Materials", "Real Estate",
] as const;
export type Sector = (typeof GICS_SECTORS)[number];

export type Size = "Large" | "Mid" | "Small";
export type Style = "Growth" | "Blend" | "Value";

export type SourceRef = { label: string; url: string; asOf: string };

export type FundProfile = {
  symbol: string;
  name: string;
  assetClass: "equity" | "bond";
  /** What the fund is meant to hold, in one line. */
  mandate: string;
  /** Sector weights (fractions of the fund). Missing sectors are not itemized, not zero. */
  sectors?: Partial<Record<Sector, number>>;
  sectorTaxonomy?: "GICS" | "ICB mapped to GICS (approximate)";
  sectorsSource?: SourceRef;
  /** Country weights (fractions of the fund). The rest is "not itemized". */
  countries?: Record<string, number>;
  countriesNote?: string;
  countriesSource?: SourceRef;
  /** Size split; "mandate" means taken from the index's rules, not a published split. */
  size?: Partial<Record<Size, number>>;
  sizeBasis?: "published" | "mandate";
  style: Style;
  styleBasis: "mandate" | "published";
  holdingsCount?: number;
  /** Largest holdings (fractions of the fund), keyed by the symbol used in COMPANIES. */
  top?: { symbol: string; weight: number }[];
  topSource?: SourceRef;
  /** GICS industry weights when the issuer publishes them (a sector fund), so its industries need no estimate. */
  industries?: Record<string, number>;
  industriesSource?: SourceRef;
  /** Bonds only. */
  bond?: { duration: number; sectors: Record<string, number>; source: SourceRef };
  notes?: string[];
};

const FS = (n: string) => `https://fund-docs.vanguard.com/${n}.pdf`;
const SA = (t: string) => `https://stockanalysis.com/etf/${t}/holdings/`;

export const FUNDS: Record<string, FundProfile> = {
  VOO: {
    symbol: "VOO", name: "Vanguard S&P 500 ETF", assetClass: "equity", mandate: "The 500 largest US companies (S&P 500)",
    sectors: { "Information Technology": 0.397, Financials: 0.114, "Communication Services": 0.099, "Health Care": 0.093, "Consumer Discretionary": 0.086, Industrials: 0.08, "Consumer Staples": 0.044, Energy: 0.034, Utilities: 0.019, Materials: 0.017, "Real Estate": 0.017 },
    sectorTaxonomy: "GICS", sectorsSource: { label: "Vanguard VOO fact sheet", url: FS("F0968"), asOf: "2026-09-30" },
    countries: { "United States": 1 }, countriesNote: "US companies only (S&P 500 rules)", countriesSource: { label: "S&P 500 index rules", url: "https://www.spglobal.com/spdji/en/indices/equity/sp-500/", asOf: "2026-11-08" },
    size: { Large: 1 }, sizeBasis: "mandate", style: "Blend", styleBasis: "mandate", holdingsCount: 505,
    top: [
      { symbol: "NVDA", weight: 0.0839 }, { symbol: "AAPL", weight: 0.0738 }, { symbol: "MSFT", weight: 0.0578 }, { symbol: "AMZN", weight: 0.0371 },
      { symbol: "GOOGL", weight: 0.0552 }, // Class A 3.07% + Class C 2.45%
      { symbol: "AVGO", weight: 0.0254 }, { symbol: "META", weight: 0.0243 }, { symbol: "MU", weight: 0.0183 }, { symbol: "TSLA", weight: 0.0152 },
      { symbol: "AMD", weight: 0.0152 }, { symbol: "BRK.B", weight: 0.0141 }, { symbol: "LLY", weight: 0.0141 }, { symbol: "JPM", weight: 0.0134 },
      { symbol: "XOM", weight: 0.0102 }, { symbol: "JNJ", weight: 0.0097 }, { symbol: "V", weight: 0.0091 }, { symbol: "INTC", weight: 0.0091 },
      { symbol: "WMT", weight: 0.007 }, { symbol: "ABBV", weight: 0.007 }, { symbol: "MA", weight: 0.0068 }, { symbol: "PLTR", weight: 0.0065 },
      { symbol: "CSCO", weight: 0.0064 }, { symbol: "LRCX", weight: 0.0062 }, { symbol: "AMAT", weight: 0.0062 },
    ],
    topSource: { label: "stockanalysis.com VOO holdings (top 25 of 518)", url: SA("voo"), asOf: "2026-09-30" },
    notes: ["Top 25 holdings cover about 64% of the fund; the other ~480 companies are known only by sector.", "Alphabet's two share classes are combined as GOOGL."],
  },
  VXUS: {
    symbol: "VXUS", name: "Vanguard Total International Stock ETF", assetClass: "equity", mandate: "Developed and emerging markets outside the US, all sizes (FTSE Global All Cap ex US)",
    sectors: { Financials: 0.231, "Information Technology": 0.187, Industrials: 0.152, "Consumer Discretionary": 0.089, Materials: 0.072, "Health Care": 0.067, Energy: 0.051, "Communication Services": 0.051, "Consumer Staples": 0.046, Utilities: 0.032, "Real Estate": 0.023 },
    sectorTaxonomy: "ICB mapped to GICS (approximate)", sectorsSource: { label: "Vanguard VXUS fact sheet", url: FS("F3369"), asOf: "2026-09-30" },
    countries: { Japan: 0.161, Taiwan: 0.093, "United Kingdom": 0.081, Canada: 0.079, China: 0.069, "South Korea": 0.067, Switzerland: 0.048, France: 0.048, Germany: 0.046, India: 0.043 },
    countriesNote: "Ten largest markets only (73.5% of the fund); the other ~26% is spread over 30+ countries and is not itemized.",
    countriesSource: { label: "Vanguard VXUS fact sheet", url: FS("F3369"), asOf: "2026-09-30" },
    style: "Blend", styleBasis: "mandate", holdingsCount: 8901,
    top: [
      { symbol: "TSM", weight: 0.043 }, { symbol: "SSNLF", weight: 0.023 }, { symbol: "SKHY", weight: 0.017 }, { symbol: "ASML", weight: 0.016 },
      { symbol: "TCEHY", weight: 0.008 }, { symbol: "HSBC", weight: 0.008 }, { symbol: "RHHBY", weight: 0.007 }, { symbol: "SHEL", weight: 0.006 },
      { symbol: "RY", weight: 0.006 }, { symbol: "NVS", weight: 0.006 }, { symbol: "BABA", weight: 0.0057 }, { symbol: "MUFG", weight: 0.0057 },
      { symbol: "AZN", weight: 0.0054 }, { symbol: "NSRGY", weight: 0.0052 }, { symbol: "MDTKF", weight: 0.0051 }, { symbol: "SIEGY", weight: 0.005 },
      { symbol: "BHP", weight: 0.0048 }, { symbol: "SAP", weight: 0.0046 }, { symbol: "SAN", weight: 0.0045 }, { symbol: "TD", weight: 0.0043 },
      { symbol: "TM", weight: 0.0043 }, { symbol: "SHOP", weight: 0.0041 }, { symbol: "ALIZY", weight: 0.004 },
    ],
    topSource: { label: "Vanguard VXUS fact sheet (top 10) and stockanalysis.com (11-25)", url: FS("F3369"), asOf: "2026-09-30" },
    notes: ["Vanguard reports ICB sectors; they are mapped to the nearest GICS sector (ICB Technology -> Information Technology, Telecommunications -> Communication Services, Basic Materials -> Materials). Internet companies such as Tencent sit in ICB Technology, so international 'technology' is slightly overstated versus GICS.", "FTSE counts South Korea as developed; this app follows MSCI and counts it as emerging."],
  },
  IXUS: {
    symbol: "IXUS", name: "iShares Core MSCI Total International Stock ETF", assetClass: "equity", mandate: "Developed and emerging markets outside the US, all sizes (MSCI ACWI ex USA IMI)",
    sectors: { Financials: 0.238, "Information Technology": 0.1745, Industrials: 0.1452, "Consumer Discretionary": 0.0848, "Health Care": 0.0764, Materials: 0.0749, "Consumer Staples": 0.0559, Energy: 0.0489, "Communication Services": 0.0439, Utilities: 0.0317, "Real Estate": 0.0224 },
    sectorTaxonomy: "GICS", sectorsSource: { label: "iShares IXUS fund page", url: "https://www.ishares.com/us/products/244048/ishares-core-msci-total-international-stock-etf", asOf: "2026-11-05" },
    countries: { Japan: 0.1536, "United Kingdom": 0.088, Canada: 0.0849, Taiwan: 0.0809, China: 0.0619, Switzerland: 0.056, "South Korea": 0.0544, France: 0.0529, Germany: 0.0503, Australia: 0.0442, India: 0.0428, Netherlands: 0.0287 },
    countriesNote: "Twelve largest markets (77.9% of the fund); ten smaller markets, each under 2.9%, are not itemized.",
    countriesSource: { label: "iShares IXUS fund page", url: "https://www.ishares.com/us/products/244048/ishares-core-msci-total-international-stock-etf", asOf: "2026-11-05" },
    style: "Blend", styleBasis: "mandate", holdingsCount: 4573,
    top: [
      { symbol: "TSM", weight: 0.0448 }, { symbol: "SSNLF", weight: 0.0217 }, { symbol: "SKHY", weight: 0.0167 }, { symbol: "ASML", weight: 0.0158 },
      { symbol: "HSBC", weight: 0.0081 }, { symbol: "TCEHY", weight: 0.008 }, { symbol: "RHHBY", weight: 0.007 }, { symbol: "SHEL", weight: 0.0065 },
      { symbol: "RY", weight: 0.0065 }, { symbol: "NVS", weight: 0.0062 }, { symbol: "MUFG", weight: 0.0059 }, { symbol: "AZN", weight: 0.0058 },
      { symbol: "MDTKF", weight: 0.0057 }, { symbol: "NSRGY", weight: 0.0056 }, { symbol: "BABA", weight: 0.0054 }, { symbol: "SIEGY", weight: 0.0053 },
      { symbol: "BHP", weight: 0.005 }, { symbol: "SAP", weight: 0.0049 }, { symbol: "SAN", weight: 0.0047 }, { symbol: "TD", weight: 0.0046 },
      { symbol: "ALIZY", weight: 0.0043 }, { symbol: "SBGSY", weight: 0.0042 }, { symbol: "TM", weight: 0.0042 }, { symbol: "CMWAY", weight: 0.0042 }, { symbol: "TTE", weight: 0.0041 },
    ],
    topSource: { label: "stockanalysis.com IXUS holdings (top 25)", url: SA("ixus"), asOf: "2026-09-28" },
  },
  VWO: {
    symbol: "VWO", name: "Vanguard FTSE Emerging Markets ETF", assetClass: "equity", mandate: "Emerging-market companies, all sizes (FTSE Emerging Markets All Cap China A Inclusion)",
    sectors: { "Information Technology": 0.359, Financials: 0.196, Industrials: 0.088, "Consumer Discretionary": 0.086, Materials: 0.07, Energy: 0.043, "Health Care": 0.039, "Communication Services": 0.037, "Consumer Staples": 0.033, Utilities: 0.027, "Real Estate": 0.022 },
    sectorTaxonomy: "ICB mapped to GICS (approximate)", sectorsSource: { label: "Vanguard VWO fact sheet", url: FS("F0964"), asOf: "2026-09-30" },
    countries: { Taiwan: 0.351, China: 0.26, India: 0.16, Brazil: 0.045, "South Africa": 0.036, "Saudi Arabia": 0.03, Mexico: 0.019, Malaysia: 0.017, Thailand: 0.017, "United Arab Emirates": 0.016 },
    countriesNote: "Ten largest markets (95.2% of the fund); the rest is not itemized. FTSE excludes South Korea from emerging markets.",
    countriesSource: { label: "Vanguard VWO fact sheet", url: FS("F0964"), asOf: "2026-09-30" },
    style: "Blend", styleBasis: "mandate", holdingsCount: 6507,
    top: [
      { symbol: "TSM", weight: 0.164 }, { symbol: "TCEHY", weight: 0.029 }, { symbol: "BABA", weight: 0.022 }, { symbol: "MDTKF", weight: 0.019 },
      { symbol: "DELTA.TW", weight: 0.01 }, { symbol: "CICHF", weight: 0.01 }, { symbol: "HNHPF", weight: 0.008 }, { symbol: "IDCBF", weight: 0.007 },
      { symbol: "HDB", weight: 0.007 }, { symbol: "RELIANCE.NS", weight: 0.007 }, { symbol: "3711.TW", weight: 0.0061 }, { symbol: "IBN", weight: 0.006 },
      { symbol: "PDD", weight: 0.005 }, { symbol: "BHARTIARTL.NS", weight: 0.0047 }, { symbol: "XIACF", weight: 0.0046 }, { symbol: "BACHF", weight: 0.0043 },
      { symbol: "MPNGY", weight: 0.0041 }, { symbol: "1120.SR", weight: 0.0041 }, { symbol: "VALE", weight: 0.004 }, { symbol: "3037.TW", weight: 0.004 },
      { symbol: "UMC", weight: 0.0039 }, { symbol: "2383.TW", weight: 0.0037 },
    ],
    topSource: { label: "Vanguard VWO fact sheet (top 10) and stockanalysis.com (11-25)", url: FS("F0964"), asOf: "2026-09-30" },
    notes: ["TSMC alone is about 16% of the fund.", "Vanguard reports ICB sectors, mapped to the nearest GICS sector (approximate)."],
  },
  VHT: {
    symbol: "VHT", name: "Vanguard Health Care ETF", assetClass: "equity", mandate: "US health care companies of all sizes",
    sectors: { "Health Care": 1 }, sectorTaxonomy: "GICS", sectorsSource: { label: "Vanguard VHT fact sheet", url: FS("F0956"), asOf: "2026-09-30" },
    countries: { "United States": 1 }, countriesNote: "US companies", countriesSource: { label: "Vanguard VHT fact sheet", url: FS("F0956"), asOf: "2026-09-30" },
    size: { Large: 0.641, Mid: 0.248, Small: 0.11 }, sizeBasis: "published", style: "Blend", styleBasis: "mandate", holdingsCount: 412,
    // Fact-sheet sub-industries rolled up to GICS industries: Equipment 13.5 + Supplies 1.1; Managed care 7.2 + Services 4.5 + Distributors 3.0 + Facilities 1.9.
    industries: { Pharmaceuticals: 0.332, Biotechnology: 0.242, "Health Care Equipment & Supplies": 0.146, "Life Sciences Tools & Services": 0.106, "Health Care Providers & Services": 0.166, "Health Care Technology": 0.008 },
    industriesSource: { label: "Vanguard VHT fact sheet", url: FS("F0956"), asOf: "2026-09-30" },
    top: [{ symbol: "LLY", weight: 0.13 }, { symbol: "JNJ", weight: 0.088 }, { symbol: "ABBV", weight: 0.065 }, { symbol: "MRK", weight: 0.05 }, { symbol: "UNH", weight: 0.047 }, { symbol: "TMO", weight: 0.035 }, { symbol: "AMGN", weight: 0.032 }, { symbol: "GILD", weight: 0.026 }, { symbol: "ABT", weight: 0.024 }, { symbol: "PFE", weight: 0.023 }],
    topSource: { label: "Vanguard VHT fact sheet", url: FS("F0956"), asOf: "2026-09-30" },
    notes: ["Fact-sheet size split: Large 64.1%, Medium/Large 3.5%, Medium 16.1%, Medium/Small 5.2%, Small 11.0%; the in-between bands are counted as Mid."],
  },
  IJH: {
    symbol: "IJH", name: "iShares Core S&P Mid-Cap ETF", assetClass: "equity", mandate: "US mid-sized companies (S&P MidCap 400)",
    sectors: { Industrials: 0.23, Financials: 0.1536, "Information Technology": 0.1384, "Health Care": 0.1042, "Consumer Discretionary": 0.1027, "Real Estate": 0.0713, Energy: 0.0581, Materials: 0.0577, "Consumer Staples": 0.034, Utilities: 0.0325, "Communication Services": 0.0161 },
    sectorTaxonomy: "GICS", sectorsSource: { label: "iShares IJH fund page", url: "https://www.ishares.com/us/products/239763/ishares-core-s-p-mid-cap-etf", asOf: "2026-10-26" },
    countries: { "United States": 1 }, countriesNote: "US-listed index; a few holdings are domiciled abroad (e.g. RB Global, Canada, 0.5%)", countriesSource: { label: "iShares IJH holdings file", url: "https://www.ishares.com/us/products/239763/ishares-core-s-p-mid-cap-etf", asOf: "2026-11-04" },
    size: { Mid: 1 }, sizeBasis: "mandate", style: "Blend", styleBasis: "mandate", holdingsCount: 406,
  },
  IJR: {
    symbol: "IJR", name: "iShares Core S&P Small-Cap ETF", assetClass: "equity", mandate: "US small companies with a profitability screen (S&P SmallCap 600)",
    sectors: { Financials: 0.1861, Industrials: 0.1709, "Consumer Discretionary": 0.1317, "Information Technology": 0.1248, "Health Care": 0.1099, Energy: 0.0655, "Real Estate": 0.0649, Materials: 0.0414, "Consumer Staples": 0.0401, "Communication Services": 0.036, Utilities: 0.0201 },
    sectorTaxonomy: "GICS", sectorsSource: { label: "iShares IJR fund page", url: "https://www.ishares.com/us/products/239774/ishares-core-s-p-small-cap-etf", asOf: "2026-10-23" },
    countries: { "United States": 1 }, countriesNote: "US companies", countriesSource: { label: "iShares IJR fund page", url: "https://www.ishares.com/us/products/239774/ishares-core-s-p-small-cap-etf", asOf: "2026-10-23" },
    size: { Small: 1 }, sizeBasis: "mandate", style: "Blend", styleBasis: "mandate", holdingsCount: 636,
  },
  AVUV: {
    symbol: "AVUV", name: "Avantis U.S. Small Cap Value ETF", assetClass: "equity", mandate: "US small companies with low valuations and high profitability (actively managed)",
    countries: { "United States": 1 }, countriesNote: "US companies", countriesSource: { label: "Avantis fund page", url: "https://avantisinvestors.com/avantis-investments/avantis-us-small-cap-value-etf/", asOf: "2026-11-06" },
    size: { Small: 1 }, sizeBasis: "mandate", style: "Value", styleBasis: "mandate", holdingsCount: 793,
    top: [
      { symbol: "GATX", weight: 0.0101 }, { symbol: "MATX", weight: 0.0094 }, { symbol: "LYFT", weight: 0.0089 }, { symbol: "CROX", weight: 0.008 }, { symbol: "M", weight: 0.0079 },
      { symbol: "ANF", weight: 0.0076 }, { symbol: "LEA", weight: 0.007 }, { symbol: "RUSHA", weight: 0.007 }, { symbol: "CAKE", weight: 0.0068 }, { symbol: "CBT", weight: 0.0068 },
      { symbol: "TREX", weight: 0.0068 }, { symbol: "SIG", weight: 0.0066 }, { symbol: "TPC", weight: 0.0063 }, { symbol: "MUR", weight: 0.0063 }, { symbol: "SM", weight: 0.0062 },
    ],
    topSource: { label: "stockanalysis.com AVUV holdings (top 15 of 793)", url: SA("avuv"), asOf: "2026-11-05" },
    notes: ["No published sector breakdown was found (Avantis and Morningstar pages did not load). Sector exposure through AVUV is estimated only from its 15 largest holdings (about 11% of the fund); the rest is 'not itemized'."],
  },
  AGG: {
    symbol: "AGG", name: "iShares Core US Aggregate Bond ETF", assetClass: "bond", mandate: "Investment-grade US bonds (Treasuries, mortgages, corporates)",
    style: "Blend", styleBasis: "mandate", holdingsCount: 13485,
    bond: { duration: 5.73, sectors: { Treasury: 0.4668, "Mortgage-backed": 0.2311 + 0.014, Corporate: 0.144 + 0.0802 + 0.025, "Government-related": 0.0109 + 0.0094 + 0.0059 + 0.005, "Asset-backed": 0.0044, Cash: 0.0034 }, source: { label: "iShares AGG fund page", url: "https://www.ishares.com/us/products/239458/ishares-core-total-us-bond-market-etf", asOf: "2026-11-05" } },
  },
  ISTB: {
    symbol: "ISTB", name: "iShares Core 1-5 Year USD Bond ETF", assetClass: "bond", mandate: "Investment-grade US-dollar bonds maturing in 1-5 years",
    style: "Blend", styleBasis: "mandate", holdingsCount: 7582,
    bond: { duration: 2.58, sectors: { Treasury: 0.525, Corporate: 0.1807 + 0.1288 + 0.0198, "Mortgage-backed": 0.0272 + 0.02, "Government-related": 0.0355 + 0.0249 + 0.0212 + 0.006, "Asset-backed": 0.007, Cash: 0.0039 }, source: { label: "iShares ISTB fund page", url: "https://www.ishares.com/us/products/244051/ishares-core-15-year-usd-bond-etf", asOf: "2026-11-05" } },
  },
};

/** Symbols that are the same economic holding (share classes, ADRs). */
export const ALIASES: Record<string, string> = { GOOG: "GOOGL", "BRK-B": "BRK.B", BRKB: "BRK.B", "2330.TW": "TSM", TSMC: "TSM" };
export const canonical = (s: string) => ALIASES[s.toUpperCase()] ?? s.toUpperCase();

export type CompanyProfile = {
  name: string;
  sector: Sector;
  industry: string; // GICS industry
  subIndustry?: string;
  country: string; // home market used by index providers
  size: Size;
  style: Style;
  themes?: ThemeKey[];
  /** One-line note when the classification is a judgement call. */
  note?: string;
};

/** Themes are the app's definitions, written down so the numbers are reproducible. Not additive. */
export const THEMES = {
  ai_infrastructure: { label: "AI infrastructure", definition: "Companies whose core business supplies AI data-center buildout: accelerator and memory chips, chip foundry and packaging, chipmaking equipment, AI server hardware and power, and AI data-center capacity." },
  ai_platforms: { label: "AI platforms and hyperscalers", definition: "Cloud and internet platforms spending heavily on AI and selling AI services (Microsoft, Alphabet, Amazon, Meta, Oracle, Alibaba, Tencent)." },
  software_cloud: { label: "Software and cloud", definition: "Companies whose main product is software or cloud services (GICS Software industry plus the cloud platforms of Alphabet, Amazon and Alibaba)." },
  digital_ads: { label: "Digital advertising", definition: "Companies earning most of their revenue from online advertising." },
  speculative_tech: { label: "Speculative / early-stage tech", definition: "Companies valued mainly on future technology adoption, with small or negative profits (quantum computing, early AI cloud)." },
  bitcoin_mining: { label: "Bitcoin mining", definition: "Companies with material revenue from mining bitcoin." },
} as const;
export type ThemeKey = keyof typeof THEMES;

const IT = "Information Technology" as const, CS = "Communication Services" as const, CD = "Consumer Discretionary" as const, HC = "Health Care" as const;
const SEMI = "Semiconductors & Semiconductor Equipment";
const c = (name: string, sector: Sector, industry: string, country: string, size: Size, style: Style, themes?: ThemeKey[], subIndustry?: string, note?: string): CompanyProfile => ({ name, sector, industry, subIndustry, country, size, style, themes, note });

export const COMPANIES: Record<string, CompanyProfile> = {
  // Held directly
  NVDA: c("NVIDIA", IT, SEMI, "United States", "Large", "Growth", ["ai_infrastructure"], "Semiconductors"),
  GOOGL: c("Alphabet", CS, "Interactive Media & Services", "United States", "Large", "Growth", ["ai_platforms", "software_cloud", "digital_ads"]),
  NOW: c("ServiceNow", IT, "Software", "United States", "Large", "Growth", ["software_cloud"], "Application Software"),
  IREN: c("IREN", IT, "IT Services", "United States", "Mid", "Growth", ["ai_infrastructure", "bitcoin_mining", "speculative_tech"], "Internet Services & Infrastructure", "Incorporated in Australia; data centers in Texas and British Columbia. Data providers disagree on its sector (some list Financials for bitcoin mining); the app classifies it by its AI cloud and data-center business."),
  RDDT: c("Reddit", CS, "Interactive Media & Services", "United States", "Large", "Growth", ["digital_ads"]),
  IONQ: c("IonQ", IT, "Technology Hardware, Storage & Peripherals", "United States", "Mid", "Growth", ["speculative_tech"], "Technology Hardware", "Quantum computing; small revenue, large losses."),
  // S&P 500 top holdings
  AAPL: c("Apple", IT, "Technology Hardware, Storage & Peripherals", "United States", "Large", "Growth"),
  MSFT: c("Microsoft", IT, "Software", "United States", "Large", "Growth", ["ai_platforms", "software_cloud"], "Systems Software"),
  AMZN: c("Amazon", CD, "Broadline Retail", "United States", "Large", "Growth", ["ai_platforms", "software_cloud"]),
  AVGO: c("Broadcom", IT, SEMI, "United States", "Large", "Growth", ["ai_infrastructure"], "Semiconductors"),
  META: c("Meta Platforms", CS, "Interactive Media & Services", "United States", "Large", "Growth", ["ai_platforms", "digital_ads"]),
  MU: c("Micron Technology", IT, SEMI, "United States", "Large", "Blend", ["ai_infrastructure"], "Semiconductors"),
  TSLA: c("Tesla", CD, "Automobiles", "United States", "Large", "Growth"),
  AMD: c("Advanced Micro Devices", IT, SEMI, "United States", "Large", "Growth", ["ai_infrastructure"], "Semiconductors"),
  "BRK.B": c("Berkshire Hathaway", "Financials", "Financial Services", "United States", "Large", "Value"),
  LLY: c("Eli Lilly", HC, "Pharmaceuticals", "United States", "Large", "Growth"),
  JPM: c("JPMorgan Chase", "Financials", "Banks", "United States", "Large", "Value"),
  XOM: c("ExxonMobil", "Energy", "Oil, Gas & Consumable Fuels", "United States", "Large", "Value"),
  JNJ: c("Johnson & Johnson", HC, "Pharmaceuticals", "United States", "Large", "Value"),
  V: c("Visa", "Financials", "Financial Services", "United States", "Large", "Growth"),
  INTC: c("Intel", IT, SEMI, "United States", "Large", "Value", undefined, "Semiconductors"),
  WMT: c("Walmart", "Consumer Staples", "Consumer Staples Distribution & Retail", "United States", "Large", "Blend"),
  ABBV: c("AbbVie", HC, "Biotechnology", "United States", "Large", "Blend"),
  MA: c("Mastercard", "Financials", "Financial Services", "United States", "Large", "Growth"),
  PLTR: c("Palantir", IT, "Software", "United States", "Large", "Growth", ["software_cloud"], "Application Software"),
  CSCO: c("Cisco Systems", IT, "Communications Equipment", "United States", "Large", "Value"),
  LRCX: c("Lam Research", IT, SEMI, "United States", "Large", "Growth", ["ai_infrastructure"], "Semiconductor Materials & Equipment"),
  AMAT: c("Applied Materials", IT, SEMI, "United States", "Large", "Growth", ["ai_infrastructure"], "Semiconductor Materials & Equipment"),
  // Health care fund holdings
  MRK: c("Merck", HC, "Pharmaceuticals", "United States", "Large", "Value"),
  UNH: c("UnitedHealth", HC, "Health Care Providers & Services", "United States", "Large", "Value"),
  TMO: c("Thermo Fisher", HC, "Life Sciences Tools & Services", "United States", "Large", "Blend"),
  AMGN: c("Amgen", HC, "Biotechnology", "United States", "Large", "Value"),
  GILD: c("Gilead Sciences", HC, "Biotechnology", "United States", "Large", "Value"),
  ABT: c("Abbott Laboratories", HC, "Health Care Equipment & Supplies", "United States", "Large", "Blend"),
  PFE: c("Pfizer", HC, "Pharmaceuticals", "United States", "Large", "Value"),
  // International top holdings
  TSM: c("Taiwan Semiconductor (TSMC)", IT, SEMI, "Taiwan", "Large", "Growth", ["ai_infrastructure"], "Semiconductors"),
  SSNLF: c("Samsung Electronics", IT, "Technology Hardware, Storage & Peripherals", "South Korea", "Large", "Value", ["ai_infrastructure"], undefined, "GICS puts Samsung in hardware, but memory chips (including AI memory) are a large part of its profit, so it is in the AI-infrastructure theme."),
  SKHY: c("SK hynix", IT, SEMI, "South Korea", "Large", "Growth", ["ai_infrastructure"], "Semiconductors"),
  ASML: c("ASML", IT, SEMI, "Netherlands", "Large", "Growth", ["ai_infrastructure"], "Semiconductor Materials & Equipment"),
  TCEHY: c("Tencent", CS, "Interactive Media & Services", "China", "Large", "Growth", ["ai_platforms", "digital_ads"]),
  HSBC: c("HSBC", "Financials", "Banks", "United Kingdom", "Large", "Value"),
  RHHBY: c("Roche", HC, "Pharmaceuticals", "Switzerland", "Large", "Value"),
  SHEL: c("Shell", "Energy", "Oil, Gas & Consumable Fuels", "United Kingdom", "Large", "Value"),
  RY: c("Royal Bank of Canada", "Financials", "Banks", "Canada", "Large", "Value"),
  NVS: c("Novartis", HC, "Pharmaceuticals", "Switzerland", "Large", "Value"),
  BABA: c("Alibaba", CD, "Broadline Retail", "China", "Large", "Value", ["ai_platforms", "software_cloud"]),
  MUFG: c("Mitsubishi UFJ Financial", "Financials", "Banks", "Japan", "Large", "Value"),
  AZN: c("AstraZeneca", HC, "Pharmaceuticals", "United Kingdom", "Large", "Blend"),
  NSRGY: c("Nestlé", "Consumer Staples", "Food Products", "Switzerland", "Large", "Value"),
  MDTKF: c("MediaTek", IT, SEMI, "Taiwan", "Large", "Blend", undefined, "Semiconductors"),
  SIEGY: c("Siemens", "Industrials", "Industrial Conglomerates", "Germany", "Large", "Blend"),
  BHP: c("BHP", "Materials", "Metals & Mining", "Australia", "Large", "Value"),
  SAP: c("SAP", IT, "Software", "Germany", "Large", "Growth", ["software_cloud"], "Application Software"),
  SAN: c("Banco Santander", "Financials", "Banks", "Spain", "Large", "Value"),
  TD: c("Toronto-Dominion Bank", "Financials", "Banks", "Canada", "Large", "Value"),
  TM: c("Toyota Motor", CD, "Automobiles", "Japan", "Large", "Value"),
  SHOP: c("Shopify", IT, "IT Services", "Canada", "Large", "Growth", ["software_cloud"]),
  ALIZY: c("Allianz", "Financials", "Insurance", "Germany", "Large", "Value"),
  SBGSY: c("Schneider Electric", "Industrials", "Electrical Equipment", "France", "Large", "Growth", ["ai_infrastructure"], undefined, "Data-center power and cooling equipment are a large growth driver."),
  CMWAY: c("Commonwealth Bank of Australia", "Financials", "Banks", "Australia", "Large", "Value"),
  TTE: c("TotalEnergies", "Energy", "Oil, Gas & Consumable Fuels", "France", "Large", "Value"),
  // Emerging-market top holdings
  "DELTA.TW": c("Delta Electronics", IT, "Electronic Equipment, Instruments & Components", "Taiwan", "Large", "Growth", ["ai_infrastructure"], undefined, "Power supplies and cooling for AI servers."),
  CICHF: c("China Construction Bank", "Financials", "Banks", "China", "Large", "Value"),
  HNHPF: c("Hon Hai Precision (Foxconn)", IT, "Electronic Equipment, Instruments & Components", "Taiwan", "Large", "Value", ["ai_infrastructure"], undefined, "Assembles AI servers as well as consumer electronics."),
  IDCBF: c("Industrial and Commercial Bank of China", "Financials", "Banks", "China", "Large", "Value"),
  HDB: c("HDFC Bank", "Financials", "Banks", "India", "Large", "Blend"),
  "RELIANCE.NS": c("Reliance Industries", "Energy", "Oil, Gas & Consumable Fuels", "India", "Large", "Blend"),
  "3711.TW": c("ASE Technology", IT, SEMI, "Taiwan", "Large", "Blend", ["ai_infrastructure"], "Semiconductors", "Chip packaging and testing."),
  IBN: c("ICICI Bank", "Financials", "Banks", "India", "Large", "Blend"),
  PDD: c("PDD Holdings", CD, "Broadline Retail", "China", "Large", "Value"),
  "BHARTIARTL.NS": c("Bharti Airtel", CS, "Diversified Telecommunication Services", "India", "Large", "Blend"),
  XIACF: c("Xiaomi", IT, "Technology Hardware, Storage & Peripherals", "China", "Large", "Growth"),
  BACHF: c("Bank of China", "Financials", "Banks", "China", "Large", "Value"),
  MPNGY: c("Meituan", CD, "Hotels, Restaurants & Leisure", "China", "Large", "Growth"),
  "1120.SR": c("Al Rajhi Bank", "Financials", "Banks", "Saudi Arabia", "Large", "Blend"),
  VALE: c("Vale", "Materials", "Metals & Mining", "Brazil", "Large", "Value"),
  "3037.TW": c("Unimicron", IT, "Electronic Equipment, Instruments & Components", "Taiwan", "Mid", "Blend"),
  UMC: c("United Microelectronics", IT, SEMI, "Taiwan", "Large", "Value", undefined, "Semiconductors"),
  "2383.TW": c("Elite Material", IT, "Electronic Equipment, Instruments & Components", "Taiwan", "Mid", "Growth"),
  // Small-cap value top holdings (sector only matters here)
  GATX: c("GATX", "Industrials", "Trading Companies & Distributors", "United States", "Small", "Value"),
  MATX: c("Matson", "Industrials", "Marine Transportation", "United States", "Small", "Value"),
  LYFT: c("Lyft", "Industrials", "Ground Transportation", "United States", "Small", "Value"),
  CROX: c("Crocs", CD, "Textiles, Apparel & Luxury Goods", "United States", "Small", "Value"),
  M: c("Macy's", CD, "Broadline Retail", "United States", "Small", "Value"),
  ANF: c("Abercrombie & Fitch", CD, "Specialty Retail", "United States", "Small", "Value"),
  LEA: c("Lear", CD, "Automobile Components", "United States", "Small", "Value"),
  RUSHA: c("Rush Enterprises", "Industrials", "Trading Companies & Distributors", "United States", "Small", "Value"),
  CAKE: c("Cheesecake Factory", CD, "Hotels, Restaurants & Leisure", "United States", "Small", "Value"),
  CBT: c("Cabot", "Materials", "Chemicals", "United States", "Small", "Value"),
  TREX: c("Trex", "Industrials", "Building Products", "United States", "Small", "Value"),
  SIG: c("Signet Jewelers", CD, "Specialty Retail", "United States", "Small", "Value"),
  TPC: c("Tutor Perini", "Industrials", "Construction & Engineering", "United States", "Small", "Value"),
  MUR: c("Murphy Oil", "Energy", "Oil, Gas & Consumable Fuels", "United States", "Small", "Value"),
  SM: c("SM Energy", "Energy", "Oil, Gas & Consumable Fuels", "United States", "Small", "Value"),
};

/** Market type and region for each country. MSCI conventions (South Korea is emerging). */
export const COUNTRY: Record<string, { market: "US" | "Developed ex-US" | "Emerging"; region: "North America" | "Europe" | "Asia-Pacific" | "Latin America" | "Middle East & Africa" }> = {
  "United States": { market: "US", region: "North America" },
  Canada: { market: "Developed ex-US", region: "North America" },
  Japan: { market: "Developed ex-US", region: "Asia-Pacific" }, Australia: { market: "Developed ex-US", region: "Asia-Pacific" },
  "Hong Kong": { market: "Developed ex-US", region: "Asia-Pacific" }, Singapore: { market: "Developed ex-US", region: "Asia-Pacific" },
  "United Kingdom": { market: "Developed ex-US", region: "Europe" }, Switzerland: { market: "Developed ex-US", region: "Europe" },
  France: { market: "Developed ex-US", region: "Europe" }, Germany: { market: "Developed ex-US", region: "Europe" },
  Netherlands: { market: "Developed ex-US", region: "Europe" }, Spain: { market: "Developed ex-US", region: "Europe" },
  Taiwan: { market: "Emerging", region: "Asia-Pacific" }, China: { market: "Emerging", region: "Asia-Pacific" },
  "South Korea": { market: "Emerging", region: "Asia-Pacific" }, India: { market: "Emerging", region: "Asia-Pacific" },
  Malaysia: { market: "Emerging", region: "Asia-Pacific" }, Thailand: { market: "Emerging", region: "Asia-Pacific" },
  Brazil: { market: "Emerging", region: "Latin America" }, Mexico: { market: "Emerging", region: "Latin America" },
  "South Africa": { market: "Emerging", region: "Middle East & Africa" }, "Saudi Arabia": { market: "Emerging", region: "Middle East & Africa" },
  "United Arab Emirates": { market: "Emerging", region: "Middle East & Africa" },
};

/**
 * Global market weights used as a neutral reference point (not a target): MSCI ACWI, the standard
 * global large/mid-cap benchmark. Only figures shown on the factsheet are included.
 */
export const BENCHMARK = {
  label: "MSCI ACWI",
  source: { label: "MSCI ACWI Index factsheet", url: "https://www.msci.com/documents/10199/a71b65b5-d0ea-4b5c-a709-24b1213bc3c5", asOf: "2026-10-30" },
  sectors: { "Information Technology": 0.3118, Financials: 0.1663, Industrials: 0.1023, "Health Care": 0.0936, "Consumer Discretionary": 0.0857, "Communication Services": 0.0704, "Consumer Staples": 0.0509, Energy: 0.0449, Materials: 0.0345, Utilities: 0.0244, "Real Estate": 0.0153 } as Record<Sector, number>,
  countries: { "United States": 0.6463, Japan: 0.0508, Taiwan: 0.0323, "United Kingdom": 0.0312, Canada: 0.0306 } as Record<string, number>,
  top10: 0.2426,
};

/** Morningstar super-sectors: how sensitive each sector is to the economic cycle. */
export const SUPER_SECTOR: Record<Sector, "Cyclical" | "Sensitive" | "Defensive"> = {
  Materials: "Cyclical", "Consumer Discretionary": "Cyclical", Financials: "Cyclical", "Real Estate": "Cyclical",
  "Communication Services": "Sensitive", Energy: "Sensitive", Industrials: "Sensitive", "Information Technology": "Sensitive",
  "Consumer Staples": "Defensive", "Health Care": "Defensive", Utilities: "Defensive",
};
