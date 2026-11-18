/**
 * Analyst reports as stored records (model_runs, insert-only):
 *   analyst_request -> analyst_report (what the report says, compared with the research in use, and the cost)
 * The PDF itself is in private storage ("originals" bucket) with a source_documents row; it never leaves the app
 * except to the AI that reads it once.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchJob, save } from "@/lib/intel/jobs";
import { extractJson } from "@/lib/research/aiResearch";
import { getQuote } from "@/lib/market/quotes";
import { buildWorkspace } from "@/lib/workspace-core";
import { ANALYST_SYSTEM, ANALYST_VERSION, parseReport, researchFacts, type AnalystReport } from "./report";

const MODEL = { id: "claude-sonnet-5-5", inPerM: 2, outPerM: 10 };
export const ANALYST_RUNNING_MIN = 10;

export type StoredAnalyst = { ok: true; report: AnalystReport } | { ok: false; error: string; symbol: string; fileName: string; costUsd: number; at: string; stopReason?: string | null; replyChars?: number; outputTokens?: number };

export async function startAnalyst(db: SupabaseClient, origin: string, token: string, r: { symbol: string; documentId: string; storagePath: string; fileName: string }): Promise<string> {
  const requestId = await save(db, "analyst_request", ANALYST_VERSION, { symbol: r.symbol, document_id: r.documentId, storage_path: r.storagePath, file_name: r.fileName }, {});
  await dispatchJob(origin, { job: "analyst", requestId, token });
  return requestId;
}

export async function runAnalystJob(db: SupabaseClient, requestId: string): Promise<string> {
  const { data: req } = await db.from("model_runs").select("inputs").eq("id", requestId).eq("kind", "analyst_request").maybeSingle();
  if (!req) throw new Error("Unknown analyst request");
  const i = req.inputs as { symbol: string; document_id: string; storage_path: string; file_name: string };
  const now = new Date();
  const store = (o: StoredAnalyst, cost: number) => save(db, "analyst_report", ANALYST_VERSION, { request_id: requestId, symbol: i.symbol, document_id: i.document_id }, { ...o, costUsd: cost });
  try {
    const file = await db.storage.from("originals").download(i.storage_path);
    if (file.error || !file.data) throw new Error(`The PDF could not be read from storage${file.error ? `: ${file.error.message}` : ""}`);
    const data = Buffer.from(await file.data.arrayBuffer()).toString("base64");
    const ws = await buildWorkspace(db, now);
    const rec = ws.research.find((r) => r.symbol === i.symbol);
    const q = await getQuote(i.symbol).catch(() => null);
    const facts = researchFacts(i.symbol, rec?.current?.parsed ?? null, rec?.current?.research_as_of ?? null, q?.price ?? null);
    const res = await new Anthropic().messages.create({
      model: MODEL.id, max_tokens: 12000, system: ANALYST_SYSTEM,
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
        { type: "text", text: `The investor uploaded this report for ${i.symbol}.\n\nTHE APP'S RESEARCH (for the comparison)\n${facts}\n\nRead the report and reply with the JSON.` },
      ] }],
    });
    const cost = (res.usage.input_tokens * MODEL.inPerM + res.usage.output_tokens * MODEL.outPerM) / 1e6;
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const report = parseReport(extractJson(text), { symbol: i.symbol, fileName: i.file_name, documentId: i.document_id, costUsd: cost, model: MODEL.id, now });
    if (!report) {
      // Say why, and what it cost: a reply cut off at the length limit is the app's fault, not the file's.
      const cut = res.stop_reason === "max_tokens";
      const why = cut
        ? `The AI's reply was cut off before it finished (the report has more figures than the reader allowed), so nothing was saved. This was the app's limit, not your file. Charged $${cost.toFixed(2)}.`
        : `The report could not be read into ratings, values or estimates. Is it an analyst report, and not a scan? Charged $${cost.toFixed(2)}.`;
      return store({ ok: false, error: why, symbol: i.symbol, fileName: i.file_name, costUsd: cost, at: now.toISOString(), stopReason: res.stop_reason ?? null, replyChars: text.length, outputTokens: res.usage.output_tokens } as StoredAnalyst, cost);
    }
    // A report about another company is kept under the company it is about.
    return store({ ok: true, report }, cost);
  } catch (e) {
    return store({ ok: false, error: (e as Error).message.slice(0, 300), symbol: i.symbol, fileName: i.file_name, costUsd: 0, at: now.toISOString() }, 0);
  }
}

/** Reports for one company, newest report date first, plus whether one is being read now. */
export async function loadAnalyst(db: SupabaseClient, symbol: string) {
  const [{ data: rows }, { data: reqs }] = await Promise.all([
    db.from("model_runs").select("id, computed_at, inputs, outputs").eq("kind", "analyst_report").limit(200),
    db.from("model_runs").select("id, computed_at").eq("kind", "analyst_request").eq("inputs->>symbol", symbol).order("computed_at", { ascending: false }).limit(5),
  ]);
  const all = (rows ?? []) as { id: string; computed_at: string; inputs: { request_id?: string; symbol?: string }; outputs: StoredAnalyst }[];
  const done = new Set(all.map((r) => r.inputs.request_id));
  const mine = all.filter((r) => (r.outputs.ok ? r.outputs.report.symbol : r.outputs.symbol) === symbol || r.inputs.symbol === symbol);
  const reports = mine.flatMap((r) => (r.outputs.ok ? [{ ...r.outputs.report, id: r.id }] : [])).sort((a, b) => (b.reportDate ?? b.at).localeCompare(a.reportDate ?? a.at));
  // A failed read stops showing once a later upload for the company was read (it was usually a retry of the same report).
  const lastOk = Math.max(0, ...reports.map((x) => Date.parse(x.at)).filter(Number.isFinite));
  const failed = mine.flatMap((r) => (!r.outputs.ok ? [{ id: r.id, ...r.outputs }] : [])).filter((f) => Date.parse(f.at) > Date.now() - 3 * 86_400_000 && Date.parse(f.at) > lastOk);
  const running = ((reqs ?? []) as { id: string; computed_at: string }[]).some((r) => !done.has(r.id) && Date.now() - Date.parse(r.computed_at) < ANALYST_RUNNING_MIN * 60_000);
  return { reports, failed, running };
}
