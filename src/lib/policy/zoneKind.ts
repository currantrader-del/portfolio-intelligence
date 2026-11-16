/**
 * Which kind of price band the research wrote, read from its own words. Shared by the "What to do" verb,
 * the price bar and the refresh check, so they can never disagree.
 *
 * The band's first instruction decides, and negations come before keywords: "No new money. ... a lower price
 * alone is not a reason to add" is a hold band (2026-11-16: MU showed "Buy more" for that text), and
 * "Hold, no add. ... after the print, trim to 12% unless ..." is a hold band (2026-11-14: NVDA showed "Trim").
 */
export type ZoneKind = "buy" | "hold" | "trim";

const LEAD_HOLD = /^(hold|keep|no add|no new|no buy|no trade|no position|not\b|nothing|do not|don't|never|wait|watch|avoid|pass|stay out|stand aside|do nothing)\b/;
const LEAD_TRIM = /^(trim|sell|exit|reduce|take profits?|cut)\b/;
const LEAD_BUY = /^(buy|add|accumulate|starter|start a position|initiate|build)\b/;
/** "no new money", "not a reason to add", "don't buy", "without adding": the verb is negated, so it is not an instruction. */
const NEGATED = /\b(no|not|never|nor|without|don't|do not|isn't|is not|avoid)\b[^.;:]{0,40}?\b(add\w*|buy\w*|accumulat\w*|starter|initiat\w*|trim\w*|sell\w*|reduc\w*|exit\w*)\b/g;

export function zoneKind(action: string): ZoneKind {
  const a = action.toLowerCase().replace(/\s+/g, " ").trim();
  if (LEAD_HOLD.test(a)) return "hold";
  if (LEAD_TRIM.test(a)) return "trim";
  if (LEAD_BUY.test(a)) return "buy";
  const rest = a.replace(NEGATED, " ");
  if (/\b(trim\w*|sell|reduc\w*|exit|take profits?|re-underwrite)\b/.test(rest)) return "trim";
  if (/\b(hold|watch|wait|no new money|no position)\b/.test(rest)) return "hold";
  if (/\b(add|buy|accumulate|starter|start a position|initiate)\b/.test(rest)) return "buy";
  return "hold";
}
