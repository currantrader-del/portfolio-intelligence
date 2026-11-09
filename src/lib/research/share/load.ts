import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReviews, withReviews } from "../review";
import type { ValidationReport } from "../validate";
import { makeRedactor, type PrivateFingerprint } from "./redact";
import { buildShareReport, pickVersion, shareOptions, type ShareChoice, type ShareReport, type ShareVersion } from "./report";

const GENERIC = new Set(["savings", "cash", "bank", "invest", "later", "brokerage", "checking", "account", "entered", "retirement"]);

/** Account names and hints worth matching: multi-word names and distinctive single words. */
export function accountTerms(accounts: { name: string | null; institution: string | null; external_ref_hint: string | null }[]): { terms: string[]; hints: string[] } {
  const terms = new Set<string>();
  const hints: string[] = [];
  for (const a of accounts) {
    for (const raw of [a.name, a.institution]) {
      if (!raw) continue;
      const parts = [raw.replace(/\(.*?\)/g, "").trim(), ...[...raw.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim())];
      for (const p of parts) {
        if (!p || /entered by you/i.test(p)) continue;
        const words = p.split(/\s+/);
        if (words.length >= 2 || (p.length >= 5 && !GENERIC.has(p.toLowerCase()))) terms.add(p);
      }
    }
    if (a.external_ref_hint && /^[A-Za-z0-9]{3,6}$/.test(a.external_ref_hint)) hints.push(a.external_ref_hint);
  }
  return { terms: [...terms], hints };
}

/** The owner's own numbers and account names, read at export time, used to catch anything the wording rules miss. */
export async function loadFingerprint(db: SupabaseClient): Promise<PrivateFingerprint> {
  const [{ data: accounts }, { data: snaps }] = await Promise.all([
    db.from("accounts").select("name, institution, external_ref_hint"),
    db.from("holding_snapshots").select("id, total_value, cash_value, positions(market_value, cost_basis)").order("as_of", { ascending: false }).limit(60),
  ]);
  const amounts: number[] = [];
  const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN);
  for (const s of (snaps ?? []) as { total_value: unknown; cash_value: unknown; positions?: { market_value: unknown; cost_basis: unknown }[] }[]) {
    amounts.push(num(s.total_value), num(s.cash_value));
    for (const p of s.positions ?? []) {
      const mv = num(p.market_value), cb = num(p.cost_basis);
      amounts.push(mv, cb);
      if (Number.isFinite(mv) && Number.isFinite(cb)) amounts.push(mv - cb);
    }
  }
  const { terms, hints } = accountTerms((accounts ?? []) as { name: string | null; institution: string | null; external_ref_hint: string | null }[]);
  return { amounts: amounts.filter((a) => Number.isFinite(a) && a !== 0), terms: [...terms, ...hints.flatMap((h) => [`x${h}`, `ending in ${h}`, `ending ${h}`, `#${h}`, `...${h}`, `*${h}`])] };
}

export async function loadShareReport(db: SupabaseClient, symbol: string, choice: ShareChoice): Promise<{ report: ShareReport } | { error: string; status: number }> {
  const { data: company } = await db
    .from("companies")
    .select("symbol, name, research_versions(id, research_as_of, created_at, completeness, origin, is_current, conclusion, research_phases(phase_number, title, body_markdown, details), research_sources(title, url, document_date, details))")
    .eq("symbol", symbol)
    .maybeSingle();
  if (!company) return { error: `No research saved for ${symbol}.`, status: 404 };
  const reviews = await loadReviews(db);
  const versions = withReviews([...((company.research_versions ?? []) as unknown as ShareVersion[])], reviews);
  const v = pickVersion(versions, choice);
  if (!v) return { error: choice === "approved" ? `There is no approved full investigation of ${symbol} to share.` : `There is no finished full investigation of ${symbol} to share.`, status: 404 };
  const { data: valRow } = await db.from("model_runs").select("outputs").eq("kind", "research_validation").eq("inputs->>version_id", v.id).order("computed_at", { ascending: false }).limit(1).maybeSingle();
  const opts = shareOptions(versions);
  const redactor = makeRedactor(await loadFingerprint(db));
  const report = buildShareReport({
    symbol: company.symbol, name: company.name, version: v, choice,
    approved: opts.approved, latest: opts.latest,
    validation: (valRow?.outputs as ValidationReport | undefined) ?? null,
    redactor,
  });
  return { report };
}
