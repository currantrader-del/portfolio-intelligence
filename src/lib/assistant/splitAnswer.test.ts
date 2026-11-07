import { describe, expect, it } from "vitest";
import { splitAnswer } from "./splitAnswer";

describe("splitAnswer", () => {
  it("keeps the lead and collapses the sections after the first heading", () => {
    const r = splitAnswer("Hold cash for now.\n\nNothing passes the gates.\n\n## Reasoning\n\nDetails here.\n\n## Evidence\n\nMore.");
    expect(r.summary).toBe("Hold cash for now.\n\nNothing passes the gates.");
    expect(r.rest).toBe("## Reasoning\n\nDetails here.\n\n## Evidence\n\nMore.");
  });
  it("caps a long lead", () => {
    const long = "A".repeat(600);
    const r = splitAnswer(`${long}\n\n${"B".repeat(300)}\n\nC`);
    expect(r.summary).toBe(long);
    expect(r.rest.startsWith("B")).toBe(true);
  });
  it("skips a leading title", () => {
    const r = splitAnswer("# Morning briefing\n\nQuiet day.\n\n## Markets\n\nUp.");
    expect(r.summary).toBe("Quiet day.");
    expect(r.rest).toBe("## Markets\n\nUp.");
  });
  it("returns no rest for a short answer", () => expect(splitAnswer("Just this.")).toEqual({ summary: "Just this.", rest: "" }));
});
