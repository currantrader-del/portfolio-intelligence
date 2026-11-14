import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportPlan } from "./plan";

/**
 * Writes an import plan. Idempotent: rows that already exist are skipped, so it is safe to run twice.
 * In the browser it runs under the signed-in user's session (RLS sets owner_id); the CLI passes owner_id.
 */
export async function applyPlan(
  db: SupabaseClient,
  plan: ImportPlan,
  files: Map<string, Uint8Array>,
  opts: { ownerId: string; log?: (line: string) => void },
) {
  const log = opts.log ?? (() => {});
  const owner_id = opts.ownerId;

  const docIds = new Map<string, string>();
  for (const d of plan.documents) {
    const storage_path = `${owner_id}/${d.sha256}/${d.fileName}`;
    const bytes = files.get(d.key);
    if (bytes) {
      const up = await db.storage.from("originals").upload(storage_path, bytes, { upsert: false, contentType: "application/octet-stream" });
      if (up.error && !/exists|duplicate/i.test(up.error.message)) throw up.error;
    }
    const { data, error } = await db.from("source_documents")
      .upsert({ owner_id, file_name: d.fileName, sha256: d.sha256, byte_size: d.byteSize, storage_path, origin: d.origin, description: d.description }, { onConflict: "owner_id,sha256" })
      .select("id").single();
    if (error) throw error;
    docIds.set(d.key, data.id);
    log(`Saved original ${d.fileName}`);
  }

  const companyIds = new Map<string, string>();
  for (const c of plan.companies) {
    const { data, error } = await db.from("companies").upsert({ owner_id, ...c }, { onConflict: "owner_id,symbol" }).select("id").single();
    if (error) throw error;
    companyIds.set(c.symbol, data.id);
  }
  log(`Saved ${plan.companies.length} companies`);

  for (const v of plan.versions) {
    const company_id = companyIds.get(v.symbol)!;
    const source_document_id = docIds.get(v.docKey)!;
    const { data: existing, error: exErr } = await db.from("research_versions").select("id")
      .eq("company_id", company_id).eq("research_as_of", v.research_as_of).eq("source_document_id", source_document_id);
    if (exErr) throw exErr;
    if (existing?.length) { log(`Skipped ${v.symbol} ${v.research_as_of}: already imported`); continue; }
    const { data, error } = await db.from("research_versions").insert({
      owner_id, company_id, research_as_of: v.research_as_of, completeness: v.completeness, origin: v.origin,
      is_current: v.is_current, conclusion: v.conclusion, change_summary: v.change_summary, source_document_id,
    }).select("id").single();
    if (error) throw error;
    for (const p of v.phases) {
      const { error: pErr } = await db.from("research_phases").insert({
        owner_id, version_id: data.id, phase_number: p.phase_number, title: p.title, body_markdown: p.body_markdown,
        extraction: p.extraction, details: p.details ?? {}, source_document_id: docIds.get(p.docKey) ?? null,
      });
      if (pErr) throw pErr;
    }
    log(`Saved ${v.symbol} research (${v.research_as_of}, ${v.completeness}, ${v.phases.length} phases)`);
  }

  for (const d of plan.decisions) {
    const source_document_id = docIds.get(d.docKey)!;
    const { data: existing } = await db.from("decisions").select("id").eq("kind", "historical").eq("symbol", d.symbol).eq("source_document_id", source_document_id);
    if (existing?.length) continue;
    const { error } = await db.from("decisions").insert({ owner_id, kind: "historical", status: "historical", symbol: d.symbol, decided_at: d.decided_at, research_as_of: d.decided_at?.slice(0, 10) ?? null, imported_at: new Date().toISOString(), recommendation: d.recommendation, source_document_id });
    if (error) throw error;
  }
  log(`Saved ${plan.decisions.length} historical decisions`);

  if (plan.policy) {
    const { data: existing } = await db.from("policies").select("id").eq("version", plan.policy.version);
    if (!existing?.length) {
      const { error } = await db.from("policies").insert({ owner_id, version: plan.policy.version, effective_from: plan.policy.effective_from,
        is_current: true, rules: plan.policy.rules, source_document_id: docIds.get(plan.policy.docKey)! });
      if (error) throw error;
    }
    log(`Saved policy ${plan.policy.version}`);
  }
}
