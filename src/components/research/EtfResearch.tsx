import type { SupabaseClient } from "@supabase/supabase-js";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { pctStr, shortDate, usd } from "@/lib/format";
import { ETF_CHECK_ESTIMATE, etfFacts, type EtfCheck } from "@/lib/research/etf";
import type { PortfolioView } from "@/lib/portfolio/engine";
import { EtfCheckRunner } from "./EtfCheckRunner";

type Stored = { at: string; ok: boolean; error?: string; check?: EtfCheck; costUsd?: number; model?: string | null };

async function latestCheck(db: SupabaseClient, symbol: string): Promise<Stored | null> {
  const { data } = await db.from("model_runs").select("computed_at, outputs").eq("kind", "etf_check").eq("outputs->>symbol", symbol).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const o = data.outputs as Omit<Stored, "at">;
  return { at: data.computed_at as string, ...o };
}

const VERDICT_TONE = { Add: "gain", Hold: "neutral", Skip: "warn" } as const;
const pct1 = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

/** The research page for an ETF: free facts from the app's data, plus the paid ETF check when you start one. */
export async function EtfResearch({ db, symbol, portfolio, now }: { db: SupabaseClient; symbol: string; portfolio: PortfolioView; now: Date }) {
  const f = etfFacts(symbol, portfolio, now);
  const last = await latestCheck(db, symbol).catch(() => null);
  const c = last?.ok ? last.check ?? null : null;
  const estimate = `About $${ETF_CHECK_ESTIMATE.low.toFixed(2)}-$${ETF_CHECK_ESTIMATE.high.toFixed(2)}, 1-3 minutes`;
  const statusTone = f.group?.status === "above" || f.group?.status === "over_max" ? "warn" : f.group?.status === "below" ? "gain" : "neutral";
  return (
    <>
      <Card className="!gap-2">
        <CardHead cap="ETF check" right={c ? <Pill tone={VERDICT_TONE[c.verdict]}>{c.verdict}</Pill> : undefined} />
        {c ? (
          <>
            <p className="text-ink font-semibold">{c.verdict === "Add" ? `Add${c.amount ? ` ${c.amount}` : ""}` : c.verdict === "Hold" ? "Hold what you have; no new money needed here" : "Skip for now"}</p>
            <p className="t-sm">{c.why}</p>
            <ul className="t-sm flex flex-col">
              <li className="flex justify-between gap-3 py-1 border-t border-line"><span>Yearly fee</span><span className="num text-ink">{c.expense_ratio_pct === null ? "—" : `${c.expense_ratio_pct.toFixed(2)}%`}</span></li>
              <li className="flex justify-between gap-3 py-1 border-t border-line"><span>Valuation (P/E · P/B)</span><span className="num text-ink">{c.valuation.pe ?? "—"} · {c.valuation.pb ?? "—"}</span></li>
              <li className="flex justify-between gap-3 py-1 border-t border-line"><span>Return 1y · 5y a year</span><span className="num text-ink">{pct1(c.returns.y1_pct)} · {pct1(c.returns.y5_ann_pct)}</span></li>
              <li className="flex justify-between gap-3 py-1 border-t border-line"><span>VOO 1y · 5y a year</span><span className="num text-ink">{pct1(c.returns.voo_y1_pct)} · {pct1(c.returns.voo_y5_ann_pct)}</span></li>
            </ul>
            {c.valuation.vs_sp500 && <p className="t-xs">{c.valuation.vs_sp500}</p>}
            {c.factor_tilt && <p className="t-xs"><span className="text-ink">Tilt:</span> {c.factor_tilt}</p>}
            {c.role && <p className="t-xs"><span className="text-ink">Role:</span> {c.role}</p>}
            {c.risks.length > 0 && <Disclose summary={<span className="t-sm">Risks · {c.risks.length}</span>}><ul className="t-sm list-disc pl-5">{c.risks.map((r) => <li key={r}>{r}</li>)}</ul></Disclose>}
            <Disclose summary={<span className="t-sm">Sources · {c.sources.length}{c.not_verified.length ? ` · ${c.not_verified.length} not verified` : ""}</span>}>
              <ul className="t-xs flex flex-col gap-1">{c.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>{s.date ? ` (${shortDate(s.date)})` : ""}</li>)}</ul>
              {c.not_verified.length > 0 && <p className="t-xs mt-2">Not verified: {c.not_verified.join("; ")}.</p>}
            </Disclose>
            <span className="t-xs">Checked {shortDate(last!.at)}{last?.costUsd ? ` · cost $${last.costUsd.toFixed(2)}` : ""}. A recommendation only; you place any order yourself.</span>
          </>
        ) : (
          <p className="t-sm">{last && !last.ok ? `The last check did not finish: ${last.error ?? "unknown error"}. Nothing was saved from it.` : "Not checked yet. The check looks up the fee, the fund's valuation and tilt, and its returns against VOO, then says whether it fits your portfolio now."}</p>
        )}
        <EtfCheckRunner symbol={f.symbol} label={c ? "Check again" : "Run the ETF check"} estimate={estimate} />
      </Card>

      <Card className="!gap-2">
        <CardHead cap="In your portfolio" right={<span className="t-xs">free · from your accounts</span>} />
        <ul className="t-sm flex flex-col">
          <li className="flex justify-between gap-3 py-1"><span>You hold</span><span className="num text-ink">{f.held ? `${usd(f.held.value)} · ${pctStr(f.held.weight)}` : "None"}</span></li>
          {f.group && (
            <>
              <li className="flex justify-between gap-3 py-1 border-t border-line"><span className="flex flex-col"><span>{f.bucket}</span><span className="t-xs">Your range {pctStr(f.group.low, 0)}-{pctStr(f.group.high, 0)}</span></span><span className="flex flex-col items-end"><span className="num text-ink">{pctStr(f.group.weight)}</span><Pill small tone={statusTone}>{f.group.status === "within" ? "In range" : f.group.status === "below" ? "Below range" : f.group.status === "above" ? "Above range" : f.group.status === "over_max" ? "Over max" : "No range"}</Pill></span></li>
              <li className="flex justify-between gap-3 py-1 border-t border-line"><span>Room to the top of the range</span><span className="num text-ink">{usd(f.group.roomToHigh)}</span></li>
            </>
          )}
        </ul>
        {f.overlaps.length > 0 && (
          <Disclose summary={<span className="t-sm">Overlap with what you own · {f.overlaps.length}</span>} open>
            <ul className="t-xs flex flex-col gap-1">{f.overlaps.map((o) => <li key={o.with}><span className="text-ink">{o.with}</span> · {o.note}</li>)}</ul>
          </Disclose>
        )}
      </Card>

      {f.profile && (
        <Card className="!gap-2">
          <CardHead cap="What it holds" right={<span className="t-xs">free · fund data on file</span>} />
          <p className="t-sm">{f.profile.mandate}. {f.profile.holdingsCount ? `${f.profile.holdingsCount.toLocaleString()} holdings. ` : ""}Style: {f.profile.style.toLowerCase()}{f.profile.size ? `, ${Object.keys(f.profile.size).join("/").toLowerCase()} companies` : ""}.</p>
          {f.profile.top && f.profile.top.length > 0 && (
            <Disclose summary={<span className="t-sm">Largest holdings · {f.profile.top.length} ({pctStr(f.profile.top.reduce((a, x) => a + x.weight, 0))} of the fund)</span>}>
              <ul className="t-xs grid grid-cols-2 gap-x-4 gap-y-0.5">{f.profile.top.map((x) => <li key={x.symbol} className="flex justify-between"><span>{x.symbol}</span><span className="num">{pctStr(x.weight, 2)}</span></li>)}</ul>
            </Disclose>
          )}
          {f.profile.sectors && (
            <Disclose summary={<span className="t-sm">Sectors</span>}>
              <ul className="t-xs grid grid-cols-2 gap-x-4 gap-y-0.5">{Object.entries(f.profile.sectors).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="num">{pctStr(v ?? 0)}</span></li>)}</ul>
            </Disclose>
          )}
          {(f.sources.length > 0 || f.gaps.length > 0) && (
            <p className="t-xs">{f.sources.map((s) => `${s.what}: ${s.source.label}, ${shortDate(s.source.asOf)} (${s.ageDays} days old)`).join("; ")}{f.gaps.length ? `. ${f.gaps.join(" ")}` : ""}</p>
          )}
        </Card>
      )}
      {!f.profile && <Card><p className="t-sm">{f.gaps.join(" ")}</p></Card>}
    </>
  );
}
