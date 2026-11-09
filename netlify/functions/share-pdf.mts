/**
 * GET /api/share-pdf/<SYMBOL>?version=latest|approved[&format=json] -> the full investigation (as JSON for
 * the browser to draw, or as a PDF for short reports), with the
 * owner's private financial information removed. Read-only: no research is re-run and no AI is called.
 *
 * Runs as its own Netlify function, outside the Next.js server, on purpose: bundling the PDF engine
 * and its fonts into the Next.js server (PR #36) broke every page of the live site. Here a problem
 * with the PDF engine can only ever affect this one download.
 */
import { createServerClient, parseCookieHeader } from "@supabase/ssr";

const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export default async (req: Request) => {
  try {
    return await handle(req);
  } catch (e) {
    // Show what failed instead of Netlify's generic crash page (no portfolio data is in these messages).
    const err = e as Error;
    console.error("share: crashed", err);
    return text(`Could not build the PDF.\n\n${err?.name ?? "Error"}: ${err?.message ?? String(e)}\n${(err?.stack ?? "").split("\n").slice(1, 6).join("\n")}`, 500);
  }
};

async function handle(req: Request): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return text("The app is not configured.", 500);

  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const symbol = decodeURIComponent(parts[parts.length - 1] ?? "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
  if (!symbol) return text("No company given.", 400);
  const choice = new URL(req.url).searchParams.get("version") === "approved" ? "approved" : "latest";

  // The signed-in session from the browser's cookies; row-level security applies to every read.
  const db = createServerClient(url, key, {
    cookies: {
      getAll: () => parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value ?? "" })),
      setAll: () => {}, // read-only: the app's middleware refreshes sessions
    },
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return text("Sign in first.", 401);
  const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") return text("Finish two-step sign-in first.", 401);

  // Loaded here, not at the top, so a problem loading the PDF engine is caught and shown above.
  const [{ loadShareReport }, { ShareLeakError }] = await Promise.all([
    import("../../src/lib/research/share/load"),
    import("../../src/lib/research/share/report"),
  ]);
  try {
    const res = await loadShareReport(db, symbol, choice);
    if ("error" in res) return text(res.error, res.status);
    // The app asks for the redacted report and draws the PDF in the browser: drawing a long report
    // here took longer than Netlify lets a request run.
    if (new URL(req.url).searchParams.get("format") === "json") {
      return new Response(JSON.stringify(res.report), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
    }
    const { renderSharePdf } = await import("../../src/lib/research/share/pdf");
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
      return text(`The export was stopped because ${e.leaks.length} passage${e.leaks.length === 1 ? "" : "s"} still looked like private portfolio information after redaction. Nothing was shared.`, 422);
    }
    console.error("share: failed", symbol, (e as Error).message);
    throw e;
  }
}

export const config = { path: "/api/share-pdf/:symbol" };
