/**
 * How complete a briefing's inputs are, and whether each outlook may be issued. Pure and tested.
 * An outlook is withheld when an input it requires is unavailable, and labelled partial when a
 * required input is only partly complete. Nothing here judges markets; it only counts evidence.
 */
import type { DeskKey, DeskResult } from "./desks";
import type { Snapshot } from "./snapshot";
import { INSTRUMENTS, MACRO } from "./instruments";

export type Level = "complete" | "partial" | "unavailable";
export type InputKey = "market_data" | "macro_data" | DeskKey;
export type InputStatus = { key: InputKey; label: string; level: Level; detail: string; reusedFrom: string | null };
export type OutlookGate = { status: "issued" | "partial" | "withheld"; reasons: string[] };
export type Coverage = {
  inputs: InputStatus[];
  shortTerm: OutlookGate;
  longTerm: OutlookGate;
  sources: { cited: number; returnedBySearch: number; checkedOnPage: number; matched: number; partial: number; notFound: number; unreachable: number };
  calendar: { total: number; confirmed: number; estimated: number };
};

const LABEL: Record<InputKey, string> = {
  market_data: "Market prices", macro_data: "US economic data (FRED)",
  world: "World and geopolitics", us: "US economy and policy", markets: "Markets, sectors and catalysts", events: "Upcoming events", holdings: "Holdings: filings and research",
};
/** What each outlook cannot do without. */
export const REQUIRED: Record<"shortTerm" | "longTerm", InputKey[]> = {
  shortTerm: ["market_data", "markets", "events"],
  longTerm: ["macro_data", "us", "world"],
};

export function marketDataStatus(s: Snapshot | null): InputStatus {
  const n = s?.rows.length ?? 0, total = INSTRUMENTS.length;
  const level: Level = n >= total * 0.95 ? "complete" : n >= total * 0.7 ? "partial" : "unavailable";
  return { key: "market_data", label: LABEL.market_data, level, detail: `${n} of ${total} markets loaded`, reusedFrom: null };
}

export function macroDataStatus(s: Snapshot | null): InputStatus {
  const n = s?.macro.length ?? 0, total = MACRO.length;
  const level: Level = n >= total * 0.9 ? "complete" : n >= total * 0.5 ? "partial" : "unavailable";
  const reused = s?.macroSource?.kind === "reused" ? (s.macroSource.at ?? null) : null;
  return { key: "macro_data", label: LABEL.macro_data, level, detail: `${n} of ${total} series loaded`, reusedFrom: reused };
}

export function deskStatus(key: DeskKey, d: DeskResult | null, reusedFrom: string | null): InputStatus {
  if (!d) return { key, label: LABEL[key], level: "unavailable", detail: "did not finish", reusedFrom: null };
  if (d.status === "failed") return { key, label: LABEL[key], level: "unavailable", detail: `failed: ${d.error ?? "unknown error"}`, reusedFrom: null };
  if (key === "holdings") return { key, label: LABEL[key], level: d.problems.length ? "partial" : "complete", detail: `${d.items.length} items${d.problems.length ? `; ${d.problems.length} companies' filings unreadable` : ""}`, reusedFrom };
  const count = key === "events" ? d.calendar.length : d.items.length;
  if (!count) return { key, label: LABEL[key], level: "unavailable", detail: key === "events" ? "no sourced events found" : "no sourced items found", reusedFrom };
  const unsourced = d.items.filter((i) => i.unsourced).length;
  const notFound = d.items.filter((i) => i.check?.status === "not_found").length;
  const searchErrors = d.problems.filter((p) => /search failed|stopped searching/i.test(p)).length;
  const issues = [unsourced && `${unsourced} unsourced`, notFound && `${notFound} with figures not on the cited page`, searchErrors && `${searchErrors} search problems`].filter(Boolean) as string[];
  const what = key === "events" ? `${count} events` : `${count} items`;
  return { key, label: LABEL[key], level: issues.length ? "partial" : "complete", detail: issues.length ? `${what}; ${issues.join(", ")}` : what, reusedFrom };
}

function gate(required: InputKey[], inputs: InputStatus[]): OutlookGate {
  const by = new Map(inputs.map((i) => [i.key, i]));
  const missing = required.map((k) => by.get(k)!).filter((i) => i.level === "unavailable");
  const partial = required.map((k) => by.get(k)!).filter((i) => i.level === "partial");
  if (missing.length) return { status: "withheld", reasons: missing.map((i) => `${i.label}: ${i.detail}`) };
  if (partial.length) return { status: "partial", reasons: partial.map((i) => `${i.label}: ${i.detail}`) };
  return { status: "issued", reasons: [] };
}

export function computeCoverage(snapshot: Snapshot | null, desks: { key: DeskKey; result: DeskResult | null; reusedFrom: string | null }[]): Coverage {
  const inputs = [marketDataStatus(snapshot), macroDataStatus(snapshot), ...desks.map((d) => deskStatus(d.key, d.result, d.reusedFrom))];
  const all = desks.flatMap((d) => (d.result?.status === "failed" ? [] : d.result?.items ?? []));
  const cal = desks.flatMap((d) => (d.result?.status === "failed" ? [] : d.result?.calendar ?? []));
  const sources = all.flatMap((i) => i.sources);
  const checks = all.map((i) => i.check?.status).filter(Boolean);
  return {
    inputs,
    shortTerm: gate(REQUIRED.shortTerm, inputs),
    longTerm: gate(REQUIRED.longTerm, inputs),
    sources: {
      cited: sources.length, returnedBySearch: sources.filter((s) => s.checked).length,
      checkedOnPage: checks.filter((c) => c !== "not_checked").length,
      matched: checks.filter((c) => c === "matched").length, partial: checks.filter((c) => c === "partial").length,
      notFound: checks.filter((c) => c === "not_found").length, unreachable: checks.filter((c) => c === "unreachable").length,
    },
    calendar: { total: cal.length, confirmed: cal.filter((c) => c.status === "confirmed").length, estimated: cal.filter((c) => c.status === "estimated").length },
  };
}
