import { createClient } from "@/lib/supabase/server";
import { Card, CardHead, Disclose, Pill } from "@/components/ui";
import { Markdown } from "@/components/Markdown";
import { DemoRunner } from "@/components/assistant/DemoRunner";
import { DEMO_QUESTIONS } from "@/lib/assistant/jobs";
import type { AgentAnswer } from "@/lib/assistant/agent";

export const dynamic = "force-dynamic";

/** The five test questions, answered by the app's assistant and by a plain Claude conversation, side by side. */
export default async function AssistantDemoPage() {
  const db = await createClient();
  const { data: last } = await db.from("model_runs").select("inputs, computed_at").eq("kind", "assistant_request").not("inputs->>demo", "is", null).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const demo = (last?.inputs as { demo?: string } | undefined)?.demo ?? null;
  const { data: rows } = demo ? await db.from("model_runs").select("inputs, outputs").eq("kind", "assistant_answer").eq("inputs->>demo", demo) : { data: [] };
  const get = (q: string, mode: string) => (rows ?? []).find((r) => (r.inputs as { question: string; mode: string }).question === q && (r.inputs as { mode: string }).mode === mode)?.outputs as (AgentAnswer & { error?: string }) | undefined;
  const done = rows?.length ?? 0;
  const total = (xs: (AgentAnswer | undefined)[]) => xs.reduce((a, x) => a + (x?.costUsd ?? 0), 0);
  const app = DEMO_QUESTIONS.map((q) => get(q, "app")), base = DEMO_QUESTIONS.map((q) => get(q, "baseline"));

  return (
    <div className="flex flex-col gap-3 lg:gap-4 max-w-5xl">
      <div className="flex flex-col gap-1">
        <span className="cap">Assistant test</span>
        <h1 className="h1">Five questions, with and without your context</h1>
        <p className="t-sm">Each question is answered twice: by the app&apos;s assistant, which knows your portfolio, policy and research and can read filings, prices and the web; and by a plain Claude conversation with web search, given only a pasted list of your holdings.</p>
      </div>
      <Card className="!gap-2">
        <DemoRunner running={!!demo && done < DEMO_QUESTIONS.length * 2} />
        {demo && <p className="t-xs">Run started {demo.slice(5, 21).replace("T", " ")} UTC · {done} of {DEMO_QUESTIONS.length * 2} answers in · app ${total(app).toFixed(2)} · plain Claude ${total(base).toFixed(2)}</p>}
      </Card>
      {demo && DEMO_QUESTIONS.map((q, i) => (
        <Card key={q} labelledBy={`q${i}`} className="!gap-3">
          <CardHead id={`q${i}`} title={q} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            {(["app", "baseline"] as const).map((mode) => {
              const a = mode === "app" ? app[i] : base[i];
              return (
                <div key={mode} className="flex flex-col gap-2 min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Pill small tone={mode === "app" ? "copper" : "neutral"}>{mode === "app" ? "Portfolio Intelligence" : "Plain Claude + pasted holdings"}</Pill>
                    {a && !a.error && <span className="t-xs">{Math.round(a.ms / 1000)}s · ${a.costUsd.toFixed(2)} · {a.searches} searches · {a.steps.filter((s) => s.tool !== "web_search").length} app lookups</span>}
                  </span>
                  {!a ? <p className="t-sm">Working…</p> : a.error ? <p className="t-sm warn">Failed: {a.error}</p> : (
                    <>
                      <div className="text-[15px] leading-relaxed"><Markdown text={a.answer} /></div>
                      {a.steps.length > 0 && (
                        <Disclose summary={<span className="t-xs">What it looked up · {a.steps.length}</span>}>
                          <ol className="flex flex-col gap-1 t-xs list-decimal pl-5">{a.steps.map((s, j) => <li key={j} className={s.ok ? "" : "warn"}>{s.tool} {s.input && Object.keys(s.input as object).length ? <code className="break-all">{JSON.stringify(s.input)}</code> : null}</li>)}</ol>
                        </Disclose>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}
