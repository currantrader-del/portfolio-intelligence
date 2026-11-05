/**
 * Decides where a request may go, from the session state alone.
 * Kept pure so it can be tested without Supabase.
 */
export type SessionState = { signedIn: boolean; aal: "aal1" | "aal2" | null };
export type GateResult = { kind: "allow" } | { kind: "redirect"; to: string };

const PUBLIC_PATHS = ["/login"];
const MFA_PATHS = ["/mfa"];

export function gate(pathname: string, s: SessionState): GateResult {
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const isMfa = MFA_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (!s.signedIn) return isPublic ? { kind: "allow" } : { kind: "redirect", to: "/login" };
  if (s.aal !== "aal2") return isMfa ? { kind: "allow" } : { kind: "redirect", to: "/mfa" };
  if (isPublic || isMfa) return { kind: "redirect", to: "/" };
  return { kind: "allow" };
}
