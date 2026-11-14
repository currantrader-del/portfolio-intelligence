/**
 * Analyst reports (src/lib/analyst).
 *   POST {symbol, path, fileName, sha256, size, confirm?} -> after the browser has put the PDF in private storage:
 *        records it as a source document and starts the AI read: {requestId}
 */
import { loadSpend, manualGate } from "@/lib/costs/spend";
import { createClient } from "@/lib/supabase/server";
import { DAILY_CAP, spentToday } from "@/lib/intel/start";
import { startAnalyst } from "@/lib/analyst/job";
import { MAX_PDF_BYTES } from "@/lib/analyst/report";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The AI is not configured yet: add ANTHROPIC_API_KEY in Netlify environment variables." }, { status: 503 });
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  const { data: s } = await db.auth.getSession();
  if (!auth.user || !s.session?.access_token) return Response.json({ error: "Sign in first." }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { symbol?: string; path?: string; fileName?: string; sha256?: string; size?: number; confirm?: boolean };
  const symbol = (b.symbol ?? "").trim().toUpperCase();
  const sha = (b.sha256 ?? "").toLowerCase();
  const fileName = (b.fileName ?? "report.pdf").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || !/^[0-9a-f]{64}$/.test(sha)) return Response.json({ error: "Something was missing; choose the file again." }, { status: 400 });
  // The path must be the signed-in user's own folder, as the browser wrote it.
  const path = `${auth.user.id}/${sha}/${fileName}`;
  if (b.path !== path) return Response.json({ error: "The upload path did not match; choose the file again." }, { status: 400 });
  if (!(Number(b.size) > 0 && Number(b.size) <= MAX_PDF_BYTES)) return Response.json({ error: "The PDF must be under 20 MB." }, { status: 400 });
  const spent = await spentToday(db);
  if (spent.total >= DAILY_CAP.total) return Response.json({ error: `Today's cost limit is reached ($${spent.total.toFixed(2)} spent). It resets at midnight UTC.` }, { status: 429 });
  const gate = manualGate(await loadSpend(db), "analyst_report", b.confirm === true);
  if (!gate.ok) return Response.json({ error: gate.message, needsConfirm: gate.needsConfirm }, { status: 409 });
  const doc = await db.from("source_documents")
    .upsert({ owner_id: auth.user.id, file_name: fileName, sha256: sha, byte_size: Number(b.size), storage_path: path, origin: "manual", description: `Analyst report for ${symbol} (licensed to you; private)` }, { onConflict: "owner_id,sha256" })
    .select("id").single();
  if (doc.error) return Response.json({ error: `Could not record the file: ${doc.error.message}` }, { status: 500 });
  try {
    const requestId = await startAnalyst(db, new URL(req.url).origin, s.session.access_token, { symbol, documentId: doc.data.id, storagePath: path, fileName });
    return Response.json({ requestId });
  } catch (e) {
    return Response.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
