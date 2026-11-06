// Server code (no "server-only" marker: the background job function imports it outside Next).
import Anthropic from "@anthropic-ai/sdk";
import { collectSearchPages, deskPrompt, deskSystem, DESK_VERSION, DESKS, extractJson, validateDesk, type DeskContext, type DeskKey, type DeskResult, type Item } from "./desks";
import { officialCalendar } from "./calendar";
import { lookupCik } from "../market/sec";
import { SYNTHESIS_VERSION, synthesisPrompt, synthesisSystem, validateSynthesis, type SynthesisContext, type Synthesis } from "./synthesis";
import { checkEvent, checkItem, dateOnPage, excerptFor, finalCheck, officialFor, pageFetcher, type Support } from "./verify";

/** Desks: Sonnet with web search at low effort (fast, cited). Synthesis: Sonnet at medium effort, no tools. */
const DESK_MODEL = "claude-sonnet-5-5";
const SYNTH_MODEL = "claude-sonnet-5-5";
const PRICE = { inPerM: 2, outPerM: 10, perSearch: 0.01 };

export function costOf(u: { input: number; output: number; searches: number }) {
  return (u.input * PRICE.inPerM + u.output * PRICE.outPerM) / 1e6 + u.searches * PRICE.perSearch;
}

/** One desk, run as a background job: research with web search, then a code check of its claims against the cited pages. */
export async function runDesk(key: DeskKey, ctxIn: DeskContext): Promise<DeskResult> {
  const desk = DESKS.find((d) => d.key === key)!;
  const client = new Anthropic();
  const started = Date.now();
  // Official pages are fetched with an identifying user agent (agencies ask automated clients to identify themselves).
  const fetchPage = pageFetcher(10000, process.env.SEC_USER_AGENT ? `PortfolioIntelligence/1.0 (${process.env.SEC_USER_AGENT})` : undefined);
  let ctx = ctxIn;
  let official: Awaited<ReturnType<typeof officialCalendar>> | null = null;
  if (key === "events") {
    // Company names decide which sites are the company's own (nvidianews.nvidia.com for NVIDIA).
    const names = { ...(ctx.names ?? {}) };
    await Promise.all(ctx.holdings.filter((s) => !names[s]).map(async (s) => { const c = await lookupCik(s).catch(() => null); if (c?.title) names[s] = c.title; }));
    ctx = { ...ctx, names };
    official = await officialCalendar(ctx.now, 30, fetchPage);
    const lines = official.events.map((e) => `${e.date}${e.time ? ` ${e.time}` : ""}: ${e.event} [${e.source?.publisher}]`);
    const failed = official.log.filter((l) => !l.ok || l.error).map((l) => `${l.url} (${l.error})`);
    ctx = { ...ctx, extra: `OFFICIAL EVENTS ALREADY CONFIRMED BY THE APP (do not repeat):\n${lines.join("\n") || "none"}${failed.length ? `\nOfficial pages the app could not read (you may search for these events; they will stay "estimated" unless an official page shows the date): ${failed.join("; ")}` : ""}` };
  }
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: deskPrompt(desk, ctx) }];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  const usage = { input: 0, output: 0, searches: 0 };
  let model = DESK_MODEL;
  const problems: string[] = [];
  const requests: NonNullable<DeskResult["requests"]> = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const res = await client.beta.messages.create({
      model: DESK_MODEL,
      max_tokens: 8000,
      system: deskSystem(),
      // Basic search: results arrive as plain search-result blocks the model reads directly. The dynamic-filtering
      // version ran searches inside code and the desks reported failed searches on the preview (2026-11-06).
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });
    model = res.model;
    requests.push({ kind: "model", ms: Date.now() - t0, detail: `${res.model} ${res.stop_reason}; ${res.usage.input_tokens} in, ${res.usage.output_tokens} out, ${res.usage.server_tool_use?.web_search_requests ?? 0} searches`, ok: res.stop_reason !== "refusal" });
    usage.input += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    usage.output += res.usage.output_tokens;
    usage.searches += res.usage.server_tool_use?.web_search_requests ?? 0;
    content.push(...res.content);
    if (res.stop_reason === "refusal") { problems.push("The model declined this desk"); break; }
    if (res.stop_reason !== "pause_turn" || Date.now() - started > 240_000) {
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
  // Check claims against the content of the cited pages (each page fetched once): figures by code, support by a
  // second reading whose quote must appear verbatim on the page. A "verified" claim that fails becomes "reported".
  const retrievedAt = new Date().toISOString();
  const figureChecks = await Promise.all(v.items.map((it) => checkItem(it, fetchPage)));
  const pageTexts = await Promise.all(figureChecks.map(async (fc) => (fc.url ? await fetchPage(fc.url) : null)));
  const toJudge = v.items.flatMap((it, i) => {
    const p = pageTexts[i];
    if (!p?.ok || figureChecks[i].status === "not_checked" || figureChecks[i].status === "unreachable") return [];
    return [{ i, claim: `${it.headline}. ${it.detail}`, url: figureChecks[i].url!, excerpt: excerptFor(`${it.headline}. ${it.detail}`, p.text) }];
  });
  const judged = await judgeClaims(client, toJudge, usage, requests);
  const items: Item[] = v.items.map((it, i) => {
    const p = pageTexts[i];
    const r = finalCheck(it, figureChecks[i], judged.get(i) ?? null, p?.ok ? p.text : null, retrievedAt);
    return { ...it, kind: r.kind, check: r.check };
  });
  const searched = await Promise.all(v.calendar.map(async (ev) => {
    const r = await checkEvent(ev, fetchPage, ctx.names);
    if (r.status === "confirmed" || ev.type !== "earnings") return { ...ev, status: r.status, check: r.check };
    // The cited page was not official or could not be read (company IR event pages often refuse automated readers):
    // try the company's own pages among those the searches returned, e.g. its newsroom release.
    const alt = await confirmFromReturnedPages(ev, [...pages.keys()], fetchPage, ctx.names ?? {});
    return alt ?? { ...ev, status: r.status, check: r.check };
  }));
  const calendar = official ? mergeEvents(official.events, searched) : searched;
  if (official) for (const l of official.log) requests.push({ kind: "page", ms: l.ms, detail: `official calendar ${l.url} ${l.status ?? ""} ${l.error ?? `read, ${l.events} events ahead`}`.trim(), ok: l.ok && !l.error });
  for (const l of fetchPage.log) requests.push({ kind: "page", ms: l.ms, detail: `${l.url} ${l.status ?? ""} ${l.error ?? "read"}`.trim(), ok: l.ok });
  for (const it of items) {
    const c = it.check;
    if (c && (c.status === "not_found" || c.status === "unsupported") && it.claimedKind === "verified") problems.push(`"${it.headline.slice(0, 60)}": ${c.note}; shown as reported, not verified`);
  }
  return {
    status: "ok", error: null, startedAt: new Date(started).toISOString(), ms: Date.now() - started, requests,
    version: DESK_VERSION, desk: key, title: desk.title, generatedAt: new Date().toISOString(), model,
    items, calendar, uncertainties: v.uncertainties,
    searches: usage.searches, pagesReturned: pages.size, problems: [...problems, ...v.problems], usage,
  };
}

