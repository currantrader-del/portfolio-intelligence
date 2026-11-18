import { describe, expect, it } from "vitest";
import type { Alert } from "@/lib/alerts/rules";
import { alertKey, formatPush, newTopic, selectNew } from "./watch";

const a = (o: Partial<Alert>): Alert => ({ id: "x", severity: "medium", symbol: "ACME", kind: "big_move", title: "ACME -6.0% today", detail: "", href: "/", ...o });
const day = "2026-11-09";

describe("selectNew", () => {
  it("keeps high and medium decision alerts, drops low ones and staleness", () => {
    const out = selectNew([a({ id: "move:ACME" }), a({ id: "move:BETA", severity: "low" }), a({ id: "stale:ACME", kind: "research_stale", severity: "high" })], new Set(), day);
    expect(out.map((x) => x.alert.id)).toEqual(["move:ACME"]);
  });
  it("does not repeat what was already sent today, but does tomorrow", () => {
    const alert = a({ id: "move:ACME" });
    expect(selectNew([alert], new Set([alertKey(alert, day)]), day)).toEqual([]);
    expect(selectNew([alert], new Set([alertKey(alert, day)]), "2026-11-10")).toHaveLength(1);
  });
  it("sends a filing once ever and never an upcoming estimate", () => {
    const filed = a({ id: "event:ACME:0001", kind: "event", timing: "recent" });
    const upcoming = a({ id: "event:ACME:est", kind: "event", timing: "upcoming" });
    expect(selectNew([filed, upcoming], new Set(), day).map((x) => x.key)).toEqual(["event|event:ACME:0001"]);
    expect(selectNew([filed], new Set(["event|event:ACME:0001"]), "2026-12-01")).toEqual([]);
  });
});

describe("formatPush", () => {
  it("uses the one alert's title and the summary for a single alert", () => {
    const p = formatPush([a({ severity: "high" })], "Down on an offering; your thesis assumed none.");
    expect(p).toEqual({ title: "ACME -6.0% today", body: "Down on an offering; your thesis assumed none.", priority: "high" });
  });
  it("lists several alerts under a count", () => {
    const p = formatPush([a({}), a({ symbol: "BETA", title: "BETA filed an 8-K" })], null);
    expect(p.title).toBe("2 things need a look: ACME, BETA");
    expect(p.body).toBe("• ACME -6.0% today\n• BETA filed an 8-K");
    expect(p.priority).toBe("default");
  });
});

it("makes unguessable topic names", () => {
  expect(newTopic()).toMatch(/^pi-[a-z2-9]{20}$/);
  expect(newTopic()).not.toBe(newTopic());
});
