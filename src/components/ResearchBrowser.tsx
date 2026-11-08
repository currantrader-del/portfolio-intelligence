"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Pill, Tick } from "@/components/ui";
import { ZoneBar, type ZoneView } from "./ZoneBar";

export type OwnedItem = {
  symbol: string; name: string | null; classification: string | null;
  coverage: { label: string; tone: "gain" | "warn" | "neutral"; dot: "solid" | "hollow"; detail: string; key: string };
  action: string | null; confidence: string | null; researchAsOf: string | null; versions: number;
  price: number | null; zones: ZoneView[]; exposure: string | null;
};
export type PipeItem = {
  symbol: string; name: string | null; stage: string; note: string | null;
  screen: string | null; screenedAt: string | null; coverage: string | null;
  /** Researched companies get the same card as an owned position, without the position size. */
  card: OwnedItem | null;
};

const SCREEN_TONE: Record<string, "gain" | "warn" | "neutral"> = { "Worth researching": "gain", Mixed: "warn", "Weak on screen": "warn", "Not enough data": "neutral" };
const STAGE_LABEL: Record<string, string> = { idea: "Ideas", screening: "Screening", researching: "Researching", ready: "Ready", passed: "Passed" };

/** Search and stage filters run in the browser: instant, and the stage is kept in the URL. */
export function ResearchBrowser({ owned, pipeline, initialStage }: { owned: OwnedItem[]; pipeline: PipeItem[]; initialStage: string }) {
  const [stage, setStage] = useState(initialStage);
  const [q, setQ] = useState("");
  useEffect(() => {
    const url = new URL(window.location.href);
    if (stage === "owned") url.searchParams.delete("stage"); else url.searchParams.set("stage", stage);
    window.history.replaceState(window.history.state, "", url);
  }, [stage]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { owned: owned.length };
    for (const k of Object.keys(STAGE_LABEL)) c[k] = pipeline.filter((p) => p.stage === k).length;
    return c;
  }, [owned, pipeline]);
  const needle = q.trim().toLowerCase();
  const match = (s: string, n: string | null, extra = "") => `${s} ${n ?? ""} ${extra}`.toLowerCase().includes(needle);
  const ownedShown = needle ? owned.filter((o) => match(o.symbol, o.name, o.classification ?? "")) : stage === "owned" ? owned : [];
  const pipeMatched = needle ? pipeline.filter((p) => match(p.symbol, p.name, p.note ?? "")) : pipeline.filter((p) => p.stage === stage);
  const cardsShown = pipeMatched.filter((p) => p.card);
  const pipeShown = pipeMatched.filter((p) => !p.card);
  const total = owned.length + pipeline.length;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 min-h-11 rounded-[12px] bg-surface-2 px-3 text-muted focus-within:ring-1 focus-within:ring-line-strong">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4" /></svg>
        <span className="sr-only">Search companies</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${total} companies or a ticker`} className="flex-1 min-w-0 min-h-11 bg-transparent outline-none text-ink placeholder:text-muted" autoComplete="off" spellCheck={false} />
      </label>
      {!needle && (
        <div className="chips" role="group" aria-label="Filter by stage">
          {(["owned", "ready", "researching", "screening", "idea", "passed"] as const).map((k) => (
            <button key={k} type="button" className="chip" aria-pressed={stage === k} onClick={() => setStage(k)}>
              {k === "owned" ? "Owned" : STAGE_LABEL[k]} <span className="opacity-70 num">{counts[k]}</span>
            </button>
          ))}
        </div>
      )}

      {needle && <p className="t-xs" aria-live="polite">{ownedShown.length + pipeMatched.length} match{ownedShown.length + pipeMatched.length === 1 ? "" : "es"}</p>}

      {ownedShown.length + cardsShown.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {ownedShown.map((o) => <OwnedCard key={o.symbol} o={o} />)}
          {cardsShown.map((p) => <OwnedCard key={p.symbol} o={p.card!} stage={needle ? STAGE_LABEL[p.stage] ?? p.stage : null} />)}
        </div>
      )}

      {(pipeShown.length > 0 || (!needle && stage !== "owned" && cardsShown.length === 0)) && (
        <div className="card !gap-0 !py-1">
          {pipeShown.length === 0 ? <p className="t-sm py-3">Nothing at this stage.</p> : (
            <ul className="list">
              {pipeShown.map((p) => (
                <li key={p.symbol}>
                  <Link href={`/research/${p.symbol}`} className="li">
                    <Tick symbol={p.symbol} />
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="font-semibold truncate">{p.symbol}{p.name && <span className="font-normal text-ink-2"> · {p.name}</span>}</span>
                      <span className="t-xs truncate">{p.note ?? (needle ? STAGE_LABEL[p.stage] ?? p.stage : p.screenedAt ? `Screened ${p.screenedAt}` : "Not screened yet")}</span>
                    </span>
                    {p.screen ? <Pill small tone={SCREEN_TONE[p.screen] ?? "neutral"}>{p.screen}</Pill> : p.coverage ? <Pill small>{p.coverage}</Pill> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {needle && ownedShown.length + pipeMatched.length === 0 && (
        <div className="card card-tight">
          <p className="t-sm">No company matches &ldquo;{q}&rdquo;.</p>
          {/^[a-z.\-]{1,10}$/i.test(q.trim()) && <Link href={`/research/${q.trim().toUpperCase()}`} className="btn btn-sm self-start">Look up {q.trim().toUpperCase()}</Link>}
        </div>
      )}
    </div>
  );
}

/** Company Research card: an owned position, or a researched company (no position size). */
function OwnedCard({ o, stage }: { o: OwnedItem; stage?: string | null }) {
  return (
    <Link href={`/research/${o.symbol}`} className="card !gap-2.5">
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <Tick symbol={o.symbol} />
          <div className="flex flex-col min-w-0">
            <span className="font-semibold truncate">{o.name ?? o.symbol}</span>
            <span className="t-xs truncate">{o.symbol}{stage ? ` · ${stage}` : ""}{o.classification ? ` · ${o.classification}` : ""}</span>
          </div>
        </div>
        <Pill tone={o.coverage.tone} dot={o.coverage.dot} title={o.coverage.detail}>{o.coverage.label}</Pill>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="t-sm min-w-0 truncate">
          {o.coverage.key === "conflict" ? <><span className="text-ink font-semibold">No current call</span> · {o.versions} records disagree</>
            : o.action ? <><span className="text-ink font-semibold capitalize">{o.action.toLowerCase()}</span>{o.confidence ? ` · ${o.confidence.toLowerCase()} confidence` : ""}</>
            : <span>No research decision on file</span>}
        </span>
        <span className="t-xs shrink-0">{o.researchAsOf ? `Research ${o.researchAsOf}` : ""}</span>
      </div>
      {o.coverage.key === "current" && o.zones.length > 0 && <ZoneBar zones={o.zones} price={o.price} />}
      {o.coverage.key === "refresh" && <span className="t-xs line-clamp-2">Not re-priced: {o.coverage.detail.split(". ")[0].replace(/^Price is/, "price is")}.</span>}
      {o.exposure && <span className="t-xs">{o.exposure}</span>}
    </Link>
  );
}
