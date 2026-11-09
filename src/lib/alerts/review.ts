/**
 * Filing review: turns the raw "filed recently" event alerts into review items.
 *  - Filings that belong together become one item (a 10-Q and its results 8-K on the same day;
 *    several offering prospectuses from one company).
 *  - An item is "covered" when an investigation already read every filing in it in full, and
 *    "reviewed" when the investor marked it "no change". Neither needs attention.
 *  - Offering prospectuses are labelled debt / convertible / shares from their cover page
 *    (code only, read once and saved), because a bond sale adds no shares.
 * No AI is used anywhere here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Alert, Severity } from "./rules";
import { save } from "@/lib/intel/jobs";
import { shortDate } from "@/lib/format";
import { FIXTURE } from "@/lib/dev/fixture";

export const REVIEW_VERSION = "filing-review@1";

/** EDGAR accession numbers appear with dashes (API) and without (URLs). Compare without. */
export const accKey = (s?: string | null) => (s ?? "").replace(/-/g, "");
export function accFromUrl(url?: string | null): string | null {
  const m = url?.match(/\/edgar\/data\/\d+\/(\d{18})\//);
  return m ? m[1] : null;
}

export type Offering = "debt" | "convertible" | "shares" | "unclear";
export type EventFiling = { form: string; filed: string; url: string; accession: string };
export type ReviewStatus = "to_review" | "covered" | "reviewed";
export type EventItem = {
  key: string; symbol: string; title: string; detail: string; severity: Severity; href: string;
  timing: "recent" | "upcoming"; filings: EventFiling[];
  status: ReviewStatus | null; coveredBy: string | null; couldChange: string | null; offering: Offering | null;
};
export type ReviewState = {
  /** accession (no dashes) -> label of the research that read it in full, e.g. "your Nov 8 investigation" */
  covered: Map<string, string>;
  /** accessions the investor marked "reviewed, no change" */
  reviewed: Set<string>;
  /** accession -> offering type read from the cover page */
  offerings: Map<string, Offering>;
};

/** The category is the second part of the event id: ev-<category>-<symbol>-<accession>. */
const categoryOf = (a: Alert) => (a.id.startsWith("ev-") ? a.id.split("-")[1] : "");

const COULD_CHANGE: Record<string, string> = {
  results: "The quarter's revenue, margins, cash, debt and share count. Compare them with the assumptions in your research.",
  periodic: "The quarter's revenue, margins, cash, debt and share count. Compare them with the assumptions in your research.",
  financing: "It may add debt or new shares. The amount, price and any effect on the share count are in the document.",
  material_event: "A material agreement, deal or leadership change. Check what it commits the company to.",
  registration: "It allows securities to be sold later; nothing is sold by this filing alone.",
  resale: "Existing holders may resell shares they already own; usually no new shares and no cash for the company.",
};

const OFFERING_NOTE: Record<Offering, string> = {
  debt: "The cover page describes notes (debt). A bond sale adds no shares; it matters only if the amount is large for the company.",
  convertible: "The cover page describes convertible securities. They can turn into shares later, so check the size and conversion price.",
  shares: "The cover page describes a sale of shares. Check the number of shares against the share count: that is the dilution.",
  unclear: "The cover page did not clearly say whether this is debt or shares; open the document.",
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Pure: groups filed alerts into review items and gives each a status. Upcoming items pass through. */
export function buildItems(alerts: Alert[], state: ReviewState): EventItem[] {
  const groups = new Map<string, Alert[]>();
  const out: EventItem[] = [];
  for (const a of alerts) {
    if (a.timing === "upcoming" || !a.source || !a.symbol) {
      out.push({ key: a.id, symbol: a.symbol ?? "", title: a.title, detail: a.detail, severity: a.severity, href: a.href, timing: a.timing === "upcoming" ? "upcoming" : "recent", filings: [], status: null, coveredBy: null, couldChange: null, offering: null });
      continue;
    }
    const cat = categoryOf(a);
    const key = cat === "periodic" || cat === "results" ? `${a.symbol}|results|${a.source.filed}` : cat === "financing" && a.source.form.startsWith("424B") ? `${a.symbol}|offering` : a.id;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  for (const [key, xs] of groups) {
    const a = xs[0], sym = a.symbol!, cat = categoryOf(a);
    const filings: EventFiling[] = xs.map((x) => ({ form: x.source!.form, filed: x.source!.filed, url: x.source!.url, accession: accKey(accFromUrl(x.source!.url) ?? x.id.split("-").slice(3).join("-")) }));
    const severity = xs.map((x) => x.severity).sort((p, q) => RANK[p] - RANK[q])[0];
    const isResults = key.includes("|results|"), isOffering = key.endsWith("|offering");
    let title = a.title, detail = a.detail;
    if (isResults && xs.length > 1) {
      const annual = filings.some((f) => f.form.startsWith("10-K") || f.form.startsWith("20-F"));
      title = `${sym} reported ${annual ? "annual" : "quarterly"} results`;
      detail = `${filings.map((f) => f.form).join(" and ")} filed ${filings[0].filed}. ${xs.find((x) => categoryOf(x) === "results")?.detail.replace(/^.*?filed \S+\. /, "") ?? ""}`.trim();
    }
    const offers = isOffering ? filings.map((f) => state.offerings.get(f.accession) ?? null) : [];
    const offering: Offering | null = !isOffering ? null : offers.every((o) => o === "debt") ? "debt" : offers.some((o) => o === "shares") ? "shares" : offers.some((o) => o === "convertible") ? "convertible" : offers.some((o) => o === null) ? null : "unclear";
    if (isOffering) {
      const kind = offering === "debt" ? " (debt)" : offering === "shares" ? " (shares)" : offering === "convertible" ? " (convertible)" : "";
      title = xs.length > 1 ? `${sym}: ${xs.length} offering documents${kind}` : `${sym} filed an offering document${kind}`;
      detail = `${filings.map((f) => `${f.form} filed ${f.filed}`).join("; ")}.`;
    }
    const covered = filings.map((f) => state.covered.get(f.accession) ?? null);
    const status: ReviewStatus = covered.every(Boolean) ? "covered" : filings.every((f) => state.reviewed.has(f.accession) || state.covered.has(f.accession)) ? "reviewed" : "to_review";
    const couldChange = isOffering && offering ? OFFERING_NOTE[offering] : COULD_CHANGE[isResults ? "results" : cat] ?? "Read the document before drawing a conclusion.";
    out.push({ key, symbol: sym, title, detail, severity: offering === "debt" ? "low" : severity, href: a.href, timing: "recent", filings, status, coveredBy: status === "covered" ? covered[0] : null, couldChange, offering });
  }
  const open = (i: EventItem) => (i.status === "to_review" || i.status === null ? 0 : 1);
  return out.sort((p, q) => open(p) - open(q) || RANK[p.severity] - RANK[q.severity]);
}

/** Pure: what a prospectus cover page says is being sold. Debt is checked first: note prospectuses mention shares in boilerplate. */
export function classifyOffering(text: string): Offering {
  const t = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").slice(0, 8000);
  if (/convertible (senior )?notes|convertible into|exchangeable notes/i.test(t)) return "convertible";
  if (/\bnotes due\b|% (senior )?notes|senior notes|debentures|floating rate notes|fixed[- ]rate notes/i.test(t)) return "debt";
  if (/shares of (our )?(class [abc] )?common stock|ordinary shares|american depositary shares/i.test(t)) return "shares";
  return "unclear";
}

/** Reads only the start of a document (the cover page), then stops. */
async function coverText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "PortfolioIntelligence/1.0 (personal research)" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader(); const dec = new TextDecoder(); let s = "";
    while (s.length < 120_000) { const { done, value } = await reader.read(); if (done) break; s += dec.decode(value, { stream: true }); }
    reader.cancel().catch(() => {});
    const body = s.search(/<body/i);
    return s.slice(body > 0 ? body : 0);
  } catch { return null; }
}

/** Loads coverage, "no change" marks and saved offering labels; labels new offering documents once. */
export async function loadReviewState(db: SupabaseClient, alerts: Alert[]): Promise<ReviewState> {
  const state: ReviewState = { covered: new Map(), reviewed: new Set(), offerings: new Map() };
  if (FIXTURE) return state;
  const symbols = [...new Set(alerts.map((a) => a.symbol).filter((s): s is string => !!s))];
  if (!symbols.length) return state;
  const [cos, marks, labels] = await Promise.all([
    db.from("companies").select("symbol, research_versions(id, research_as_of, conclusion, research_sources(url, details))").in("symbol", symbols),
    db.from("model_runs").select("outputs").eq("kind", "filing_review").order("computed_at", { ascending: false }).limit(500),
    db.from("model_runs").select("outputs").eq("kind", "filing_label").order("computed_at", { ascending: false }).limit(500),
  ]);
  type Src = { url: string | null; details: { review_status?: string } | null };
  type Ver = { research_as_of: string; conclusion: { research_type?: string } | null; research_sources: Src[] | null };
  for (const c of (cos.data ?? []) as { symbol: string; research_versions: Ver[] | null }[]) {
    const vs = [...(c.research_versions ?? [])].sort((p, q) => p.research_as_of.localeCompare(q.research_as_of));
    for (const v of vs) {
      const kind = v.conclusion?.research_type === "material_event_refresh" ? "update" : "investigation";
      for (const s of v.research_sources ?? []) {
        const acc = accFromUrl(s.url);
        const st = s.details?.review_status;
        if (acc && (st === "fully_reviewed" || st === "partially_reviewed") && !state.covered.has(acc)) state.covered.set(acc, `your ${shortDate(v.research_as_of)} ${kind}`);
      }
    }
  }
  for (const r of (marks.data ?? []) as { outputs: { accessions?: string[] } }[]) for (const a of r.outputs.accessions ?? []) state.reviewed.add(accKey(a));
  for (const r of (labels.data ?? []) as { outputs: { accession?: string; offering?: Offering } }[]) if (r.outputs.accession && r.outputs.offering && !state.offerings.has(r.outputs.accession)) state.offerings.set(r.outputs.accession, r.outputs.offering);

  // Offering prospectuses not yet labelled: read the cover page once (at most 3 per page view) and save the label.
  const todo = alerts.filter((a) => a.source?.form.startsWith("424B") && a.timing !== "upcoming").map((a) => ({ url: a.source!.url, acc: accKey(accFromUrl(a.source!.url)) })).filter((x) => x.acc && !state.offerings.has(x.acc)).slice(0, 3);
  await Promise.all(todo.map(async (x) => {
    const text = await coverText(x.url);
    if (text === null) return;
    const offering = classifyOffering(text);
    state.offerings.set(x.acc, offering);
    await save(db, "filing_label", REVIEW_VERSION, { accession: x.acc }, { accession: x.acc, offering, url: x.url }).catch(() => null);
  }));
  return state;
}
