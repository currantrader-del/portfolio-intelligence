import { describe, expect, it } from "vitest";
import { ageLabel, freshness, tradingDaysBetween } from "./index";

const now = new Date("2026-11-05T16:02:00Z"); // Thu 11:02 ET

describe("quote freshness", () => {
  it("is live within 2 minutes in market hours", () => {
    expect(freshness("quote", new Date("2026-11-05T16:01:00Z"), now, { marketOpen: true })).toBe("live");
  });
  it("is delayed up to 15 minutes", () => {
    expect(freshness("quote", new Date("2026-11-05T15:50:00Z"), now, { marketOpen: true })).toBe("delayed");
  });
  it("is stale after 15 minutes", () => {
    expect(freshness("quote", new Date("2026-11-05T15:40:00Z"), now, { marketOpen: true })).toBe("stale");
  });
  it("treats the last close as current when the market is shut", () => {
    expect(freshness("quote", new Date("2026-11-04T21:00:00Z"), now, { marketOpen: false })).toBe("live");
  });
  it("is missing with no timestamp", () => {
    expect(freshness("quote", null, now)).toBe("missing");
  });
});

describe("holdings freshness", () => {
  it("Sep 21 holdings are stale on Nov 5", () => {
    expect(freshness("holdings", new Date("2026-09-21T20:00:00Z"), now)).toBe("stale");
  });
  it("yesterday's sync is still live", () => {
    expect(freshness("holdings", new Date("2026-11-04T14:00:00Z"), now)).toBe("live");
  });
  it("Friday's sync is live on Monday", () => {
    expect(freshness("holdings", new Date("2026-10-30T14:00:00Z"), new Date("2026-11-02T15:00:00Z"))).toBe("live");
  });
});

describe("research freshness", () => {
  it("AAA Sep 10 research is live within 120 days", () => {
    expect(freshness("research", new Date("2026-09-10T00:00:00Z"), now)).toBe("live");
  });
  it("is stale after 120 days", () => {
    expect(freshness("research", new Date("2026-06-01T00:00:00Z"), now)).toBe("stale");
  });
});

describe("helpers", () => {
  it("counts weekdays only", () => {
    expect(tradingDaysBetween(new Date("2026-10-30T12:00:00Z"), new Date("2026-11-02T12:00:00Z"))).toBe(1);
  });
  it("labels age", () => {
    expect(ageLabel(new Date("2026-09-21T20:00:00Z"), now)).toBe("44 days old");
    expect(ageLabel(null, now)).toBe("no data");
  });
});
