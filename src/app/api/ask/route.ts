import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspace } from "@/lib/workspace";
import { runTool, TOOLS } from "@/lib/assistant/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Cost setup: Sonnet answers questions; Opus only when the user asks to think harder. */
const MODELS = {
  standard: { id: "claude-sonnet-5-5", effort: "low" as const, inPerM: 2, outPerM: 10 },
  deep: { id: "claude-opus-5-5", effort: "high" as const, inPerM: 4, outPerM: 20 },
};

const SYSTEM = `You are the assistant inside Portfolio Intelligence, a personal investment decision desk for one person.

How you work:
- Prices, holdings and every calculation come from tools. Never state a price, weight, return or dollar amount that is not in a tool result from this conversation. If a number is missing, say it is missing.
- Label what kind of information each claim is: market data, stored research (give its date), a model output (the app's calculation), or your own judgment.
- Stored research is historical. Say how old it is, and when it is partial, reconstructed or conflicting, say so plainly.
- Holdings come from statements with a date, plus any trades recorded since. Unless get_portfolio says data_quality.status is "verified", every portfolio value and return is an ESTIMATE based on last verified holdings: say so, and never present it as the person's actual return.
- A price drop is never a buy signal by itself. When get_research says repriced is false, do not compute or quote an expected return at today's price; say the research needs a refresh and what to check.
- When simulate_new_capital returns status "wait_review", the answer is WAIT / REVIEW: explain the open checks and what to verify. Do not present its illustrative split as a recommendation.
- Policy limits can conflict between sources. Use get_policy, name the sources and dates, and never assume the larger limit is the approved one.
- For why something moved, first check whether the move is market-wide (get_portfolio attribution), then use get_news and get_filings. Present headlines as headlines (publisher, date, link), not as verified facts. If nothing explains the move, say so.
- For results and financial health, use get_fundamentals (as-reported SEC data) and name the period. A next earnings date from get_filings is an estimate; say so.
- News or a filing can raise a question for review; it never by itself turns into a buy or sell recommendation.
- You never place trades and cannot. Present options and a recommendation; the person decides.
- Respect the person's policy: limits, the protected $10,000 savings floor, and "new cash does not have to be invested immediately".
- Be direct and brief. Lead with the answer. Plain sentences, short lists only when they help. No headings unless the answer is long.`;

type ClientMsg = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { messages?: ClientMsg[]; page?: string; symbol?: string | null; deep?: boolean } | null;
  const history = (body?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-12);
  if (!history.length || history[history.length - 1].role !== "user") return Response.json({ error: "No question." }, { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The assistant is not configured yet: add ANTHROPIC_API_KEY in Netlify environment variables." }, { status: 503 });

  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const model = body?.deep ? MODELS.deep : MODELS.standard;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      try {
        const ws = await buildWorkspace(db);
        const client = new Anthropic();
        const context = `Page the person is on: ${body?.page ?? "/"}${body?.symbol ? `; selected company: ${body.symbol}` : ""}. Current time: ${ws.now.toISOString()}. US market ${ws.marketOpen ? "open" : "closed"}.`;
        const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
        messages.push({ role: "system", content: context } as unknown as Anthropic.Beta.BetaMessageParam);

        const toolLog: { name: string; input: unknown }[] = [];
        let inTok = 0, outTok = 0;
        let answer = "";
        let servedBy = model.id;

        for (let turn = 0; turn < 8; turn++) {
          const res = await client.beta.messages.create({
            model: model.id,
            max_tokens: 16000,
            system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
            tools: TOOLS,
            tool_choice: { type: "auto" },
            output_config: { effort: model.effort },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            messages,
          });
          inTok += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
          outTok += res.usage.output_tokens;
          servedBy = res.model;

          if (res.stop_reason === "refusal") {
            answer = "I can't help with that one.";
            break;
          }
          messages.push({ role: "assistant", content: res.content });
          const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          if (res.stop_reason !== "tool_use" || !uses.length) {
            answer = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
            break;
          }
          send({ type: "status", text: uses.map((u) => STATUS[u.name] ?? u.name).join(", ") });
          const results = await Promise.all(
            uses.map(async (u) => {
              toolLog.push({ name: u.name, input: u.input });
              try {
                const out = await runTool(u.name, (u.input ?? {}) as Record<string, unknown>, ws, db);
                return { type: "tool_result" as const, tool_use_id: u.id, content: JSON.stringify(out) };
              } catch (e) {
                return { type: "tool_result" as const, tool_use_id: u.id, content: `Tool failed: ${(e as Error).message}`, is_error: true };
              }
            }),
          );
          messages.push({ role: "user", content: results });
        }

        if (!answer) answer = "I ran out of steps before finishing. Try a narrower question.";
        const cost = (inTok * model.inPerM + outTok * model.outPerM) / 1_000_000;
        const { data: saved } = await db
          .from("ai_judgments")
          .insert({ kind: "answer", model: servedBy, tool_calls: toolLog, output_markdown: answer, input_tokens: inTok, output_tokens: outTok, cost_usd: Number(cost.toFixed(5)) })
          .select("id")
          .single();
        send({ type: "answer", text: answer, model: servedBy, tools: toolLog.map((t) => t.name), judgmentId: saved?.id ?? null, costUsd: cost });
      } catch (e) {
        const msg = e instanceof Anthropic.APIError ? `The AI service returned an error (${e.status}).` : "Something went wrong answering that.";
        send({ type: "error", text: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

const STATUS: Record<string, string> = {
  get_portfolio: "Reading your portfolio",
  get_research: "Reading stored research",
  get_research_phase: "Reading the research text",
  simulate_new_capital: "Running the new-cash calculation",
  get_alerts: "Checking alerts",
  get_quote: "Getting a quote",
};
