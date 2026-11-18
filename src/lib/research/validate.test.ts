import { describe, expect, it } from "vitest";
import { classifySource, validateInvestigation } from "./validate";
import { transcriptGap } from "./investigate/run";
import type { InvDoc, Review } from "./investigate/types";
import { IREN_NOV8_FINDINGS, IREN_NOV8_INVENTORY, IREN_NOV8_LOG, IREN_NOV8_REVIEWS, IREN_NOV8_VALUATION, IREN_PRIOR } from "./__fixtures__/irenNov8";

const run = (over: Partial<Parameters<typeof validateInvestigation>[0]> = {}) => validateInvestigation({
  symbol: "IREN", valuation: IREN_NOV8_VALUATION, price: 21.64, today: "2026-11-08", findings: IREN_NOV8_FINDINGS, inventory: IREN_NOV8_INVENTORY,
  reviews: IREN_NOV8_REVIEWS, log: IREN_NOV8_LOG, prior: IREN_PRIOR, now: new Date("2026-11-08T23:00:00Z"), ...over,
});

describe("validating the saved Nov 8 IREN investigation without re-running it", () => {
  const r = run();
  const c = (k: string) => r.checks.find((x) => x.key === k)!;

  it("recomputes the valuation and matches the saved $18.38", () => {
    expect(c("arithmetic").status).toBe("pass");
    expect(c("arithmetic").detail).toMatch(/weighted \$18\.38/);
  });

  it("documents: proxy and slides were re-read after cut-off notes; transcript Q&A captured", () => {
    expect(c("documents").status).toBe("pass");
    expect(c("documents").detail).toMatch(/cut off at first for D12 and D21; each was read again/);
    expect(c("transcript")).toMatchObject({ status: "pass" });
    expect(c("transcript").detail).toMatch(/8 analyst questions/);
  });

  it("flags the weak spots: secondary sources behind inputs, an unconfirmed quote, and estimate-driven sensitivity", () => {
    expect(c("weak_cites").detail).toMatch(/F38 \(secondary_unverifiable\)/);
    expect(c("findings").detail).toMatch(/^F43:/);
    expect(c("sensitivity").status).toBe("warn");
    expect(r.verdict).toBe("passes_with_caveats");
  });

  it("bridges September's $68 and the Nov 7 screen's value to $18.38", () => {
    const sep = r.bridges[0];
    expect(sep.title).toMatch(/\$68\.03\) to now \(\$18\.38\)/);
    expect(sep.steps.at(-1)!.to).toBe(18.38);
    const nov7 = r.bridges[1];
    expect(nov7.steps.some((s) => /base net debt \$15B → \$22\.5B/.test(s.label))).toBe(true);
  });

  it("fails when the transcript Q&A is missing or a required document was not read", () => {
    const noQa = run({ reviews: IREN_NOV8_REVIEWS.map((x) => ({ ...x, qa: [] })) });
    expect(noQa.checks.find((x) => x.key === "transcript")!.status).toBe("fail");
    expect(noQa.verdict).toBe("does_not_pass");
    const unread = run({ inventory: IREN_NOV8_INVENTORY.map((d) => (d.id === "D12" ? { ...d, status: "partially_reviewed" } : d)) });
    expect(unread.checks.find((x) => x.key === "documents")!.detail).toMatch(/not read: D12/);
  });

  it("reads input sources", () => {
    expect(classifySource("F10")).toEqual({ kind: "finding", cites: ["F10"] });
    expect(classifySource("estimate: x (F8, F14) and F8")).toEqual({ kind: "estimate", cites: ["F8", "F14"] });
  });
});

describe("earnings-call Q&A is part of the standard", () => {
  const t = { id: "D9", kind: "transcript", status: "unavailable", unavailable_reason: "No transcript found on the company site or free transcript sources" } as unknown as InvDoc;
  it("discloses a missing transcript instead of reading as complete", () => {
    expect(transcriptGap({ inventory: [t], reviews: [] })[0]).toMatch(/^Earnings-call Q&A not reviewed: no transcript was available \(No transcript found/);
    expect(transcriptGap({ inventory: [], reviews: [] })[0]).toMatch(/no transcript was listed/);
  });
  it("says nothing when the Q&A was captured", () => {
    expect(transcriptGap({ inventory: [{ ...t, status: "fully_reviewed" }], reviews: [{ docId: "D9", qa: [{ question: "q", answer: "a" }] } as unknown as Review] })).toEqual([]);
  });
});
