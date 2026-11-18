import { afterEach, describe, expect, it, vi } from "vitest";

describe("design fixture switch", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it("can never turn on in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PI_FIXTURE", "1");
    const { FIXTURE } = await import("./fixture");
    expect(FIXTURE).toBe(false);
  });
  it("is off unless asked for", async () => {
    vi.stubEnv("PI_FIXTURE", "");
    const { FIXTURE } = await import("./fixture");
    expect(FIXTURE).toBe(false);
  });
});
