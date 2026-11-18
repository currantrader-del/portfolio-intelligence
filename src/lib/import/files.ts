import type { Doc, Inputs } from "./plan";

/** How each preserved file is recognised. Two RDDT archives share a name, so size tells them apart. */
export const RULES: { key: string; match: (name: string, size: number) => boolean; description: string; origin: Doc["origin"] }[] = [
  { key: "iren_archive", match: (n) => n.startsWith("IREN_FULL_RESEARCH_ARCHIVE"), description: "IREN full research archive", origin: "chatgpt_export" },
  { key: "rddt_a", match: (n, s) => n.startsWith("RDDT_FULL_RESEARCH_ARCHIVE") && s > 120_000, description: "RDDT archive, version A (phase 4 verbatim, 6 restated)", origin: "chatgpt_export" },
  { key: "rddt_b", match: (n, s) => n.startsWith("RDDT_FULL_RESEARCH_ARCHIVE") && s <= 120_000, description: "RDDT archive, version B (1-3 and 6 reconstructed)", origin: "chatgpt_export" },
  { key: "rddt_p4", match: (n) => /RDDT Phase 4|markdown ?\(?8\)?/i.test(n), description: "RDDT phase 4 checkpoint, pasted", origin: "chatgpt_paste" },
  { key: "rddt_p5", match: (n) => /RDDT Phase 5|markdown ?\(?9\)?/i.test(n), description: "RDDT phase 5 valuation, pasted", origin: "chatgpt_paste" },
  { key: "googl_md", match: (n) => /GOOGL Master Record|markdown ?\(?7\)?/i.test(n), description: "GOOGL master record, Sep 12, pasted", origin: "chatgpt_paste" },
  { key: "master", match: (n) => n === "MASTER_INVESTMENT_RESEARCH_AND_DECISIONS_2026.json", description: "Master research and decisions export", origin: "chatgpt_export" },
  { key: "watchlist", match: (n) => n === "WATCHLIST_SCREENING_COMPLETE_2026.json", description: "Watchlist screening export", origin: "chatgpt_export" },
  { key: "baseline", match: (n) => n === "PORTFOLIO_BASELINE_AND_RISK_POLICY.json", description: "Portfolio baseline and risk policy export", origin: "chatgpt_export" },
];

export type LoadedFile = { name: string; bytes: Uint8Array; sha256: string };

export function classify(files: LoadedFile[]): { docs: (Doc & { bytes: Uint8Array })[]; ignored: string[]; duplicates: string[] } {
  const docs: (Doc & { bytes: Uint8Array })[] = [];
  const ignored: string[] = [];
  const duplicates: string[] = [];
  for (const f of files) {
    const rule = RULES.find((r) => r.match(f.name, f.bytes.byteLength));
    if (!rule) { ignored.push(f.name); continue; }
    if (docs.some((d) => d.sha256 === f.sha256 || d.key === rule.key)) { duplicates.push(f.name); continue; }
    docs.push({ key: rule.key, fileName: f.name, sha256: f.sha256, byteSize: f.bytes.byteLength, origin: rule.origin, description: rule.description, bytes: f.bytes });
  }
  return { docs, ignored, duplicates };
}

export function toInputs(docs: (Doc & { bytes: Uint8Array })[]): Inputs {
  const dec = new TextDecoder();
  const text = (k: string) => { const d = docs.find((x) => x.key === k); return d ? dec.decode(d.bytes) : undefined; };
  const json = (k: string) => { const t = text(k); return t ? JSON.parse(t) : undefined; };
  return {
    docs: docs.map(({ bytes: _b, ...d }) => { void _b; return d; }),
    irenArchive: json("iren_archive"), rddtArchiveA: json("rddt_a"), rddtArchiveB: json("rddt_b"),
    rddtPhase4Md: text("rddt_p4"), rddtPhase5Md: text("rddt_p5"), googlMasterMd: text("googl_md"),
    master: json("master"), watchlist: json("watchlist"), baseline: json("baseline"),
  };
}
