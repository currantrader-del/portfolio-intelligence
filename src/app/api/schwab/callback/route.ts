/** Schwab sends you back here after sign-in. Checks the state, stores the tokens (encrypted), then syncs once. */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { exchangeCode } from "@/lib/schwab/client";
import { syncSchwab } from "@/lib/schwab/sync";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (s: string) => NextResponse.redirect(`${url.origin}/portfolio?schwab=${s}`);
  const jar = await cookies();
  const expected = jar.get("schwab_state")?.value;
  const code = url.searchParams.get("code");
  if (!code || !expected || url.searchParams.get("state") !== expected) return back("state_mismatch");
  const db = await createClient();
  const { data } = await db.auth.getUser();
  if (!data.user) return NextResponse.redirect(`${url.origin}/login`);
  try {
    await exchangeCode(db, code, `${url.origin}/api/schwab/callback`);
  } catch (e) {
    console.error(`schwab callback: ${(e as Error).message}`);
    return back("signin_failed");
  }
  const r = await syncSchwab(db).catch(() => null);
  const res = back(r?.ok ? "connected" : "connected_sync_failed");
  res.cookies.delete({ name: "schwab_state", path: "/api/schwab" });
  return res;
}
