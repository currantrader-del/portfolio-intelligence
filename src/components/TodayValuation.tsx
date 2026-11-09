import type { Workspace } from "@/lib/workspace";
import { getQuote } from "@/lib/market/quotes";
import { scenarioReturnsAt, zoneFor } from "@/lib/research/valuation";
import { getFilings } from "@/lib/market/sec";
import { assessVsAlternatives, refreshState, riskFreeFor } from "@/lib/policy/evidence";
import { AGE_REMINDER_DAYS } from "@/lib/policy/limits";
import { researchAgeDays } from "@/lib/research/records";
import { coverage } from "@/lib/research/status";
import { pctStr, shortDate, usd } from "@/lib/format";
import { Bar, Card, CardHead, DataLabel, Disclose, LinkRow, Metric, Pill } from "./ui";
import { ZoneBar, toZoneViews } from "./ZoneBar";

const cap1 = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "—");

/**
 * Company Research card: the stored research (dated) re-priced at today's price, with the
 * labels kept separate. The research's scenario values are never changed here; only the price
 * and the time left move. When research cannot be re-priced, no return is shown.
 */
/** The short, decision-first text for the top of a research page, taken from the research in use. */
export type Brief = {
  /** Where the text comes from, e.g. "Nov 8 full investigation". */
  from: string;
  /** Action/confidence as the record in use shows them (reviewer annotations applied). Falls back to the parsed record. */
  action?: string | null;
  confidence?: string | null;
  headline?: string | null;
  thesis: string | null;
  risks: string[];
  wouldChange: string[];
  /** Material open items: open evidence gaps, unreconciled inputs, questions that could change the conclusion. */
  unresolved: string[];
  /** A newer investigation waiting for your decision (not used until approved). */
  pending?: { date: string; action: string | null; confidence: string | null; running: boolean } | null;
};

