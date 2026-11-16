import { describe, expect, it } from "vitest";
import { confirmBlock, dailyCapBlock } from "./start";

describe("today's safety limit for runs you start (2026-11-16)", () => {
  it("is null with room, and names the amounts once reached", () => {
    expect(dailyCapBlock({ answers: 5, total: 8 })).toBeNull();
    expect(dailyCapBlock({ answers: 15.67, total: 15.67 })).toMatch(/\$15\.67 spent today; limits \$15 for questions and research, \$20 in all/);
    expect(dailyCapBlock({ answers: 16, total: 16 }, false)).toBeNull();
    expect(dailyCapBlock({ answers: 1, total: 20 }, false)).not.toBeNull();
  });
  it("asks once, with every reason, and lets a confirmed run go ahead", () => {
    const daily = dailyCapBlock({ answers: 15.67, total: 15.67 });
    const gate = { ok: false as const, message: "This could take the 30-day test past its $25 AI ceiling." };
    expect(confirmBlock(daily, gate, false)).toMatch(/safety limit.*30-day test/);
    expect(confirmBlock(daily, { ok: true }, false)).toBe(daily);
    expect(confirmBlock(null, { ok: true }, false)).toBeNull();
    expect(confirmBlock(daily, gate, true)).toBeNull();
  });
});
