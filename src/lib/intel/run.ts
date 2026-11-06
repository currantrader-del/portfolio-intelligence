import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { collectSearchPages, deskPrompt, deskSystem, DESK_VERSION, DESKS, extractJson, validateDesk, type DeskKey, type DeskResult } from "./desks";
import { SYNTHESIS_VERSION, synthesisPrompt, synthesisSystem, validateSynthesis, type PortfolioContext, type Synthesis } from "./synthesis";
import type { Snapshot } from "./snapshot";

/** Desks: Sonnet with web search at low effort (fast, cited). Synthesis: Sonnet at medium effort, no tools. */
const DESK_MODEL = "claude-sonnet-5-5";
const SYNTH_MODEL = "claude-sonnet-5-5";
const PRICE = { inPerM: 2, outPerM: 10, perSearch: 0.01 };

export function costOf(u: { input: number; output: number; searches: number }) {
  return (u.input * PRICE.inPerM + u.output * PRICE.outPerM) / 1e6 + u.searches * PRICE.perSearch;
}

/** One desk, kept inside the hosting time limit: it stops resuming a paused turn after ~40 seconds. */
export async function runDesk(key: DeskKey, ctx: { now: Date; snapshot: Snapshot; holdings: string[]; watch: string[] }): Promise<DeskResult> {
  const desk = DESKS.find((d) => d.key === key)!;
  const client = new Anthropic();
  const started = Date.now();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: deskPrompt(desk, ctx) }];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  const usage = { input: 0, output: 0, searches: 0 };
  let model = DESK_MODEL;
  const problems: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await client.beta.messages.create({
      model: DESK_MODEL,
      max_tokens: 8000,
      system: deskSystem(),
      // Basic search: results arrive as plain search-result blocks the model reads directly. The dynamic-filtering
      // version ran searches inside code and the desks reported failed searches on the preview (2026-11-06).
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });
    model = res.model;
    usage.input += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    usage.output += res.usage.output_tokens;
    usage.searches += res.usage.server_tool_use?.web_search_requests ?? 0;
    content.push(...res.content);
    if (res.stop_reason === "refusal") { problems.push("The model declined this desk"); break; }
    if (res.stop_reason !== "pause_turn" || Date.now() - started > 40_000) {
      if (res.stop_reason === "pause_turn") problems.push("Stopped searching early to stay within the time limit");
      break;
    }
    messages.push({ role: "assistant", content: res.content });
  }
  for (const b of content as unknown as { type: string; content?: { type?: string; error_code?: string } }[]) {
    if (b.type === "web_search_tool_result" && b.content?.type === "web_search_tool_result_error") problems.push(`A search failed (${b.content.error_code ?? "unknown error"})`);
  }
  const pages = collectSearchPages(content);
  const text = content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  const v = validateDesk(extractJson(text), pages, ctx.now);
  return {
    version: DESK_VERSION, desk: key, title: desk.title, generatedAt: new Date().toISOString(), model,
    items: v.items, calendar: v.calendar, uncertainties: v.uncertainties,
    searches: usage.searches, pagesReturned: pages.size, problems: [...problems, ...v.problems], usage,
  };
}

export async function runSynthesis(ctx: { now: Date; snapshot: Snapshot; desks: DeskResult[]; portfolio: PortfolioContext }): Promise<{ synthesis: Synthesis; problems: string[]; model: string; usage: { input: number; output: number; searches: number } }> {
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: SYNTH_MODEL,
    max_tokens: 10000,
    system: synthesisSystem(),
    // No strict output schema: the API rejected this schema as too large to compile. The reply is a JSON
    // block that validateSynthesis checks and repairs field by field.
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: synthesisPrompt(ctx) }],
  });
  const usage = { input: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0), output: res.usage.output_tokens, searches: 0 };
  if (res.stop_reason === "refusal") throw new Error("The model declined to write the synthesis");
  const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  let raw: unknown = null;
  try { raw = JSON.parse(text); } catch { raw = extractJson(text); }
  const v = validateSynthesis(raw, ctx);
  return { synthesis: v.synthesis, problems: v.problems, model: res.model, usage };
}

export { SYNTHESIS_VERSION };
