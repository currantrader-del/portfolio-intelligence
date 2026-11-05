import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Tag } from "@/components/Tag";
import { EXTRACTION_LABEL, ORIGIN_LABEL } from "@/lib/research-labels";
import { getWorkspace } from "@/lib/workspace";
import { TodayValuation } from "@/components/TodayValuation";

type Phase = { phase_number: number; title: string | null; extraction: string; body_markdown: string | null };
type Version = {
  id: string; research_as_of: string; completeness: string; origin: string; is_current: boolean;
  conclusion: Record<string, unknown>; change_summary: string | null;
  source_documents: { file_name: string; sha256: string } | null;
  research_phases: Phase[];
};

export default async function CompanyPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const supabase = await createClient();
  const { data: company } = await supabase
    .from("companies")
    .select("symbol, name, research_versions(id, research_as_of, completeness, origin, is_current, conclusion, change_summary, source_documents(file_name, sha256), research_phases(phase_number, title, extraction, body_markdown))")
    .eq("symbol", symbol.toUpperCase())
    .maybeSingle();
  if (!company) notFound();

  const ws = await getWorkspace();
  const versions = ([...(company.research_versions ?? [])] as unknown as Version[]).sort((a, b) => b.research_as_of.localeCompare(a.research_as_of));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="font-mono text-muted text-sm">{company.symbol}</div>
        <h1 className="font-serif text-3xl font-semibold">{company.name ?? company.symbol}</h1>
        {versions.length > 1 && !versions.some((v) => v.is_current) && (
          <p className="mt-2 text-sm text-alert-ink">These records disagree and none is marked current. A targeted refresh is needed before any advice.</p>
        )}
      </div>
      <TodayValuation ws={ws} symbol={company.symbol} />
      {versions.map((v) => {
        const c = v.conclusion as Record<string, string | number | null>;
        return (
          <section key={v.id} className="bg-surface border border-line rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold mr-2">Research as of {v.research_as_of}</h2>
              <Tag tone={v.completeness === "complete" ? "accent" : "warn"}>{v.completeness.replace("_", " ")}</Tag>
              <Tag>{ORIGIN_LABEL[v.origin] ?? v.origin}</Tag>
              {v.is_current && <Tag tone="accent">Current</Tag>}
            </div>
            <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-4 text-sm">
              {(["classification", "action", "confidence", "reference_price"] as const).map((k) => (
                <div key={k}><dt className="text-muted capitalize">{k.replace("_", " ")}</dt><dd className="font-medium">{c[k] ?? "—"}</dd></div>
              ))}
            </dl>
            {v.change_summary && <p className="text-sm text-ink-2">{v.change_summary}</p>}
            {v.source_documents && (
              <p className="text-xs text-muted">Source: {v.source_documents.file_name} · SHA-256 <span className="font-mono">{v.source_documents.sha256.slice(0, 12)}…</span></p>
            )}
            {v.research_phases?.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Research phases</h3>
                {[...v.research_phases].sort((a, b) => a.phase_number - b.phase_number).map((p) => (
                  <details key={p.phase_number} className="border border-line rounded-lg">
                    <summary className="cursor-pointer px-4 py-3 flex flex-wrap items-center gap-2 min-h-11">
                      <span className="font-medium">Phase {p.phase_number}{p.title ? ` · ${p.title}` : ""}</span>
                      <Tag tone={p.extraction === "verbatim" ? "accent" : "warn"}>{EXTRACTION_LABEL[p.extraction] ?? p.extraction}</Tag>
                    </summary>
                    <pre className="whitespace-pre-wrap font-sans text-sm text-ink-2 px-4 pb-4 max-h-[480px] overflow-auto">{p.body_markdown ?? "No text preserved."}</pre>
                  </details>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
