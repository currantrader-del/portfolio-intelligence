/**
 * The Today brief, written by code from computed numbers. The AI layer may expand on it,
 * but these sentences never contain a number the engine did not produce.
 */
import type { Alert } from "@/lib/alerts/rules";
import type { PortfolioView } from "@/lib/portfolio/engine";

export type Brief = { headline: string; sentences: string[] };

export function writeBrief(p: PortfolioView, spyDayPct: number | null, alerts: Alert[]): Brief {
  const sentences: string[] = [];
  if (p.dayPct === null) {
    sentences.push("Live prices are not available right now, so values are from your latest statements.");
  } else {
    const gap = spyDayPct !== null ? p.dayPct - spyDayPct : null;
    const movers = p.holdings
      .filter((h) => h.contributionPts !== null)
      .sort((a, b) => Math.abs(b.contributionPts!) - Math.abs(a.contributionPts!));
    const top = movers[0];
    if (spyDayPct !== null) {
      const word = Math.abs(gap!) < 0.002 ? "in line with" : gap! > 0 ? "ahead of" : "behind";
      sentences.push(`You are ${fmt(p.dayPct)} today, ${word} the S&P 500 at ${fmt(spyDayPct)}.`);
    } else {
      sentences.push(`You are ${fmt(p.dayPct)} today.`);
    }
    if (top && Math.abs(top.contributionPts!) >= 0.05) {
      const share = p.dayPct !== 0 ? Math.round((top.contributionPts! / (p.dayPct * 100)) * 100) : null;
      sentences.push(
        `${top.symbol} (${fmt(top.dayPct!)}) moved the portfolio most, ${pts(top.contributionPts!)}` +
          (share !== null && share > 30 && share < 300 ? `, about ${share}% of the day's move.` : "."),
      );
    }
  }
  const high = alerts.filter((a) => a.severity === "high");
  const med = alerts.filter((a) => a.severity === "medium");
  if (high.length) sentences.push(`${high.length === 1 ? "One decision needs" : `${high.length} decisions need`} attention: ${high.map((a) => a.title).join("; ")}.`);
  else if (med.length) sentences.push(`Nothing urgent. ${med.length} item${med.length > 1 ? "s" : ""} to review when convenient.`);
  else sentences.push("Nothing needs a decision today.");

  const headline = p.dayPct === null ? "Statement values" : fmt(p.dayPct);
  return { headline, sentences };
}

function fmt(n: number) {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)}%`;
}
function pts(n: number) {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)} pts`;
}
