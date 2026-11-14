import { describe, expect, it } from "vitest";
import { headlineTiming, nyClose, sessionOfQuotes } from "./hours";

describe("one session per brief (audit 2026-11-11)", () => {
  it("names the session from the quotes, with its close", () => {
    const s = sessionOfQuotes(["2026-11-11T20:59:00Z", "2026-11-11T21:00:00Z"], new Date("2026-11-12T02:00:00Z"))!;
    expect(s.date).toBe("2026-11-11");
    expect(s.open).toBe(false);
    expect(s.closeIso).toBe("2026-11-11T21:00:00.000Z"); // 4 PM EST
    expect(nyClose("2026-07-01").toISOString()).toBe("2026-07-01T20:00:00.000Z"); // 4 PM EDT
  });
  it("labels a headline published after the move instead of attributing the move to it", () => {
    const w = { start: "2026-11-10T21:00:00Z", end: "2026-11-11T21:00:00Z" };
    expect(headlineTiming("2026-11-12T01:00:00Z", w.start, w.end)).toBe("after");
    expect(headlineTiming("2026-11-11T15:00:00Z", w.start, w.end)).toBe("during");
    expect(headlineTiming("2026-11-09T15:00:00Z", w.start, w.end)).toBe("before");
    expect(headlineTiming(null, w.start, w.end)).toBe("unknown");
  });
});
