import { describe, expect, it } from "vitest";
import { gate } from "./auth-gate";

const out = { signedIn: false, aal: null, mfaEnrolled: false } as const;
const pw = { signedIn: true, aal: "aal1", mfaEnrolled: false } as const;
const enrolledPw = { signedIn: true, aal: "aal1", mfaEnrolled: true } as const;
const enrolledFull = { signedIn: true, aal: "aal2", mfaEnrolled: true } as const;

describe("auth gate", () => {
  it("sends signed-out users to login", () => {
    expect(gate("/", out)).toEqual({ kind: "redirect", to: "/login" });
    expect(gate("/research", out)).toEqual({ kind: "redirect", to: "/login" });
  });
  it("lets signed-out users see login", () => {
    expect(gate("/login", out)).toEqual({ kind: "allow" });
  });
  it("allows a password session when no authenticator is enrolled", () => {
    expect(gate("/portfolio", pw)).toEqual({ kind: "allow" });
    expect(gate("/mfa", pw)).toEqual({ kind: "redirect", to: "/" });
  });
  it("requires the code once an authenticator is enrolled", () => {
    expect(gate("/", enrolledPw)).toEqual({ kind: "redirect", to: "/mfa" });
    expect(gate("/mfa", enrolledPw)).toEqual({ kind: "allow" });
    expect(gate("/portfolio", enrolledFull)).toEqual({ kind: "allow" });
  });
  it("moves fully signed-in users off login", () => {
    expect(gate("/login", pw)).toEqual({ kind: "redirect", to: "/" });
    expect(gate("/login", enrolledFull)).toEqual({ kind: "redirect", to: "/" });
  });
});
