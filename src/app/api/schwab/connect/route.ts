/** Starts the Schwab sign-in: a one-time state in a short-lived cookie, then Schwab's own sign-in page. */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authorizeUrl, configured } from "@/lib/schwab/client";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  if (!configured()) return NextResponse.redirect(`${origin}/portfolio?schwab=not_configured`);
  const db = await createClient();
  const { data } = await db.auth.getUser();
  if (!data.user) return NextResponse.redirect(`${origin}/login`);
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(authorizeUrl(`${origin}/api/schwab/callback`, state));
  res.cookies.set("schwab_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/schwab", maxAge: 600 });
  return res;
}
