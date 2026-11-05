/**
 * Import preserved ChatGPT originals into Supabase.
 *
 *   npx tsx scripts/import-originals.mts <folder> --out <plan.json>          # dry run: writes the plan and audit report
 *   npx tsx scripts/import-originals.mts <folder> --apply --owner <email>    # inserts rows and uploads originals
 *
 * The folder holds the originals (and the JSON files extracted from the watchlist and baseline zips).
 * Nothing from that folder is ever written into the repository.
 * --apply needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in the environment.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildPlan, type Doc, type Inputs } from "../src/lib/import/plan.ts";

const args = process.argv.slice(2);
const folder = args[0];
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!folder) throw new Error("Usage: import-originals.mts <folder> [--out plan.json] [--apply --owner email]");

// Files are recognised by content where names collide (two RDDT archives share a name).
const RULES: { key: string; match: (name: string, size: number) => boolean; description: string; origin: Doc["origin"] }[] = [
  { key: "iren_archive", match: (n) => n.startsWith("IREN_FULL_RESEARCH_ARCHIVE"), description: "IREN full research archive", origin: "chatgpt_export" },
  { key: "rddt_a", match: (n, s) => n.startsWith("RDDT_FULL_RESEARCH_ARCHIVE") && s > 120_000, description: "RDDT archive, version A (phase 4 verbatim, 6 restated)", origin: "chatgpt_export" },
  { key: "rddt_b", match: (n, s) => n.startsWith("RDDT_FULL_RESEARCH_ARCHIVE") && s <= 120_000, description: "RDDT archive, version B (1-3 and 6 reconstructed)", origin: "chatgpt_export" },
  { key: "rddt_p4", match: (n) => n.includes("RDDT Phase 4"), description: "RDDT phase 4 checkpoint, pasted", origin: "chatgpt_paste" },
  { key: "rddt_p5", match: (n) => n.includes("RDDT Phase 5"), description: "RDDT phase 5 valuation, pasted", origin: "chatgpt_paste" },
  { key: "googl_md", match: (n) => n.includes("GOOGL Master Record"), description: "GOOGL master record, Sep 12, pasted", origin: "chatgpt_paste" },
  { key: "master", match: (n) => n === "MASTER_INVESTMENT_RESEARCH_AND_DECISIONS_2026.json", description: "Master research and decisions export", origin: "chatgpt_export" },
  { key: "watchlist", match: (n) => n === "WATCHLIST_SCREENING_COMPLETE_2026.json", description: "Watchlist screening export", origin: "chatgpt_export" },
  { key: "baseline", match: (n) => n === "PORTFOLIO_BASELINE_AND_RISK_POLICY.json", description: "Portfolio baseline and risk policy export", origin: "chatgpt_export" },
];

const docs: (Doc & { path: string })[] = [];
const content = new Map<string, Buffer>();
for (const name of readdirSync(folder)) {
  const path = join(folder, name);
  const size = statSync(path).size;
  const rule = RULES.find((r) => r.match(name, size));
  if (!rule) continue;
  const buf = readFileSync(path);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  docs.push({ key: rule.key, fileName: name, sha256, byteSize: size, origin: rule.origin, description: rule.description, path });
  content.set(rule.key, buf);
}

const json = (k: string) => (content.has(k) ? JSON.parse(content.get(k)!.toString("utf8")) : undefined);
const text = (k: string) => content.get(k)?.toString("utf8");
const inputs: Inputs = {
  docs, irenArchive: json("iren_archive"), rddtArchiveA: json("rddt_a"), rddtArchiveB: json("rddt_b"),
  rddtPhase4Md: text("rddt_p4"), rddtPhase5Md: text("rddt_p5"), googlMasterMd: text("googl_md"),
  master: json("master"), watchlist: json("watchlist"), baseline: json("baseline"),
};
const plan = buildPlan(inputs);

console.log("Source documents:");
for (const d of docs) console.log(`  ${d.key.padEnd(13)} ${d.sha256.slice(0, 12)}  ${d.fileName}`);
console.log("\nAudit:");
for (const line of plan.report) console.log(`  - ${line}`);

const out = flag("--out");
if (out) {
  writeFileSync(out, JSON.stringify(plan, null, 2));
  console.log(`\nPlan written to ${out}`);
}

if (args.includes("--apply")) {
  const ownerEmail = flag("--owner");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!ownerEmail || !url || !secret) throw new Error("--apply needs --owner, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
  const db = createClient(url, secret, { auth: { persistSession: false } });

  const { data: users, error: uErr } = await db.auth.admin.listUsers();
  if (uErr) throw uErr;
  const owner = users.users.find((u) => u.email?.toLowerCase() === ownerEmail.toLowerCase());
  if (!owner) throw new Error(`No user with email ${ownerEmail}`);
  const owner_id = owner.id;

  const docIds = new Map<string, string>();
  for (const d of docs) {
    const storage_path = `${owner_id}/${d.sha256}/${d.fileName}`;
    const up = await db.storage.from("originals").upload(storage_path, content.get(d.key)!, { upsert: false });
    if (up.error && !/exists/i.test(up.error.message)) throw up.error;
    const { data, error } = await db.from("source_documents")
      .upsert({ owner_id, file_name: d.fileName, sha256: d.sha256, byte_size: d.byteSize, storage_path, origin: d.origin, description: d.description }, { onConflict: "owner_id,sha256" })
      .select("id").single();
    if (error) throw error;
    docIds.set(d.key, data.id);
  }

  const companyIds = new Map<string, string>();
  for (const c of plan.companies) {
    const { data, error } = await db.from("companies").upsert({ owner_id, ...c }, { onConflict: "owner_id,symbol" }).select("id").single();
    if (error) throw error;
    companyIds.set(c.symbol, data.id);
  }

  for (const v of plan.versions) {
    const { data: existing } = await db.from("research_versions").select("id")
      .eq("company_id", companyIds.get(v.symbol)!).eq("research_as_of", v.research_as_of).eq("source_document_id", docIds.get(v.docKey)!);
    if (existing?.length) { console.log(`  skip ${v.symbol} ${v.research_as_of}: already imported`); continue; }
    const { data, error } = await db.from("research_versions").insert({
      owner_id, company_id: companyIds.get(v.symbol)!, research_as_of: v.research_as_of, completeness: v.completeness, origin: v.origin,
      is_current: v.is_current, conclusion: v.conclusion, change_summary: v.change_summary, source_document_id: docIds.get(v.docKey)!,
    }).select("id").single();
    if (error) throw error;
    const rows = v.phases.map((p) => ({ owner_id, version_id: data.id, phase_number: p.phase_number, title: p.title, body_markdown: p.body_markdown,
      extraction: p.extraction, details: p.details ?? {}, source_document_id: docIds.get(p.docKey) ?? null }));
    if (rows.length) { const { error: pErr } = await db.from("research_phases").insert(rows); if (pErr) throw pErr; }
  }

  for (const d of plan.decisions) {
    const { data: existing } = await db.from("decisions").select("id").eq("kind", "historical").eq("symbol", d.symbol).eq("source_document_id", docIds.get(d.docKey)!);
    if (existing?.length) continue;
    const { error } = await db.from("decisions").insert({ owner_id, kind: "historical", symbol: d.symbol, decided_at: d.decided_at,
      recommendation: d.recommendation, user_action: null, source_document_id: docIds.get(d.docKey)! });
    if (error) throw error;
  }

  if (plan.policy) {
    const { data: existing } = await db.from("policies").select("id").eq("version", plan.policy.version);
    if (!existing?.length) {
      const { error } = await db.from("policies").insert({ owner_id, version: plan.policy.version, effective_from: plan.policy.effective_from,
        is_current: true, rules: plan.policy.rules, source_document_id: docIds.get(plan.policy.docKey)! });
      if (error) throw error;
    }
  }
  console.log("\nImport applied. Re-running is safe: existing rows are skipped.");
}
