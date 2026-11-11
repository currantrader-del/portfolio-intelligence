import { describe, expect, it } from "vitest";
import { filingsToPush } from "./filingFilter";
import { parseRead } from "./filingRead";

const url = (acc: string) => `https://www.sec.gov/Archives/edgar/data/123/${acc}/doc.htm`;
const filing = (id: string, form: string, filed: string, acc: string) => ({ id, kind: "event", severity: "medium", title: id, detail: "", href: "/", timing: "recent", symbol: "AAA", source: { form, filed, url: url(acc) } }) as never;
const state = (o: Partial<{ covered: Map<string, string>; reviewed: Set<string>; offerings: Map<string, "debt" | "shares"> }> = {}) => ({ covered: new Map(), reviewed: new Set<string>(), offerings: new Map(), ...o }) as never;
const now = new Date("2026-11-10T14:32:00Z");

describe("filing pushes", () => {
  it("pushes a new, unread filing", () => {
    expect(filingsToPush([filing("a", "10-Q", "2026-11-09", "000000000000000001")], state(), now)).toHaveLength(1);
  });
  it("skips filings first seen days after filing (the Nov 10 batch from Nov 3-5)", () => {
    expect(filingsToPush([filing("a", "10-Q", "2026-11-05", "000000000000000001"), filing("b", "10-Q", "2026-11-03", "000000000000000002")], state(), now)).toHaveLength(0);
  });
  it("skips filings research already read, ones you marked reviewed, and debt offerings", () => {
    const xs = [filing("a", "10-Q", "2026-11-09", "000000000000000001"), filing("b", "8-K", "2026-11-09", "000000000000000002"), filing("c", "424B2", "2026-11-09", "000000000000000003")];
    const st = state({ covered: new Map([["000000000000000001", "your Nov 9 investigation"]]), reviewed: new Set(["000000000000000002"]), offerings: new Map([["000000000000000003", "debt"]]) });
    expect(filingsToPush(xs, st, now)).toHaveLength(0);
  });
  it("leaves non-filing alerts alone", () => {
    expect(filingsToPush([{ id: "x", kind: "event", severity: "medium", title: "", detail: "", href: "/", timing: "upcoming", symbol: "AAA" } as never], state(), now)).toHaveLength(1);
  });
});

describe("filing first read", () => {
  it("parses the two lines and whether it touches the thesis", () => {
    expect(parseRead("WHAT: Q3 revenue $57.0B, up 62%; guides Q4 $65B.\nTHESIS: Yes, data-centre growth is the thesis and it beat.")).toEqual({ what: "Q3 revenue $57.0B, up 62%; guides Q4 $65B.", thesis: "data-centre growth is the thesis and it beat.", touches: "yes" });
    expect(parseRead("WHAT: Annual meeting vote results.\nTHESIS: No: governance routine.")?.touches).toBe("no");
    expect(parseRead("Some text without the format")).toBeNull();
  });
});
