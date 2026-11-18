import { Card, CardHead, Disclose } from "@/components/ui";
import { AnalystUpload } from "@/components/AnalystUpload";
import { createClient } from "@/lib/supabase/server";
import { loadAnalyst } from "@/lib/analyst/job";
import { estimateHistory, type AnalystReport } from "@/lib/analyst/report";
import { shortDate, usd } from "@/lib/format";

const fmt = (v: number, unit: string) => (unit.toUpperCase().startsWith("USD") ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit.replace(/^USD/i, "").trim() ? ` ${unit.replace(/^USD/i, "").trim()}` : ""}` : `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`);

function Report({ r, price }: { r: AnalystReport & { id: string }; price: number | null }) {
  const v = r.fairValue ?? r.priceTarget;
  const gap = v && price ? v / price - 1 : null;
  return (
    <li className="border-t border-line pt-2 flex flex-col gap-1.5">
      <div className="t-sm"><span className="text-ink font-semibold">{r.publisher ?? "Analyst report"}</span> · {r.reportDate ? shortDate(r.reportDate) : `uploaded ${shortDate(r.at)}`}{r.rating ? ` · ${r.rating}` : ""}{r.moat ? ` · moat ${r.moat}` : ""}{r.uncertainty ? ` · uncertainty ${r.uncertainty}` : ""}</div>
      {v !== null && (
        <p className="t-sm num">{r.fairValue !== null ? "Fair value (today)" : `Price target${r.horizon ? ` (${r.horizon})` : ""}`} {usd(v, 2)}{r.fairValue !== null && r.priceTarget !== null ? ` · target ${usd(r.priceTarget, 2)}` : ""}{gap !== null ? ` · ${gap >= 0 ? "+" : ""}${Math.round(gap * 100)}% vs today's price` : ""}{r.priceAtReport ? ` · price in report ${usd(r.priceAtReport, 2)}` : ""}</p>
      )}
      {r.valueBasis && <p className="t-xs">Basis: {r.valueBasis}</p>}
      {r.comparison.summary && <p className="t-sm text-ink">{r.comparison.summary}</p>}
      {r.comparison.differ.length > 0 && <div className="t-sm"><span className="t-xs">Where it differs from the app&apos;s research</span><ul className="list-disc pl-4">{r.comparison.differ.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      {r.comparison.notInResearch.length > 0 && <div className="t-sm"><span className="t-xs warn">In the report, not in the app&apos;s research</span><ul className="list-disc pl-4">{r.comparison.notInResearch.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      <Disclose summary={<span className="t-xs">Agreements, reasons, risks and estimates</span>}>
        <div className="t-xs flex flex-col gap-1.5">
          {r.comparison.agree.length > 0 && <div><span className="text-ink">Agrees with the app</span><ul className="list-disc pl-4">{r.comparison.agree.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          {r.points.length > 0 && <div><span className="text-ink">Its reasons</span><ul className="list-disc pl-4">{r.points.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          {r.risks.length > 0 && <div><span className="text-ink">Its risks</span><ul className="list-disc pl-4">{r.risks.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          {r.estimates.length > 0 && (
            <table className="w-full"><tbody>{r.estimates.map((e, i) => <tr key={i} className="border-b border-line last:border-b-0"><td className="py-1 pr-2">{e.metric.replace(/_/g, " ")}</td><td className="py-1 pr-2">{e.period}</td><td className="py-1 pr-2 text-right num">{fmt(e.value, e.unit)}</td><td className="py-1 text-right">{e.page ? `p. ${e.page}` : ""}</td></tr>)}</tbody></table>
          )}
          <span>File: {r.fileName} · read by AI for ${r.costUsd.toFixed(2)}; check key numbers against the page shown.</span>
        </div>
      </Disclose>
    </li>
  );
}

/** Analyst reports you uploaded for this company, compared with the app's research, with estimate history. */
export async function AnalystCard({ symbol, price }: { symbol: string; price: number | null }) {
  const db = await createClient();
  const a = await loadAnalyst(db, symbol).catch(() => ({ reports: [], failed: [], running: false }));
  const history = estimateHistory(a.reports).filter((h) => h.points.length >= 2).slice(0, 8);
  return (
    <Card labelledBy="an-h" className="!gap-2">
      <CardHead id="an-h" title="Analyst reports" />
      <p className="t-xs">Upload a report you have access to (Morningstar, Schwab, CFRA, a broker note). The AI reads it once, about $0.10 to $0.30, and compares it with the research in use: values put on the same basis, where they differ and why, and anything the research misses. Reports stay private and are never put in a shared PDF. An analyst view is an input to weigh, not a reason on its own.</p>
      <AnalystUpload symbol={symbol} running={a.running} />
      {a.failed.map((f) => <p key={f.id} className="t-xs warn">{f.fileName}: {f.error}</p>)}
      {a.reports.length > 0 && <ul className="flex flex-col gap-2">{a.reports.map((r) => <Report key={r.id} r={r} price={price} />)}</ul>}
      {history.length > 0 && (
        <Disclose summary={<span className="t-xs">Estimate history across your reports</span>}>
          <table className="t-xs w-full"><tbody>
            {history.map((h) => (
              <tr key={h.key} className="border-b border-line last:border-b-0 align-top">
                <td className="py-1 pr-2">{h.metric.replace(/_/g, " ")} {h.period}</td>
                <td className="py-1">{h.points.map((p, i) => <span key={i} className="block num">{shortDate(p.date)} {p.publisher ?? ""}: {fmt(p.value, h.unit)}{i > 0 ? ` (${p.value >= h.points[i - 1].value ? "+" : ""}${(((p.value / h.points[i - 1].value) - 1) * 100).toFixed(1)}%)` : ""}</span>)}</td>
              </tr>
            ))}
          </tbody></table>
        </Disclose>
      )}
    </Card>
  );
}
