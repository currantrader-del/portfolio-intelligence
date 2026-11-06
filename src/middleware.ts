import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { gate } from "@/lib/auth-gate";

export async function middleware(request: NextRequest) {
  // Local design fixture only (synthetic data, never on in production builds).
  if (process.env.NODE_ENV !== "production" && process.env.PI_FIXTURE === "1") return NextResponse.next({ request });
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(toSet) {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getClaims verifies the session JWT locally (signing keys are cached), so most requests make
  // no round trip to Supabase Auth here. It falls back to a network check when it cannot verify locally.
  const { data: claimsData } = await supabase.auth.getClaims();
  const signedIn = !!claimsData?.claims?.sub;
  let aal: "aal1" | "aal2" | null = null;
  let mfaEnrolled = false;
  if (signedIn) {
    // Reads the session already in the cookie: no network call.
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    aal = (data?.currentLevel as "aal1" | "aal2" | null) ?? null;
    mfaEnrolled = data?.nextLevel === "aal2"; // a verified factor exists
  }

  const result = gate(request.nextUrl.pathname, { signedIn, aal, mfaEnrolled });
  if (result.kind === "redirect") {
    const to = request.nextUrl.clone();
    to.pathname = result.to;
    to.search = "";
    const redirect = NextResponse.redirect(to);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)$).*)"],
};
