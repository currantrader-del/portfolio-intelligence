import { ActionForm, SubmitButton } from "@/components/forms";
import { AGE_REMINDER_DAYS } from "@/lib/policy/limits";
import { getWorkspace } from "@/lib/workspace";
import { isEtf } from "@/lib/portfolio/classify";
import { coverage, suggestStage } from "@/lib/research/status";
import { getQuotes } from "@/lib/market/quotes";
import { pctStr, shortDate } from "@/lib/format";
import { Card, CardHead, Disclose, PageHeader, Pill } from "@/components/ui";
import { AlertList } from "@/components/cards/Alerts";
import { ResearchBrowser, type OwnedItem, type PipeItem } from "@/components/ResearchBrowser";
import { toZoneViews } from "@/components/ZoneBar";
import { addToPipeline } from "./actions";

const TASK_KINDS = new Set(["research_stale", "research_missing", "price_zone", "review", "event"]);
const md = (iso: string | null | undefined) => (iso ? shortDate(iso).replace(/, \d{4}$/, "") : null);

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  const sp = await searchParams;
  const ws = await getWorkspace();
  const freshDays = AGE_REMINDER_DAYS;
  const holdings = ws.portfolio.holdings.filter((h) => !isEtf(h.symbol)).sort((a, b) => b.value - a.value);
  const ownedSet = new Set(holdings.map((h) => h.symbol));

  const owned: OwnedItem[] = holdings.map((h) => {
    const r = ws.research.find((x) => x.symbol === h.symbol);
    const c = coverage(r, h.price, ws.now, freshDays);
    const v = r?.current ?? r?.latest;
    const e = ws.portfolio.exposures.find((x) => x.symbol === h.symbol);
    return {
      symbol: h.symbol, name: r?.name ?? null, classification: v?.parsed.classification ?? null, coverage: c,
      action: v?.parsed.action ?? null, confidence: v?.parsed.confidence ?? null, researchAsOf: md(v?.research_as_of), versions: r?.versions ?? 0,
      price: h.price, zones: toZoneViews(v?.parsed.zones ?? []),
      exposure: e ? `${pctStr(e.total)} of investable · limit ${pctStr(e.max, 0)}` : null,
    };
  });
  const notOwned = ws.research.filter((r) => !ownedSet.has(r.symbol));
  // The workspace only quotes holdings; researched companies need their own price for the bands.
  const need = notOwned.filter((r) => (r.current ?? r.latest) && !ws.quotes.has(r.symbol)).map((r) => r.symbol);
  const extraQuotes = need.length ? await getQuotes(need).catch(() => new Map()) : new Map();
  const STAGE_NAME: Record<string, string> = { screening: "Screening", researching: "Researching", ready: "Ready", passed: "Passed" };
  const pipeline: PipeItem[] = notOwned.map((r) => {
    const v = r.current ?? r.latest;
    const price = (ws.quotes.get(r.symbol) ?? extraQuotes.get(r.symbol))?.price ?? null;
    const stageNow = r.pipeline.stage === "owned" ? "researching" : r.pipeline.stage;
    const c = coverage(r, price, ws.now, freshDays);
    const sug = v ? suggestStage({ stage: stageNow, held: false, coverageKey: c.key, hasResearch: true, action: v.parsed.action ?? null, screenVerdict: r.pipeline.screen?.verdict ?? null }) : null;
    // Same card as an owned position whenever research exists, minus the position size.
    const card: OwnedItem | null = v ? {
      symbol: r.symbol, name: r.name ?? null, classification: v.parsed.classification ?? null, coverage: c,
      action: v.parsed.action ?? null, confidence: v.parsed.confidence ?? null, researchAsOf: md(v.research_as_of), versions: r.versions ?? 0,
      price, zones: toZoneViews(v.parsed.zones ?? []), held: false,
      exposure: sug ? `Suggested move: ${STAGE_NAME[sug.stage]}. Open to accept.` : r.pipeline.note,
    } : null;
    return {
      card,
      symbol: r.symbol, name: r.name,
      // A company is only "owned" while it is in the holdings; otherwise it returns to research.
      stage: r.pipeline.stage === "owned" ? "researching" : r.pipeline.stage,
      note: r.pipeline.note, screen: r.pipeline.screen?.verdict ?? null, screenedAt: md(r.pipeline.screenedAt),
      coverage: v ? coverage(r, null, ws.now, freshDays).label : null,
    };
  });
  const valid = ["owned", "ready", "researching", "screening", "idea", "passed"];
  const stage = sp.stage && valid.includes(sp.stage) ? sp.stage : "owned";
  const tasks = ws.alerts.filter((a) => TASK_KINDS.has(a.kind) && a.symbol);

  return (
    <div className="flex flex-col gap-3 lg:gap-4">
      <PageHeader title="Research" actionsDesktopOnly />
      <div className="grid grid-cols-1 gap-3 lg:gap-4 lg:grid-cols-12 items-start">
        <div className="lg:col-span-8 lg:row-span-2 lg:row-start-1 flex flex-col gap-3 min-w-0">
          <ResearchBrowser owned={owned} pipeline={pipeline} initialStage={stage} />
        </div>
        {tasks.length > 0 && (
          <Card className="lg:col-span-4 lg:col-start-9 lg:row-start-1 !gap-1 !pb-1.5 max-lg:order-first" labelledBy="rt-h">
            <div className="mb-1"><CardHead id="rt-h" title="Research tasks" right={<Pill>{tasks.length}</Pill>} /></div>
            <AlertList alerts={tasks.slice(0, 4)} />
            {tasks.length > 4 && <div className="border-t border-line"><Disclose summary={`${tasks.length - 4} more`}><AlertList alerts={tasks.slice(4)} /></Disclose></div>}
          </Card>
        )}
        <div className="lg:col-span-4 lg:col-start-9 flex flex-col gap-3 lg:gap-4">
          <Card tight className="!gap-0 !py-0.5">
            <Disclose summary={<span className="text-ink font-semibold">+ Add an idea</span>}>
              <ActionForm action={addToPipeline} success="Idea added" className="flex flex-col gap-2.5">
                <label className="field">Ticker<input name="symbol" required maxLength={10} placeholder="e.g. MSFT" className="input uppercase num" autoCapitalize="characters" /></label>
                <label className="field">Why it is interesting (optional)<input name="note" maxLength={300} className="input" /></label>
                <SubmitButton className="btn btn-primary" pendingText="Adding…">Add idea</SubmitButton>
              </ActionForm>
            </Disclose>
          </Card>
          <p className="t-xs px-1">Owned positions come first. The screen uses SEC data to decide what is worth researching; it never makes a buy call. Every conclusion keeps its date and source.</p>
        </div>
      </div>
    </div>
  );
}
