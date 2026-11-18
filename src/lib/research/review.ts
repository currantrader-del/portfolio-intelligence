/**
 * Reviewer annotations: corrections and flags laid over a saved research record when it is shown and used,
 * without changing the record itself. They live in the record's validation report (model_runs
 * "research_validation", newest wins), so the original stays exactly as the investigation wrote it and
 * every correction says what it replaced.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifySource } from "./validate";
import type { ScenarioSpec } from "./investigate/valuationCalc";

export type ReviewAnnotations = {
  /** Valuation inputs that matter and are not reconciled to the filings. scenario "all" covers every case. */
  material_inputs: { scenario: string; input: string; note: string }[];
  /** Findings taken out of the evidence (the record keeps them, shown as withdrawn). */
  withdrawn_findings: { id: string; reason: string }[];
  /** Finding claims that go beyond what their checked quote supports, restated (the original is kept as claim_original). */
  finding_corrections?: { id: string; claim: string; reason: string }[];
  /** Text corrections in the summary: the original sentence and what is shown instead. */
  corrections: { field: "reasons" | "risks" | "headline" | "valuation" | "expected_return"; find: string; replace: string }[];
  /** The recommendation as it should read: conditional, and never a trade instruction. */
  conditional_action: string | null;
  by: string;
  at: string;
};

type Obj = Record<string, unknown>;

/** The conclusion with the annotations applied; the original values are kept under `review_original`. */
export function applyReview(conclusion: Obj, ann: ReviewAnnotations | null | undefined): Obj {
  if (!ann) return conclusion;
  const c: Obj = { ...conclusion, review: ann, review_original: { action: conclusion.action ?? null } };
  const sm = conclusion.investment_summary as Obj | undefined;
  if (sm) {
    const next: Obj = { ...sm };
    for (const k of ["reasons", "risks"] as const) if (Array.isArray(sm[k])) next[k] = (sm[k] as string[]).map((t) => fix(t, ann, k));
    for (const k of ["headline", "valuation", "expected_return"] as const) if (typeof sm[k] === "string") next[k] = fix(sm[k] as string, ann, k);
    if (ann.conditional_action) next.action = ann.conditional_action;
    c.investment_summary = next;
  }
  if (ann.conditional_action) c.action = ann.conditional_action;
  const ev = conclusion.evidence as Obj | undefined;
  const fc = ann.finding_corrections ?? [];
  if (ev && Array.isArray(ev.findings) && (ann.withdrawn_findings.length || fc.length)) {
    const w = new Map(ann.withdrawn_findings.map((x) => [x.id, x.reason]));
    const k = new Map(fc.map((x) => [x.id, x]));
    c.evidence = { ...ev, findings: (ev.findings as Obj[]).map((f) => {
      let g = f;
      const fix = k.get(String(f.id));
      if (fix) g = { ...g, claim: fix.claim, claim_original: f.claim, claim_correction: fix.reason };
      if (w.has(String(f.id)) && !f.withdrawn) g = { ...g, withdrawn: { reason: `${w.get(String(f.id))} (reviewer, ${ann.at.slice(0, 10)})`, replaced_by: null } };
      return g;
    }) };
  }
  return c;
}

function fix(text: string, ann: ReviewAnnotations, field: ReviewAnnotations["corrections"][number]["field"]) {
  let t = text;
  for (const x of ann.corrections) if (x.field === field && t.includes(x.find)) t = t.replace(x.find, x.replace);
  return t;
}

/** The open items a provisional approval carries: material inputs, withdrawn findings and the validation's caveats. */
export function provisionalItems(report: { checks?: { status: string; label: string; detail: string }[]; annotations?: ReviewAnnotations | null } | null): string[] {
  if (!report) return [];
  const a = report.annotations;
  return [
    ...(a?.material_inputs ?? []).map((m) => `Material input not reconciled: ${m.input}${m.scenario === "all" ? "" : ` (${m.scenario})`}. ${m.note}`),
    ...(a?.withdrawn_findings ?? []).map((w) => `Finding ${w.id} withdrawn: ${w.reason}`),
    ...(report.checks ?? []).filter((c) => c.status !== "pass").map((c) => `${c.label}: ${c.detail}`),
  ];
}

export type InputRow = { scenario: string; input: string; value: number; kind: "sourced" | "calculation" | "estimate"; cites: string[]; source: string; material: string | null };

/** Every valuation input, marked as taken from a finding or as the model's estimate, with any material flag. */
export function inputRows(specs: ScenarioSpec[], ann?: ReviewAnnotations | null): InputRow[] {
  return specs.flatMap((s) => Object.entries(s.inputs).filter(([, v]) => typeof v === "number").map(([k, v]) => {
    const src = String(s.sources?.[k] ?? "");
    const { kind, cites } = classifySource(src);
    const m = ann?.material_inputs.find((x) => x.input === k && (x.scenario === "all" || x.scenario === s.name));
    return { scenario: s.name, input: k, value: v as number, kind: kind === "finding" ? "sourced" : kind, cites, source: src, material: m?.note ?? null };
  }));
}

/** Versions with any reviewer annotations applied to their conclusions (the stored rows are not changed). */
export function withReviews<T extends { id: string; conclusion?: unknown }>(versions: T[], reviews: Map<string, ReviewAnnotations>): T[] {
  return versions.map((v) => {
    const ann = reviews.get(v.id);
    return ann && v.conclusion && typeof v.conclusion === "object" ? { ...v, conclusion: applyReview(v.conclusion as Obj, ann) } : v;
  });
}

/** Newest reviewer annotations per research version. */
export async function loadReviews(db: SupabaseClient): Promise<Map<string, ReviewAnnotations>> {
  const { data } = await db.from("model_runs").select("computed_at, vid:inputs->>version_id, ann:outputs->annotations").eq("kind", "research_validation").order("computed_at", { ascending: false }).limit(200);
  const out = new Map<string, ReviewAnnotations>();
  for (const r of (data ?? []) as { vid: string | null; ann: ReviewAnnotations | null }[]) if (r.vid && r.ann && !out.has(r.vid)) out.set(r.vid, r.ann);
  return out;
}
