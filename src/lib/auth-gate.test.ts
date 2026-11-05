import { describe, expect, it } from "vitest";
import { gate } from "./auth-gate";

describe("auth gate", () => {
  it("sends signed-out users to login", () => {
    expect(gate("/", { signedIn: false, aal: null })).toEqual({ kind: "redirect", to: "/login" });
    expect(gate("/research", { signedIn: false, aal: null })).toEqual({ kind: "redirect", to: "/login" });
  });
  it("lets signed-out users see login", () => {
    expect(gate("/login", { signedIn: false, aal: null })).toEqual({ kind: "allow" });
  });
  it("requires two-factor before any app page", () => {
    expect(gate("/", { signedIn: true, aal: "aal1" })).toEqual({ kind: "redirect", to: "/mfa" });
    expect(gate("/mfa", { signedIn: true, aal: "aal1" })).toEqual({ kind: "allow" });
  });
  it("allows app pages with two-factor", () => {
    expect(gate("/portfolio", { signedIn: true, aal: "aal2" })).toEqual({ kind: "allow" });
  });
  it("moves fully signed-in users off login and mfa", () => {
    expect(gate("/login", { signedIn: true, aal: "aal2" })).toEqual({ kind: "redirect", to: "/" });
    expect(gate("/mfa", { signedIn: true, aal: "aal2" })).toEqual({ kind: "redirect", to: "/" });
  });
});
