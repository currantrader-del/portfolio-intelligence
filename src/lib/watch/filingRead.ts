/**
 * A two-line plain read of a new filing for its phone alert (2026-11-11), so an alert says what the filing
 * says instead of only "a filing arrived". A small model (Haiku) reads the start of the main document and,
 * for an 8-K, its press-release exhibit (99.x), and answers in two short lines: what it says, and whether it
 * touches the thesis on file. About half a cent per filing; each filing is read once (model_runs "filing_read").
 * It is a first read, labelled as such: it never replaces reading the filing or a research update.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { save } from "@/lib/intel/jobs";
import { htmlText } from "@/lib/intel/verify";
import { SEC_UA } from "@/lib/market/sec";
import { accFromUrl } from "@/lib/alerts/review";

export const FILING_READ_VERSION = "filing-read@1";
const MODEL = { id: "claude-haiku-5-5", inPerM: 1, outPerM: 5 };
const MAIN_CHARS = 7000, EXHIBIT_CHARS = 12000;

export type FilingRead = { accession: string; url: string; what: string; thesis: string; touches: "yes" | "no" | "unclear"; costUsd: number; at: string; model: string };

async function text(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA }, cache: "no-store", signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res?.ok) return null;
  return htmlText((await res.text()).slice(0, 3_000_000)).replace(/\s+/g, " ").trim();
}

/** The press-release exhibit of an 8-K, from the filing's index (EX-99.x files). */
async function exhibitUrl(url: string): Promise<string | null> {
  const m = url.match(/^https:\/\/www\.sec\.gov(\/Archives\/edgar\/data\/\d+\/\d{18})\//);
  if (!m) return null;
  const idx = await fetch(`https://www.sec.gov${m[1]}/index.json`, { headers: { "User-Agent": SEC_UA }, cache: "no-store", signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { directory?: { item?: { name: string }[] } } | null;
  const name = (idx?.directory?.item ?? []).map((i) => i.name).find((n) => /ex-?99/i.test(n) && /\.htm/i.test(n));
  return name ? `https://www.sec.gov${m[1]}/${name}` : null;
}

/** Parses the model's two lines. Pure. */
export function parseRead(raw: string): { what: string; thesis: string; touches: FilingRead["touches"] } | null {
  const what = raw.match(/WHAT:\s*(.+)/i)?.[1]?.trim();
  const thesis = raw.match(/THESIS:\s*(.+)/i)?.[1]?.trim();
  if (!what || !thesis) return null;
  const t = thesis.toLowerCase();
  const touches = /^(yes|touches|it touches)/.test(t) ? "yes" : /^(no|does not|doesn't)/.test(t) ? "no" : "unclear";
  return { what: what.slice(0, 260), thesis: thesis.replace(/^(yes|no|unclear)[:.,\s-]*/i, "").slice(0, 260) || thesis.slice(0, 260), touches };
}

export async function readFiling(url: string, form: string, symbol: string, thesis: string | null, client = new Anthropic()): Promise<Omit<FilingRead, "accession" | "at"> | null> {
  const main = await text(url);
  if (!main) return null;
  const ex = form.startsWith("8-K") ? await exhibitUrl(url).then((u) => (u ? text(u) : null)).catch(() => null) : null;
  const doc = `MAIN DOCUMENT (${form}, start):\n${main.slice(0, MAIN_CHARS)}${ex ? `\n\nPRESS RELEASE EXHIBIT (start):\n${ex.slice(0, EXHIBIT_CHARS)}` : ""}`;
  const res = await client.messages.create({
    model: MODEL.id, max_tokens: 220,
    system: "You read an SEC filing for a long-term individual investor and write exactly two lines, plain words, no advice to trade:\nWHAT: what the filing says, with the key numbers or terms it states (at most 200 characters).\nTHESIS: start with Yes, No or Unclear, then whether it touches the thesis on file and why (at most 200 characters).\nUse only what the text says. If the text does not say, write that it does not say.",
    messages: [{ role: "user", content: `${symbol}. Thesis on file: ${thesis ? thesis.slice(0, 500) : "none on file"}\n\n${doc}` }],
  });
  const raw = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  const p = parseRead(raw);
  if (!p) return null;
  return { url, ...p, costUsd: (res.usage.input_tokens * MODEL.inPerM + res.usage.output_tokens * MODEL.outPerM) / 1e6, model: MODEL.id };
}

/** Reads already done, by accession (no dashes). */
export async function loadFilingReads(db: SupabaseClient, accessions: string[]): Promise<Map<string, FilingRead>> {
  if (!accessions.length) return new Map();
  const { data } = await db.from("model_runs").select("outputs").eq("kind", "filing_read").in("inputs->>accession", accessions).limit(200);
  return new Map(((data ?? []) as { outputs: FilingRead }[]).map((r) => [r.outputs.accession, r.outputs]));
}

/**
 * Reads up to `max` new filings behind thesis-change alerts and writes the two lines into each alert.
 * Returns the cost. An alert whose filing could not be read keeps its original wording.
 */
export async function addFilingReads(db: SupabaseClient, alerts: { id: string; category: string; symbol: string; changed: string; uncertain: string }[], filings: Map<string, { url: string; form: string }>, theses: Map<string, string>, max = 3): Promise<number> {
  const todo = alerts.filter((a) => a.category === "thesis_change" && filings.has(a.id));
  if (!todo.length) return 0;
  const accs = todo.map((a) => accFromUrl(filings.get(a.id)!.url)).filter((x): x is string => !!x);
  const have = await loadFilingReads(db, accs).catch(() => new Map<string, FilingRead>());
  let cost = 0, read = 0;
  for (const a of todo) {
    const f = filings.get(a.id)!;
    const acc = accFromUrl(f.url);
    if (!acc) continue;
    let r = have.get(acc) ?? null;
    if (!r && read < max) {
      read++;
      const got = await readFiling(f.url, f.form, a.symbol, theses.get(a.symbol) ?? null).catch((e) => { console.error(`filing read ${a.symbol}: ${(e as Error).message}`); return null; });
      if (got) {
        r = { ...got, accession: acc, at: new Date().toISOString() };
        cost += got.costUsd;
        await save(db, "filing_read", FILING_READ_VERSION, { accession: acc, symbol: a.symbol }, r).catch(() => null);
      }
    }
    if (r) {
      a.changed = `${a.changed} First read: ${r.what}`;
      a.uncertain = `Thesis: ${r.touches === "yes" ? "touches it" : r.touches === "no" ? "does not seem to" : "unclear"}. ${r.thesis} (A quick AI read of the filing's first pages; read the filing before acting.)`;
    }
  }
  return cost;
}
