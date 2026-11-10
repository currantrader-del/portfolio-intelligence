import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { READ_PATHS, connectionOf, schwabGet, seal, unseal } from "./client";
import { mapAccounts } from "./sync";
import { needsReminder } from "./morning";

beforeAll(() => { process.env.SCHWAB_APP_KEY = "test-key"; process.env.SCHWAB_APP_SECRET = "test-secret-only-for-tests"; });

describe("read-only by construction", () => {
  it("allows only the read paths, and blocks orders and anything else before any network call", async () => {
    const ok = ["/trader/v1/accounts?fields=positions", "/trader/v1/accounts", "/trader/v1/accounts/accountNumbers", "/marketdata/v1/quotes?symbols=VOO"];
    for (const p of ok) expect(READ_PATHS.some((re) => re.test(p))).toBe(true);
    for (const p of ["/trader/v1/accounts/ABC/orders", "/trader/v1/orders", "/trader/v1/accounts/ABC/previewOrder", "/trader/v1/userPreference"]) {
      await expect(schwabGet({} as never, p)).rejects.toThrow(/Blocked/);
    }
  });
  it("has no order code anywhere in the Schwab folder", () => {
    const dir = __dirname;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/\/orders|previewOrder|method:\s*"(PUT|DELETE|PATCH)"/);
      // The only POST is the sign-in token request.
      expect((src.match(/method:\s*"POST"/g) ?? []).length, f).toBe(f === "client.ts" ? 1 : 0);
    }
  });
});

describe("tokens", () => {
  it("are stored encrypted and read back", () => {
    const s = seal({ access: "acc-123", refresh: "ref-456", accessExpiresAt: "2026-11-10T17:00:00Z", refreshIssuedAt: "2026-11-10T16:30:00Z" });
    expect(JSON.stringify(s)).not.toMatch(/acc-123|ref-456/);
    expect(unseal(s)).toMatchObject({ access: "acc-123", refresh: "ref-456" });
    expect(() => unseal({ ...s, data: Buffer.from("tampered").toString("base64") })).toThrow();
  });
  it("count the 7-day sign-in", () => {
    const c = connectionOf({ refreshIssuedAt: "2026-11-10T16:00:00Z" }, new Date("2026-11-16T16:00:00Z"));
    expect(c).toMatchObject({ connected: true, daysLeft: 1 });
    expect(needsReminder(c.daysLeft, true)).toBe(true);
    expect(connectionOf({ refreshIssuedAt: "2026-11-10T16:00:00Z" }, new Date("2026-11-17T16:01:00Z")).connected).toBe(false);
    expect(needsReminder(3, true)).toBe(false);
  });
});

describe("mapping Schwab accounts", () => {
  it("keeps long positions with cost, counts cash equivalents as cash, skips shorts, keeps only the last 4 digits", () => {
    const m = mapAccounts([{ securitiesAccount: {
      accountNumber: "11112222", currentBalances: { cashBalance: 100.5, liquidationValue: 5000 },
      positions: [
        { longQuantity: 10, averagePrice: 80, marketValue: 1000, instrument: { symbol: "AAA", assetType: "EQUITY" } },
        { longQuantity: 50, marketValue: 50, instrument: { symbol: "MMF", assetType: "CASH_EQUIVALENT" } },
        { shortQuantity: 5, marketValue: -200, instrument: { symbol: "BBB", assetType: "EQUITY" } },
        { longQuantity: 1, marketValue: 300, instrument: { symbol: "CCC  270115C00100000", assetType: "OPTION" } },
      ],
    } }]);
    expect(m).toEqual([{ last4: "2222", total: 5000, cash: 150.5, skipped: ["BBB (short position)"], positions: [
      { symbol: "AAA", quantity: 10, price: 100, marketValue: 1000, costBasis: 800 },
      { symbol: "CCC270115C00100000", quantity: 1, price: 300, marketValue: 300, costBasis: null },
    ] }]);
    expect(JSON.stringify(m)).not.toMatch(/11112222/);
    expect(mapAccounts({ error: "x" })).toEqual([]);
  });
});