const SHOWN = 3;
function ShortList({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  if (!items.length) return null;
  const more = items.slice(SHOWN);
  return (
    <div className="t-sm flex flex-col gap-0.5">
      <span className={`t-xs ${tone ?? ""}`}>{title}{items.length > SHOWN ? ` · ${items.length}` : ""}</span>
      <ul className="list-disc pl-4 flex flex-col gap-0.5">{items.slice(0, SHOWN).map((x, i) => <li key={i}>{x}</li>)}</ul>
      {more.length > 0 && (
        <Disclose summary={<span className="t-xs">{more.length} more</span>} className="-my-1">
          <ul className="list-disc pl-4 flex flex-col gap-0.5">{more.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </Disclose>
      )}
    </div>
  );
}

export async function InvestmentSummary({ ws, symbol, brief }: { ws: Workspace; symbol: string; brief?: Brief | null }) {
  const r = ws.research.find((x) => x.symbol === symbol);
  const h = ws.portfolio.holdings.find((x) => x.symbol === symbol);
  const q = ws.quotes.get(symbol) ?? (await getQuote(symbol));
  const price = q?.price ?? h?.price ?? null;
  const v = r?.current;
  const any = r?.current ?? r?.latest;
  const age = r ? researchAgeDays(r, ws.now) : null;
  const filings = v ? await getFilings(symbol, ws.now).catch(() => null) : null;
  const st = v ? refreshState({ asOf: v.research_as_of, pc: v.parsed, price, filings: filings && !("error" in filings) ? filings : null }) : null;
  const check = st ? { ok: st.status !== "refresh", reason: st.triggers.map((t) => t.detail).join("; ") } : null;
  const exp0 = ws.portfolio.exposures.find((e) => e.symbol === symbol);
  const lim0 = ws.policy?.companies[symbol];
  const years = v?.parsed.horizonDate ? Math.max(0.25, (new Date(v.parsed.horizonDate).getTime() - ws.now.getTime()) / (365.25 * 864e5)) : 10;
  const cmp = v && price && check?.ok ? assessVsAlternatives(v.parsed, price, ws.now, {
    riskFree: riskFreeFor(years, ws.yields ?? { y2: null, y10: null }), weightNow: exp0?.total ?? null,
    limit: exp0?.hasLimit ? { normalHigh: lim0?.normal?.high ?? null, hcHigh: lim0?.highConviction?.high ?? null, max: exp0.max } : null, completeness: v.completeness, confidence: v.parsed.confidence,
  }) : null;
  const er = cmp?.expected ?? null;
  const scen = v && price && check?.ok ? scenarioReturnsAt(v.parsed, price, ws.now) : [];
  const zone = v && price ? zoneFor(v.parsed.zones, price) : null;
  const exp = exp0;
  const cov = coverage(r, price, ws.now, AGE_REMINDER_DAYS);
  const lim = lim0;

  return (
    <Card labelledBy="inv-h">
      <CardHead id="inv-h" cap="Investment summary" right={<span className="pill" style={{ color: cov.tone === "gain" ? "var(--gain)" : cov.tone === "warn" ? "var(--warn-ink)" : undefined, background: cov.tone === "warn" ? "var(--warn-bg)" : undefined }} title={cov.detail}><span className={`dot ${cov.dot === "hollow" ? "dot-hollow" : ""}`} aria-hidden="true" />Research in use: {cov.label.toLowerCase()}{r?.approval === "provisional" ? ", open questions" : ""}</span>} />
      {r && r.authoritative === false && (r.current || r.latest) && <p className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">Preliminary research only for {symbol}. The record below is {r.authority === "preliminary_screen" ? "a preliminary screen" : "older research"}: enough for Hold or No Add, but the app makes no add, buy-range or target recommendation from it until a targeted investigation is done.</p>}
      {any?.parsed.classification && <span className="t-xs -mt-1">Classification: <span className="text-ink">{any.parsed.classification}</span></span>}
      {any ? (
        <div className="grid grid-cols-3 gap-x-2 gap-y-3">
          <Metric label="Action" value={brief?.action || cap1(any.parsed.action)} />
          <Metric label="Confidence" value={cap1(brief?.confidence ?? any.parsed.confidence)} />
          <Metric label="Research" value={shortDate(any.research_as_of).replace(/, \d{4}$/, "")} note={age !== null ? `${age} days old` : undefined} />
          <Metric label="Price" value={price ? usd(price, 2) : "—"} note={!q && h ? "statement price" : "delayed"} />
          <Metric label="Estimated value" value={v?.parsed.weightedValue ? usd(v.parsed.weightedValue, 2) : "—"} note={v?.parsed.weightedValue ? (v.parsed.horizonDate ? `weighted, by ${shortDate(v.parsed.horizonDate).replace(/^[A-Za-z]+ \d+, /, "")}` : "weighted") : undefined} />
          <Metric label="Expected return" value={er === null ? "—" : `≈ ${pctStr(er)}`} note={er === null ? (v && !check?.ok ? "not re-priced" : undefined) : "a year"} />
        </div>
      ) : (
        <p className="t-sm">No research on file for {symbol}. Run the screen below, then start full research before comparing it for new money.</p>
      )}
      {r?.pendingReview && (
        <p className="t-xs warn">Newer research awaiting your approval: the {shortDate(r.pendingReview.research_as_of)} investigation{brief?.pending && !brief.pending.running && brief.pending.action ? ` (${brief.pending.action}${brief.pending.confidence ? `, ${brief.pending.confidence.toLowerCase()} confidence` : ""})` : ""}. The figures above use the research in use until you approve it; the decision is below.</p>
      )}

      {v && (
        <>
          <div className="divider" />
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3"><span className="t-sm">Valuation at today&apos;s price</span><DataLabel kind="model" /></div>
            {v.parsed.zones.length > 0 && <ZoneBar zones={toZoneViews(v.parsed.zones)} price={price} unapproved={r?.authoritative === false} />}
            {zone && <span className="t-xs">Band today: {zone.label} · {zone.action}. {r?.authoritative === false ? "From preliminary research: context only." : "A prompt to research, not a trade."}</span>}
            {check?.ok ? (
              <>
                {cmp && (
                  <Disclose className="-my-1" summary={<span className="flex items-center justify-between gap-3 t-sm w-full"><span>Valuation only: modeled return vs VOO and Treasuries</span><span className={cmp.judgment === "favourable" ? "gain" : cmp.judgment === "unfavourable" ? "warn" : ""}>{cmp.judgment === "favourable" ? "Favourable" : cmp.judgment === "unfavourable" ? "Unfavourable" : "Mixed"}</span></span>}>
                    <div className="flex flex-col gap-1">
                      <ul className="t-xs flex flex-col gap-0.5">{cmp.factors.map((f) => <li key={f.label}><span className="text-ink">{f.label}:</span> {f.finding}</li>)}</ul>
                      <span className="t-xs">How attractive the valuation looks is one input, not the recommendation. What to do comes from the research&apos;s action{any?.parsed.action ? ` (${brief?.action || cap1(any.parsed.action)})` : ""} and, for new money, the comparison on Decisions.</span>
                    </div>
                  </Disclose>
                )}
                {st?.status === "unverified" && <span className="t-xs warn">{check?.reason}</span>}
              </>
            ) : (
              <p className="t-sm rounded-[12px] bg-warn-bg text-warn-ink px-3 py-2">Not re-priced until the research is refreshed: {check?.reason}</p>
            )}
          </div>
        </>
      )}

      <div className="divider" />
      {exp ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3"><span className="t-sm">Your exposure</span><span className="t-sm num text-ink">{pctStr(exp.total)} <span className="t-xs">of max {pctStr(exp.max, 0)}</span></span></div>
          <Bar thin value={exp.total} max={exp.max} markers={lim?.normal ? [lim.normal.low, lim.normal.high] : []} label={`${pctStr(exp.total)} of a ${pctStr(exp.max, 0)} maximum`} />
          {lim && (lim.normal || lim.highConviction) && <span className="t-xs">Your limits: {lim.normal ? `normal ${pctStr(lim.normal.low, 0)}–${pctStr(lim.normal.high, 0)}` : ""}{lim.normal && lim.highConviction ? " · " : ""}{lim.highConviction ? `high conviction up to ${pctStr(lim.highConviction.high, 0)}` : ""} · maximum {pctStr(exp.max, 0)}</span>}
          <span className="t-xs">{pctStr(exp.direct)} direct · {pctStr(exp.viaEtfs)} through ETFs (approx.){exp.totalMax - exp.total > 0.0005 ? `; could be up to ${pctStr(exp.totalMax)} in total because fund holdings are only partly published` : ""} · room {usd(exp.headroomDollars)}{exp.totalMax - exp.total > 0.0005 ? " (on the upper figure)" : ""}</span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3"><span className="t-sm">Your exposure</span><span className="t-sm">Not held</span></div>
      )}

      {brief && (brief.thesis || brief.headline || brief.risks.length > 0 || brief.unresolved.length > 0 || brief.wouldChange.length > 0) && (
        <>
          <div className="divider" />
          <div className="flex flex-col gap-2.5">
            {(brief.thesis || brief.headline) && (
              <div className="t-sm flex flex-col gap-0.5">
                <span className="t-xs">Main thesis · {brief.from}</span>
                <p className="leading-relaxed text-ink">{brief.thesis || brief.headline}</p>
              </div>
            )}
            <ShortList title="Principal risks" items={brief.risks} />
            <ShortList title="Material unresolved issues" items={brief.unresolved} tone="warn" />
            <ShortList title="What would change the recommendation" items={brief.wouldChange} />
          </div>
        </>
      )}

      {scen.length > 0 && (
        <div className="border-t border-line -mb-2">
          <Disclose summary="Scenarios at today's price">
            <div className="overflow-x-auto -mx-1">
              <table className="tbl">
                <thead><tr><th>Scenario</th><th className="n">Prob.</th><th className="n">Value at horizon</th><th className="n">A year from today</th></tr></thead>
                <tbody>
                  {scen.map((s) => <tr key={s.name}><td className="capitalize">{s.name}</td><td className="n">{pctStr(s.probability, 0)}</td><td className="n">{usd(s.value, 2)}</td><td className="n">{pctStr(s.annualized)}</td></tr>)}
                  <tr><td className="text-ink font-semibold">Weighted</td><td /><td className="n text-ink">{usd(v!.parsed.weightedValue, 2)}</td><td className="n text-ink">{pctStr(er)}</td></tr>
                </tbody>
              </table>
            </div>
            <p className="t-xs">Scenario values are from the {shortDate(v!.research_as_of)} research ({v!.completeness}); only the price ({price ? usd(price, 2) : "—"}{q ? `, ${q.provider} delayed` : ""}) and the time left to {shortDate(v!.parsed.horizonDate)} changed. Reference {usd(v!.parsed.referencePrice, 2)} on {shortDate(v!.parsed.referenceDate)}.</p>
          </Disclose>
        </div>
      )}
      {h && <LinkRow href={`/decisions/review/${symbol}`}>Review this position</LinkRow>}
      {!q && h && <Pill tone="warn" small>Statement price</Pill>}
    </Card>
  );
}
