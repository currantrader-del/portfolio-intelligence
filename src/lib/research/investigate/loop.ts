/**
 * The tool loop for one investigation step. The model works until the step's own completion tool
 * accepts its work (isDone), or until the step's time or turn budget runs out; then the state is
 * saved and the next invocation continues. Usage and cost are counted per response.
 */
import Anthropic from "@anthropic-ai/sdk";
import { addUsage, emptyUsage, type Usage } from "./types";
import { usageOf } from "./models";

export type ToolDef = Anthropic.Beta.BetaTool;
export type LoopResult = { usage: Usage; turns: number; done: boolean; stopped: string | null; lastText: string; searches: { url: string; title: string; query: string }[] };

export async function runLoop(a: {
  client?: Anthropic;
  model: { id: string; effort: "low" | "medium" | "high" | "xhigh" | "max" };
  system: string;
  user: string;
  tools: ToolDef[];
  webSearches?: number;
  exec: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  isDone: () => boolean;
  /** Explains, when the model stops without finishing, what is still missing. */
  missing: () => string;
  limits: { turns: number; ms: number };
}): Promise<LoopResult> {
  const client = a.client ?? new Anthropic();
  const t0 = Date.now();
  let usage = emptyUsage();
  const searches: LoopResult["searches"] = [];
  const tools: Anthropic.Beta.BetaToolUnion[] = [...a.tools, ...(a.webSearches ? [{ type: "web_search_20250305", name: "web_search", max_uses: a.webSearches } as Anthropic.Beta.BetaWebSearchTool20250305] : [])];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: a.user }];
  let turns = 0, nudges = 0, lastText = "", stopped: string | null = null, warned = false;
  for (; turns < a.limits.turns; turns++) {
    if (Date.now() - t0 > a.limits.ms) { stopped = "time budget for this step"; break; }
    if (!warned && Date.now() - t0 > a.limits.ms * 0.75) {
      warned = true;
      messages.push({ role: "user", content: "Time for this step is nearly used up. Save what you have now: record findings and questions, then call the step's completion tool if the work is done. If it is not done, say what remains; the next step continues from your saved work." });
    }
    const t = Date.now();
    const res = await client.beta.messages.stream({
      model: a.model.id, max_tokens: 16000, system: [{ type: "text", text: a.system }], tools, messages,
      cache_control: { type: "ephemeral" },
      output_config: { effort: a.model.effort }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    }).finalMessage();
    usage = addUsage(usage, usageOf(res.model, res.usage, Date.now() - t));
    for (const b of res.content) {
      if (b.type === "server_tool_use" && b.name === "web_search") {
        const q = String((b.input as { query?: string })?.query ?? "");
        const result = res.content.find((x) => x.type === "web_search_tool_result" && (x as { tool_use_id?: string }).tool_use_id === b.id) as { content?: unknown } | undefined;
        if (Array.isArray(result?.content)) for (const r of result!.content as { url?: string; title?: string }[]) if (r.url) searches.push({ url: r.url, title: r.title ?? r.url, query: q });
      }
    }
    if (res.stop_reason === "refusal") { stopped = "refusal"; break; }
    messages.push({ role: "assistant", content: res.content });
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("").trim();
    if (text) lastText = text;
    if (res.stop_reason === "pause_turn") continue;
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      if (a.isDone()) break;
      if (nudges >= 2) { stopped = "stopped without finishing"; break; }
      nudges++;
      messages.push({ role: "user", content: `The step is not finished. Still missing:\n${a.missing()}\nKeep working with the tools: investigate, resolve or explain, then call the completion tool.` });
      continue;
    }
    const results = await Promise.all(uses.map(async (u) => {
      try {
        const out = await a.exec(u.name, (u.input ?? {}) as Record<string, unknown>);
        const content = typeof out === "string" ? out : JSON.stringify(out);
        return { type: "tool_result" as const, tool_use_id: u.id, content: content.length > 120_000 ? content.slice(0, 120_000) + "\n[truncated: ask for a narrower section or page]" : content };
      } catch (e) {
        return { type: "tool_result" as const, tool_use_id: u.id, content: `Tool failed: ${(e as Error).message.slice(0, 300)}`, is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
    if (a.isDone()) break;
  }
  return { usage: { ...usage, ms: Date.now() - t0 }, turns, done: a.isDone(), stopped: a.isDone() ? null : stopped ?? (turns >= a.limits.turns ? "turn budget for this step" : null), lastText, searches };
}

/** One plain call (the skeptic), with no tools. */
export async function runOnce(a: { client?: Anthropic; model: { id: string; effort: "low" | "medium" | "high" | "xhigh" | "max" }; system: string; user: string; schema?: Record<string, unknown> }): Promise<{ text: string; usage: Usage; stop: string | null }> {
  const client = a.client ?? new Anthropic();
  const t = Date.now();
  // Streamed: the SDK refuses a non-streaming call whose max_tokens could run past 10 minutes (the
  // skeptic on the high-effort model), which made every skeptical review fail.
  const res = await client.beta.messages.stream({
    model: a.model.id, max_tokens: 24000, system: a.system, messages: [{ role: "user", content: a.user }],
    output_config: { effort: a.model.effort, ...(a.schema ? { format: { type: "json_schema" as const, schema: a.schema } } : {}) },
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
  }).finalMessage();
  const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("").trim();
  return { text, usage: usageOf(res.model, res.usage, Date.now() - t), stop: res.stop_reason };
}