/** Looks for the event's date on official pages the desk's searches returned, other than the one it cited. */
async function confirmFromReturnedPages(ev: DeskResult["calendar"][number], urls: string[], fetchPage: ReturnType<typeof pageFetcher>, names: Record<string, string>) {
  const companies = ev.symbols.map((s) => names[s]).filter(Boolean);
  const word = companies[0]?.toLowerCase().split(/\s+/)[0] ?? null;
  const candidates = urls.filter((u) => u !== ev.source?.url && officialFor(ev.type, u, companies)).slice(0, 4);
  for (const url of candidates) {
    const p = await fetchPage(url);
    if (!p.ok || !dateOnPage(ev.date, p.text) || (word && !p.text.toLowerCase().includes(word))) continue;
    const source = { url, title: `${companies[0] ?? ev.symbols.join(", ")} announcement`, publisher: companies[0] ?? null, published: null, checked: true };
    return { ...ev, status: "confirmed" as const, source, check: { official: true, dateFound: true, url, note: `date shown on the company's own page (the originally cited ${ev.source?.url ?? "page"} could not confirm it)`, retrievedAt: new Date().toISOString() } };
  }
  return null;
}

/** Official events win over searched ones for the same day and kind of event. */
function mergeEvents(official: DeskResult["calendar"], searched: DeskResult["calendar"]) {
  const key = (e: DeskResult["calendar"][number]) => `${e.date}|${e.type}|${e.event.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12)}`;
  const offDays = new Set(official.map((e) => `${e.date}|${e.type}`));
  const keep = searched.filter((e) => !(e.type !== "earnings" && offDays.has(`${e.date}|${e.type}`)));
  const seen = new Set(official.map(key));
  return [...official, ...keep.filter((e) => !seen.has(key(e)))].sort((a, b) => a.date.localeCompare(b.date));
}

