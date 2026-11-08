import Form from "next/form";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { AnswerView } from "@/components/AnswerView";
import { DemoRunner } from "@/components/assistant/DemoRunner";
import { QuickQuestion, type StoredAnswer } from "@/components/assistant/QuickQuestion";
import { DEMO_QUESTIONS, QUICK_QUESTIONS } from "@/lib/assistant/jobs";
import { getWorkspace } from "@/lib/workspace";
import { isEtf } from "@/lib/portfolio/classify";
import type { AgentAnswer } from "@/lib/assistant/agent";

export const dynamic = "force-dynamic";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * Saved questions the investor asks often. Amounts and the stock are filled in from today's data and every
 * question can be edited. The side-by-side test against plain Claude stays below, collapsed.
 */
export default async function QuestionsPage({ searchParams }: { searchParams: Promise<{ ticker?: string }> }) {
  const sp = await searchParams;
  const db = await createClient();
  const ws = await getWorkspace();
  const stocks = ws.portfolio.holdings.filter((h) => !isEtf(h.symbol)).sort((a, b) => b.weight - a.weight).map((h) => h.symbol);
  const ticker = (sp.ticker ?? "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10) || stocks[0] || "IREN";
  const cash = ws.portfolio.cashDetail.deployable;
  const fill = (t: string) => t.replace("{cash}", cash > 0 ? money(cash) : "my available cash").replace("{ticker}", ticker);

  const { data: quick } = await db.from("model_runs").select("computed_at, inputs, outputs").eq("kind", "assistant_answer").eq("inputs->>purpose", "quick").order("computed_at", { ascending: false }).limit(40);
  const lastFor = (slot: number): StoredAnswer => {
    const r = (quick ?? []).find((x) => Number((x.inputs as { slot?: number }).slot) === slot);
    const o = r?.outputs as (AgentAnswer & { error?: string }) | undefined;
    return r && o?.answer && !o.error ? { question: (r.inputs as { question: string }).question, answer: o.answer, at: r.computed_at, ms: o.ms, costUsd: o.costUsd, searches: o.searches } : null;
  };

  const { data: last } = await db.from("model_runs").select("inputs, computed_at").eq("kind", "assistant_request").not("inputs->>demo", "is", null).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const demo = (last?.inputs as { demo?: string } | undefined)?.demo ?? null;
  const { data: rows } = demo ? await db.from("model_runs").select("inputs, outputs").eq("kind", "assistant_answer").eq("inputs->>demo", demo) : { data: [] };
  const get = (q: string, mode: string) => (rows ?? []).find((r) => (r.inputs as { question: string; mode: string }).question === q && (r.inputs as { mode: string }).mode === mode)?.outputs as (AgentAnswer & { error?: string }) | undefined;
  const done = rows?.length ?? 0;
  const running = !!demo && done < DEMO_QUESTIONS.length * 2;

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Assistant</span>
        <h1 className="h1">Your questions</h1>
        <p className="t-sm">Questions you ask often, answered with your portfolio, policy, research and today&apos;s data. Edit any of them before asking. Each answer starts with a short summary; the full analysis is one tap away. For anything else, use Ask on any page.</p>
      </div>

      {stocks.length > 1 && (
        <Form className="flex flex-wrap items-end gap-2" action="/assistant">
          <label className="field">Stock for the earnings question
            <select name="ticker" defaultValue={ticker} className="input">
              {stocks.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <button className="btn btn-sm">Use this stock</button>
        </Form>
      )}

      {QUICK_QUESTIONS.map((t, i) => <QuickQuestion key={`${i}-${fill(t)}`} slot={i} initial={fill(t)} last={lastFor(i)} />)}

      <Card flush>
        <Disclose summary={<span className="t-sm">Test against plain Claude <span className="t-xs">· the original five-question comparison</span></span>}>
          <div className="flex flex-col gap-3">
            <DemoRunner running={running} />
            {demo && <p className="t-xs">Last run {demo.slice(5, 21).replace("T", " ")} UTC · {done} of {DEMO_QUESTIONS.length * 2} answers in</p>}
            {demo && DEMO_QUESTIONS.map((q, i) => (
              <div key={q} className="flex flex-col gap-2 border-t border-line pt-3">
                <CardHead id={`dq${i}`} title={q} />
                {(["app", "baseline"] as const).map((mode) => {
                  const a = get(q, mode);
                  return (
                    <div key={mode} className="flex flex-col gap-1.5 min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Pill small tone={mode === "app" ? "copper" : "neutral"}>{mode === "app" ? "Portfolio Intelligence" : "Plain Claude + pasted holdings"}</Pill>
                        {a && !a.error && <span className="t-xs">{Math.round(a.ms / 1000)}s · ${a.costUsd.toFixed(2)} · {a.searches} searches</span>}
                      </span>
                      {!a ? <p className="t-sm">Working…</p> : a.error ? <p className="t-sm warn">Failed: {a.error}</p> : <AnswerView text={a.answer} />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Disclose>
      </Card>
    </div>
  );
}
