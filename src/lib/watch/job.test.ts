import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert } from "@/lib/alerts/rules";

const saved: { kind: string; outputs: unknown }[] = [];
let alerts: Alert[] = [];
vi.mock("@/lib/workspace-core", () => ({ buildWorkspace: async () => ({ alerts, research: [], portfolio: { holdings: [{ symbol: "ACME" }] } }) }));
vi.mock("@/lib/alerts/events", () => ({ loadEventAlerts: async () => ({ alerts: [] }) }));
vi.mock("@/lib/market/quotes", () => ({ getQuotes: async () => new Map() }));
vi.mock("@/lib/intel/start", () => ({ DAILY_CAP: { total: 5 }, spentToday: async () => ({ total: 99 }) }));
vi.mock("@/lib/intel/jobs", () => ({ save: async (_db: unknown, kind: string, _v: string, _i: unknown, outputs: unknown) => { saved.push({ kind, outputs }); return "id"; } }));

/** A db stand-in that returns the saved settings and runs. */
const db = {
  from: () => {
    let kind = "";
    const q = {
      select: () => q, gte: () => q, order: () => q, limit: () => q,
      eq: (_k: string, v: string) => { kind = v; return q; },
      maybeSingle: () => Promise.resolve({ data: kind === "watch_settings" ? { outputs: { topic: "pi-test", enabled: true } } : null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: saved.filter((s) => s.kind === kind).reverse().map((s) => ({ id: "r", outputs: s.outputs })) }).then(ok),
    };
    return q;
  },
} as never;

const open = new Date("2026-11-09T16:00:00Z"); // Monday 11:00 ET
const move: Alert = { id: "move:ACME", severity: "high", symbol: "ACME", kind: "big_move", title: "ACME -9.0% today", detail: "", href: "/decisions/review/ACME" };

describe("runWatch", () => {
  beforeEach(() => { saved.length = 0; alerts = [move]; });

  it("pushes a new alert once, then stays quiet", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { runWatch } = await import("./job");
    const first = await runWatch(db, "https://app.test", { now: open });
    expect("sent" in first && first.sent.map((s) => s.alert.id)).toEqual(["move:ACME"]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ topic: "pi-test", title: "ACME -9.0% today", priority: 4, click: "https://app.test/decisions/review/ACME" });
    const second = await runWatch(db, "https://app.test", { now: new Date(open.getTime() + 30 * 60000) });
    expect("sent" in second && second.sent).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries again next time when the push failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const { runWatch } = await import("./job");
    const first = await runWatch(db, "https://app.test", { now: open });
    expect("error" in first && first.error).toMatch(/500/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const second = await runWatch(db, "https://app.test", { now: new Date(open.getTime() + 30 * 60000) });
    expect("pushed" in second && second.pushed).toBe(true);
  });

  it("does nothing when the market is closed unless forced", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const { runWatch } = await import("./job");
    expect(await runWatch(db, "x", { now: new Date("2026-11-08T16:00:00Z") })).toEqual({ skipped: "market closed" });
    expect(await runWatch(db, "x", { now: new Date("2026-11-08T16:00:00Z"), force: true })).toHaveProperty("pushed", true);
  });
});
