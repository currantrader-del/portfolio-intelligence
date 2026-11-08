/** Models used by the investigation, their list prices (US$ per million tokens) and cost accounting. */
import type Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "./types";

export const INV_MODELS = {
  reader: { id: "claude-haiku-5-5", effort: "medium" as const },
  analyst: { id: "claude-sonnet-5-5", effort: "medium" as const },
  analystHigh: { id: "claude-sonnet-5-5", effort: "high" as const },
  skeptic: { id: "claude-opus-5-5", effort: "high" as const },
};
const PRICE: Record<string, { in: number; out: number; longIn?: number; longOut?: number; longAbove?: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5, longIn: 0.5, longOut: 2.5, longAbove: 100_000 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
};
export const PER_SEARCH = 0.01;

export function priceFor(model: string) {
  const key = Object.keys(PRICE).find((k) => model.startsWith(k)) ?? "claude-sonnet-5-5";
  return { key, ...PRICE[key] };
}

/** Cost of one response, from its usage block. */
export function usageOf(model: string, u: Anthropic.Beta.BetaUsage, ms: number): Usage {
  const p = priceFor(model);
  const input = u.input_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0, output = u.output_tokens ?? 0;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  const long = p.longAbove !== undefined && input + cacheRead + cacheWrite > p.longAbove;
  const pin = long ? p.longIn! : p.in, pout = long ? p.longOut! : p.out;
  const cost = (input * pin + cacheRead * pin * 0.1 + cacheWrite * pin * 1.25 + output * pout) / 1e6 + searches * PER_SEARCH;
  return { calls: 1, input, cacheRead, cacheWrite, output, searches, costUsd: Math.round(cost * 10000) / 10000, ms, byModel: { [p.key]: { calls: 1, costUsd: Math.round(cost * 10000) / 10000 } } };
}