/** A second reading of each claim against an excerpt of its page. Only a quote found verbatim on the page counts. */
async function judgeClaims(client: Anthropic, claims: { i: number; claim: string; url: string; excerpt: string }[], usage: { input: number; output: number; searches: number }, requests: NonNullable<DeskResult["requests"]>) {
  const out = new Map<number, { support: Support; quote: string | null }>();
  if (!claims.length) return out;
  const t0 = Date.now();
  try {
    const res = await client.messages.create({
      model: DESK_MODEL, max_tokens: 4000, output_config: { effort: "low" },
      system: "You check whether web pages support specific claims. Use only the excerpt given for each claim. support: \"supported\" if the excerpt states every part of the claim (figures, dates, who said it); \"partial\" if it states some parts; \"unsupported\" if it contradicts the claim or is about something else; \"insufficient\" if it does not address it. quote: copy, character for character, the one sentence from the excerpt that best supports the claim, or null. Reply with only a JSON array in a ```json block: [{\"id\":1,\"support\":\"...\",\"quote\":\"...\"}].",
      messages: [{ role: "user", content: claims.map((c) => `#${c.i}\nCLAIM: ${c.claim}\nPAGE: ${c.url}\nEXCERPT: ${c.excerpt || "(no related text found on the page)"}`).join("\n\n") }],
    });
    usage.input += res.usage.input_tokens; usage.output += res.usage.output_tokens;
    requests.push({ kind: "model", ms: Date.now() - t0, detail: `content check of ${claims.length} claims: ${res.model} ${res.stop_reason}; ${res.usage.input_tokens} in, ${res.usage.output_tokens} out`, ok: true });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const arr = extractJson(text.includes("```json") ? text : text.replace(/^[^[]*/, "```json\n").replace(/[^\]]*$/, "]\n```"));
    for (const r of Array.isArray(arr) ? arr : []) {
      const x = r as { id?: number; support?: string; quote?: string | null };
      if (typeof x.id !== "number") continue;
      const support = (["supported", "partial", "unsupported", "insufficient"].includes(x.support ?? "") ? x.support : "insufficient") as Support;
      out.set(x.id, { support, quote: typeof x.quote === "string" ? x.quote : null });
    }
  } catch (e) {
    requests.push({ kind: "model", ms: Date.now() - t0, detail: `content check failed: ${(e as Error).message.slice(0, 120)}`, ok: false });
  }
  return out;
}

export async function runSynthesis(ctx: SynthesisContext): Promise<{ synthesis: Synthesis; problems: string[]; model: string; usage: { input: number; output: number; searches: number } }> {
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: SYNTH_MODEL,
    max_tokens: 10000,
    system: synthesisSystem(),
    // No strict output schema: the API rejected this schema as too large to compile. The reply is a JSON
    // block that validateSynthesis checks and repairs field by field. Runs as a background job, so medium effort fits.
    output_config: { effort: "medium" },
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
