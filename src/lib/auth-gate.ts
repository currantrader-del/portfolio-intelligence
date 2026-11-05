/**
 * Decides where a request may go, from the session state alone.
 * Kept pure so it can be tested without Supabase.
 *
 * Two-factor is optional: password sign-in is enough until the owner enrolls an
 * authenticator app. Once a factor is enrolled, every session must verify it (aal2).
 */
export type SessionState = { signedIn: boolean; aal: "aal1" | "aal2" | null; mfaEnrolled: boolean };
export type GateResult = { kind: "allow" } | { kind: "redirect"; to: string };

const PUBLIC_PATHS = ["/login"];
const MFA_PATHS = ["/mfa"];

const under = (pathname: string, paths: string[]) => paths.some((p) => pathname === p || pathname.startsWith(p + "/"));

export function gate(pathname: string, s: SessionState): GateResult {
  const isPublic = under(pathname, PUBLIC_PATHS);
  const isMfa = under(pathname, MFA_PATHS);

  if (!s.signedIn) return isPublic ? { kind: "allow" } : { kind: "redirect", to: "/login" };
  const needsMfa = s.mfaEnrolled && s.aal !== "aal2";
  if (needsMfa) return isMfa ? { kind: "allow" } : { kind: "redirect", to: "/mfa" };
  if (isPublic || isMfa) return { kind: "redirect", to: "/" };
  return { kind: "allow" };
}
