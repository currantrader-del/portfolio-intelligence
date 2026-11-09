/**
 * GET /api/research/<SYMBOL>/share?version=latest|approved -> the full investigation as a PDF, with the
 * owner's private financial information removed. Read-only: no research is re-run and no AI is called.
 */
import { createClient } from "@/lib/supabase/server";
import { loadShareReport } from "@/lib/research/share/load";
import { renderSharePdf } from "@/lib/research/share/pdf";
import { ShareLeakError } from "@/lib/research/share/report";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: raw } = await params;
  const symbol = decodeURIComponent(raw).toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
  const choice = new URL(req.url).searchParams.get("version") === "approved" ? "approved" : "latest";
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return new Response("Sign in first.", { status: 401 });
  try {
    const res = await loadShareReport(db, symbol, choice);
    if ("error" in res) return new Response(res.error, { status: res.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    const pdf = await renderSharePdf(res.report);
    const date = res.report.facts.find((f) => f[0] === "Research date")?.[1] ?? "";
    const iso = /\d{4}/.test(date) ? new Date(`${date} UTC`).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${symbol}-research-${iso}.pdf"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof ShareLeakError) {
      // Never send a report that still looks private. Log only the reasons, not the text.
      console.error("share: blocked export", symbol, e.leaks.map((l) => l.split(":")[0]));
      return new Response(`The export was stopped because ${e.leaks.length} passage${e.leaks.length === 1 ? "" : "s"} still looked like private portfolio information after redaction. Nothing was shared.`, { status: 422, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    console.error("share: failed", symbol, (e as Error).message);
    return new Response("Could not build the PDF.", { status: 500 });
  }
}
