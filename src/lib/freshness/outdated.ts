/**
 * Is a saved analysis (morning briefing, portfolio plan, assistant answer) still built on today's facts?
 *
 * A saved analysis is a historical record: it is never rewritten. This module only decides whether it may
 * still be shown as the current view, by comparing when it was written with when its inputs last changed
 * (policy, holdings, cash, recorded transactions, research), and by catching reserve amounts in its text
 * that contradict the approved rule. Pure and deterministic; the loader lives in contextEvents.ts.
 */
export type ContextKind = "policy" | "holdings" | "cash" | "transactions" | "research";
export type ContextEvent = { kind: ContextKind; at: string; label: string };

export type OutdatedVerdict = {
  outdated: boolean;
  /** Each change after the analysis was written, newest first, at most one line per kind and subject. */
  changes: ContextEvent[];
  /** Statements in the text that contradict current facts (e.g. "$10,000 reserve" when $3,000 is approved). */
  contradictions: string[];
  headline: string;
};

const KIND_WORD: Record<ContextKind, string> = { policy: "policy", holdings: "holdings", cash: "cash", transactions: "recorded trades and deposits", research: "research" };

/** Dollar amounts the text calls a reserve, e.g. "$10,000 reserve", "reserve of $10k", "$10,000 protected savings". */
export function reserveMentions(text: string): number[] {
  const out: number[] = [];
  const amt = String.raw`\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|K|thousand)?`;
  const patterns = [
    new RegExp(`${amt}\\s+(?:protected\\s+|savings\\s+|cash\\s+|emergency\\s+)*(?:reserve|savings floor|protected savings)`, "g"),
    new RegExp(`(?:reserve|savings floor|protected savings)\\s+(?:of|is|at|=|:|stays at|remains)?\\s*${amt}`, "g"),
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  }
  return [...new Set(out)];
}

/** What the policy in force today says, for catching superseded assumptions in an older analysis. */
export type PolicyFacts = {
  /** Companies whose limit you approved, with the date. */
  approved: { symbol: string; at: string }[];
  /** Bucket or company rules still imported from the archive (guidelines you have not approved). */
  imported: string[];
};

/**
 * Statements in an older analysis that rely on assumptions no longer in force: retired return hurdles and the
 * placeholder ETF return, limit conflicts you have since resolved, the cash guide range treated as a target,
 * and an imported bucket range presented as a VOO limit. Pure text checks; the analysis itself is never edited.
 */
export function supersededMentions(text: string, facts: PolicyFacts, perSymbol: { symbol: string; text: string }[] = []): string[] {
  const out: string[] = [];
  if (/\bhurdle\b|assumed 7%|7% (?:return )?assumption|ETF return (?:and|&) hurdle|ETF return assumption/i.test(text))
    out.push("It applies a fixed return hurdle or a 7% ETF-return assumption. Both are retired: stocks are now compared with published forecasts, Treasuries and cash over matching horizons.");
  // Only statements about the LIMIT being undecided count; "research not approved" is a different, valid statement.
  const undecided = /(?:limit|ceiling|maximum|allocation)[^.]{0,50}(?:disagree|conflict|undecided|unresolved|not (?:yet )?approved|provisional)|(?:disagree|conflict|undecided|unresolved|approve (?:one|a limit|the limit)|decide which)[^.]{0,50}(?:limit|ceiling|maximum|allocation)/i;
  const sentences = text.split(/(?<=[.;!?])\s+/);
  for (const a of facts.approved) {
    const sym = new RegExp(`\\b${a.symbol.replace(/[^A-Z.]/g, "")}\\b`);
    const inText = sentences.some((x) => sym.test(x) && undecided.test(x));
    const own = perSymbol.filter((x) => x.symbol === a.symbol).some((x) => x.text.split(/(?<=[.;!?])\s+/).some((y) => undecided.test(y)));
    if (inText || own) out.push(`It treats the ${a.symbol} limit as undecided; you approved it on ${a.at.slice(0, 10)}.`);
  }
  if (/cash (?:is )?(?:below|under) \d+(?:\.\d+)?%|cash rebuilt|(?:rebuild|build|raise|top up)[^.]{0,40}cash[^.]{0,60}(?:toward|to|reach(?:es)?)\s+(?:about\s+)?\d+(?:\.\d+)?%|below the \d+[–-]\d+% (?:policy )?range/i.test(text))
    out.push("It treats the 5–15% deployable-cash range as a target to rebuild or a reason to wait. That range is only a guide: being below it is not a reason to buy, sell or delay.");
  if (facts.imported.includes("US broad-market equity") && /(?:US|U\.S\.)(?: broad-market)? bucket[^.]{0,40}\d+% (?:limit|max)|VOO[^.]{0,80}(?:ceiling|\d+% limit)/i.test(text))
    out.push("It presents the US broad-market range as a VOO limit. That range is an imported guideline you have not approved, and a revision without a maximum is waiting for you on the Policy page.");
  return out;
}

/**
 * Compares an analysis with what changed after it was written. `kinds` limits the inputs it depends on
 * (a market-only report does not go stale when a trade is recorded).
 */
export function outdatedVerdict(args: {
  writtenAt: string;
  events: ContextEvent[];
  text?: string | null;
  currentReserve?: number | null;
  kinds?: ContextKind[];
  policy?: PolicyFacts | null;
  /** Text written about one company (e.g. a plan's position reason), checked against that company's approval. */
  perSymbol?: { symbol: string; text: string }[];
}): OutdatedVerdict {
  const t0 = Date.parse(args.writtenAt);
  const relevant = args.events
    .filter((e) => (!args.kinds || args.kinds.includes(e.kind)) && Date.parse(e.at) > t0)
    .sort((a, b) => b.at.localeCompare(a.at));
  const seen = new Set<string>();
  const changes = relevant.filter((e) => {
    const key = `${e.kind}|${e.label}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });

  const contradictions: string[] = [];
  if (args.text && args.currentReserve) {
    const wrong = reserveMentions(args.text).filter((n) => Math.abs(n - args.currentReserve!) > 1);
    if (wrong.length) contradictions.push(`It uses a $${wrong.map((n) => n.toLocaleString("en-US")).join(" / $")} reserve; the approved reserve is $${args.currentReserve.toLocaleString("en-US")}.`);
  }
  if (args.text && args.policy) contradictions.push(...supersededMentions(args.text, args.policy, args.perSymbol));

  const kinds = [...new Set(changes.map((c) => c.kind))];
  const outdated = changes.length > 0 || contradictions.length > 0;
  const headline = !outdated
    ? "Built on your current policy, holdings, cash and research."
    : contradictions.length && !kinds.length
      ? "Outdated: it contradicts your current policy."
      : `Outdated: your ${joinWords(kinds.map((k) => KIND_WORD[k]))} changed after it was written.`;
  return { outdated, changes: changes.slice(0, 8), contradictions, headline };
}

function joinWords(w: string[]) {
  return w.length <= 1 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}
